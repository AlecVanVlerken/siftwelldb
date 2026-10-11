import type { NodeStorage } from './interfaces.mjs';
import { InternalNodeImpl, BlockInternalNode } from './internalnode.mjs';
import { LeafNodeImpl, BlockLeafNode } from './leafnode.mjs';
import type { FreeBlockFile } from '../../storage/blocks/freeblockfile.mjs';

export type NodeStorageOptions<K> = {
  compareKeys?: (a: K, b: K) => number;
  keySize?: (key: K) => number;
  maxLeafEntries?: number;
  maxChildren?: number;
  maxKeySize?: number;
};

/**
 * In-memory node storage implementation.
 * Used for testing and non-persistent B+ trees.
 */
export class NodeStorageImpl<K, V> implements NodeStorage<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>> {
  readonly compareKeys: (a: K, b: K) => number;
  readonly keySize: (key: K) => number;

  private readonly maxLeafEntries: number;
  private readonly maxChildren: number;
  private readonly maxKeySize: number;

  constructor(options: NodeStorageOptions<K>) {
    this.compareKeys =
      options.compareKeys ??
      ((a: K, b: K) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      });
    this.keySize = options.keySize ?? (() => 1);
    this.maxLeafEntries = options.maxLeafEntries ?? 8;
    this.maxChildren = options.maxChildren ?? 8;
    this.maxKeySize = options.maxKeySize ?? Number.MAX_SAFE_INTEGER;
  }

  getMaxKeySize(): number {
    return this.maxKeySize;
  }

  createTree(): Promise<LeafNodeImpl<K, V>> {
    return Promise.resolve(new LeafNodeImpl(this.compareKeys, this.maxLeafEntries));
  }

  allocateInternalNode(
    nodes: (LeafNodeImpl<K, V> | InternalNodeImpl<K, V>)[],
    keys: K[],
  ): Promise<InternalNodeImpl<K, V>> {
    const node = new InternalNodeImpl<K, V>(this.compareKeys, this.maxChildren);
    node.setChildren(nodes, keys);
    return Promise.resolve(node);
  }

  /**
   * For in-memory storage, finalizeRoot is a no-op.
   * Returns the root unchanged.
   */
  finalizeRoot(
    root: LeafNodeImpl<K, V> | InternalNodeImpl<K, V>,
  ): Promise<LeafNodeImpl<K, V> | InternalNodeImpl<K, V>> {
    return Promise.resolve(root);
  }
}

// ============================================================================
// Block-based node storage implementation (persistent storage)
// ============================================================================

// Node type markers in block storage
const BLOCK_NODE_TYPE_LEAF = 0x00;
const BLOCK_NODE_TYPE_INTERNAL = 0x01;

export type BlockNodeStorageOptions = {
  compareKeys?: (a: Buffer, b: Buffer) => number;
  /** A private index build can discard all owned nodes before publishing its root. */
  unpublished?: boolean;
};

export type BlockNodeKind = 'btree-leaf' | 'btree-internal';

export type BlockNodeRelocationResult = {
  kind: BlockNodeKind;
  oldBlockNumber: number;
  newBlockNumber: number;
  newRootBlock: number;
};

export type BlockNodeRelocationOptions = {
  maxBlockExclusive?: number;
};

export type BlockNodeLocation = {
  kind: BlockNodeKind;
  blockNumber: number;
};

/**
 * Block-based node storage implementation.
 * Stores B+ tree nodes in a FreeBlockFile with dynamic root.
 * The root block can change after splits/merges - the caller is responsible
 * for tracking the current root block number.
 */
export class BlockNodeStorage implements NodeStorage<Buffer, Buffer, BlockLeafNode, BlockInternalNode> {
  readonly compareKeys: (a: Buffer, b: Buffer) => number;
  readonly keySize: (key: Buffer) => number = (key) => key.length;

  private readonly blockSize: number;
  private currentRoot: BlockLeafNode | BlockInternalNode | null = null;
  private readonly preCommitHook: () => Promise<void>;
  private unpublished: boolean;
  private buildFailure: Error | undefined;
  private readonly ownedBlocks = new Set<number>();

  // Cache for loaded nodes to avoid repeated disk reads
  private readonly nodeCache: Map<number, BlockLeafNode | BlockInternalNode> = new Map();

  constructor(
    private readonly file: FreeBlockFile,
    options: BlockNodeStorageOptions = {},
  ) {
    this.compareKeys = options.compareKeys ?? ((a, b) => Buffer.compare(a, b));
    this.unpublished = options.unpublished ?? false;
    this.blockSize = file._getBlockSize();
    this.preCommitHook = () => this.flushDirtyNodes();
    // Register pre-commit hook so flushDirtyNodes() runs whenever file.commit() is called,
    // including in tests that invoke file.commit() directly (not via DbmsBack.commit()).
    file.addPreCommitHook(this.preCommitHook);
  }

  getMaxKeySize(): number {
    // Reserve space for header and at least one entry
    return this.blockSize - 20;
  }

  assertHealthy(): void {
    this.file.assertHealthy();
    if (this.buildFailure) throw this.buildFailure;
  }

  markMutationFailed(cause: unknown): void {
    if (this.unpublished) {
      this.buildFailure ??= new Error('Unpublished B+ tree construction failed; discard it before continuing.', {
        cause,
      });
    } else {
      this.file.markMutationFailed(cause);
    }
  }

  /** Enable ordinary failure protection only after the private build has completed. */
  publish(): void {
    this.assertHealthy();
    this.unpublished = false;
    this.ownedBlocks.clear();
  }

  private async allocateNodeBlock(): Promise<number> {
    this.assertHealthy();
    this.file._ensureOpen();
    try {
      const blockNumber = await this.file.allocateBlock();
      if (this.unpublished) this.ownedBlocks.add(blockNumber);
      return blockNumber;
    } catch (error) {
      // A failed allocator may have staged a block whose number was never returned.
      this.file.markMutationFailed(error);
      throw error;
    }
  }

  /**
   * Create a new empty tree.
   * Returns the root node. The caller should store the root block number.
   */
  async createTree(): Promise<BlockLeafNode> {
    this.file._ensureOpen();
    try {
      const blockNumber = await this.allocateNodeBlock();
      const root = this.createLeafNode(blockNumber);
      this.nodeCache.set(blockNumber, root);
      await root.initEmpty();
      this.currentRoot = root;
      return root;
    } catch (error) {
      this.markMutationFailed(error);
      throw error;
    }
  }

  /**
   * Open an existing tree from its root block.
   */
  async openTree(rootBlock: number): Promise<BlockLeafNode | BlockInternalNode> {
    const root = await this.loadNode(rootBlock);
    this.currentRoot = root;
    return root;
  }

  async allocateInternalNode(nodes: (BlockLeafNode | BlockInternalNode)[], keys: Buffer[]): Promise<BlockInternalNode> {
    const blockNumber = await this.allocateNodeBlock();
    const node = this.createInternalNode(blockNumber);
    this.nodeCache.set(blockNumber, node);
    await node.initWith(nodes, keys);
    return node;
  }

  /**
   * For block storage with dynamic root, finalizeRoot is a no-op.
   * The root can be at any block - the caller tracks the root block number.
   */
  finalizeRoot(root: BlockLeafNode | BlockInternalNode): Promise<BlockLeafNode | BlockInternalNode> {
    this.currentRoot = root;
    return Promise.resolve(root);
  }

  async releaseRoot(root: BlockLeafNode | BlockInternalNode): Promise<void> {
    const blockNumber = root.getBlockNumber();
    try {
      await this.file.freeBlock(blockNumber);
    } catch (error) {
      this.file.markMutationFailed(error);
      throw error;
    }
    this.invalidateNode(blockNumber);
    if (this.currentRoot?.getBlockNumber() === blockNumber) {
      this.currentRoot = null;
    }
  }

  /**
   * Allocate a new leaf node.
   */
  async allocateLeafNode(): Promise<BlockLeafNode> {
    const blockNumber = await this.allocateNodeBlock();
    const node = this.createLeafNode(blockNumber);
    this.nodeCache.set(blockNumber, node);
    await node.initEmpty();
    return node;
  }

  /**
   * Relocate one live B+ tree node to a fresh block.
   *
   * This deliberately uses root-based reference discovery instead of persistent
   * parent pointers. Parent pointers would be a broader on-disk format change;
   * this primitive keeps Stage 3 targeted and format-compatible.
   */
  async relocateNode(
    rootBlock: number,
    blockNumber: number,
    options: BlockNodeRelocationOptions = {},
  ): Promise<BlockNodeRelocationResult> {
    if (this.unpublished) throw new Error('Unpublished B+ trees must be published before relocation.');
    await this.openTree(rootBlock);
    const oldNode = await this.loadNode(blockNumber);
    const kind: BlockNodeKind = oldNode.isLeaf ? 'btree-leaf' : 'btree-internal';
    const newNode = oldNode.isLeaf
      ? await this.copyLeafToFreshBlock(oldNode, options)
      : await this.copyInternalToFreshBlock(oldNode, options);
    const newBlockNumber = newNode.getBlockNumber();
    let newRootBlock = rootBlock;

    if (rootBlock === blockNumber) {
      newRootBlock = newBlockNumber;
      this.currentRoot = newNode;
    } else {
      const parent = await this.findParentNode(rootBlock, blockNumber);
      if (!parent) {
        throw new Error(`Could not find B+ tree parent for block ${blockNumber}`);
      }
      if (!parent.replaceChildBlockNumber(blockNumber, newBlockNumber, newNode)) {
        throw new Error(`Failed to update B+ tree parent for block ${blockNumber}`);
      }
    }

    if (oldNode.isLeaf) {
      const previousLeaf = await this.findLeafPointingTo(rootBlock, blockNumber);
      if (previousLeaf) {
        previousLeaf.setNextLeafBlockNumber(newBlockNumber);
      }
    }

    this.invalidateNode(blockNumber);
    await this.file.freeBlock(blockNumber);

    return {
      kind,
      oldBlockNumber: blockNumber,
      newBlockNumber,
      newRootBlock,
    };
  }

  /**
   * List reachable node blocks from a root. This is intentionally small and is
   * useful both for relocation tests and future incremental target selection.
   */
  async listNodeBlocks(rootBlock: number): Promise<BlockNodeLocation[]> {
    const root = await this.loadNode(rootBlock);
    const result: BlockNodeLocation[] = [];
    await this.collectNodeBlocks(root, result);
    return result;
  }

  /**
   * Load a node from disk by block number.
   */
  async loadNode(blockNumber: number): Promise<BlockLeafNode | BlockInternalNode> {
    this.assertHealthy();
    if (this.unpublished && !this.ownedBlocks.has(blockNumber)) {
      throw new Error('Unpublished B+ trees cannot load nodes belonging to existing trees.');
    }
    // Check cache first
    const cached = this.nodeCache.get(blockNumber);
    if (cached) {
      return cached;
    }

    const rawBuffer = await this.file.readBlock(blockNumber);
    // FreeBlockFile stores block type at byte 0, our data starts at byte 1
    const nodeType = rawBuffer.readUInt8(1);

    let node: BlockLeafNode | BlockInternalNode;
    if (nodeType === BLOCK_NODE_TYPE_LEAF) {
      node = this.createLeafNode(blockNumber);
      await node.load(rawBuffer); // reuse already-read buffer, avoids a second readBlock
    } else if (nodeType === BLOCK_NODE_TYPE_INTERNAL) {
      node = this.createInternalNode(blockNumber);
      await node.load(rawBuffer);
    } else {
      throw new Error(`Unknown node type: ${nodeType}`);
    }

    // Cache the loaded node
    this.nodeCache.set(blockNumber, node);
    return node;
  }

  private createLeafNode(blockNumber: number): BlockLeafNode {
    return new BlockLeafNode(
      this.file,
      blockNumber,
      this.compareKeys,
      this.blockSize,
      () => this.allocateLeafNode(),
      (bn) => this.loadNode(bn),
      (bn) => this.invalidateNode(bn),
    );
  }

  private createInternalNode(blockNumber: number): BlockInternalNode {
    return new BlockInternalNode(
      this.file,
      blockNumber,
      this.compareKeys,
      this.blockSize,
      (bn) => this.loadNode(bn),
      async () => {
        const bn = await this.allocateNodeBlock();
        const node = this.createInternalNode(bn);
        this.nodeCache.set(bn, node);
        return node;
      },
      (bn) => this.invalidateNode(bn),
    );
  }

  /**
   * Remove a node from the cache when it is freed (e.g., after merge).
   */
  private invalidateNode(blockNumber: number): void {
    this.ownedBlocks.delete(blockNumber);
    this.nodeCache.delete(blockNumber);
  }

  private async copyLeafToFreshBlock(
    source: BlockLeafNode,
    options: BlockNodeRelocationOptions,
  ): Promise<BlockLeafNode> {
    const node =
      options.maxBlockExclusive === undefined
        ? await this.allocateLeafNode()
        : await this.allocateLeafNodeBelow(options.maxBlockExclusive);
    node.initFromSnapshot(source.exportSnapshot());
    return node;
  }

  private async copyInternalToFreshBlock(
    source: BlockInternalNode,
    options: BlockNodeRelocationOptions,
  ): Promise<BlockInternalNode> {
    const blockNumber =
      options.maxBlockExclusive === undefined
        ? await this.file.allocateBlock()
        : await this.allocateBlockBelow(options.maxBlockExclusive);
    const node = this.createInternalNode(blockNumber);
    node.initFromSnapshot(source.exportSnapshot());
    this.nodeCache.set(blockNumber, node);
    return node;
  }

  private async allocateLeafNodeBelow(maxBlockExclusive: number): Promise<BlockLeafNode> {
    const blockNumber = await this.allocateBlockBelow(maxBlockExclusive);
    const node = this.createLeafNode(blockNumber);
    await node.initEmpty();
    this.nodeCache.set(blockNumber, node);
    return node;
  }

  private async allocateBlockBelow(maxBlockExclusive: number): Promise<number> {
    const blockNumber = await this.file.allocateBlockBelow(maxBlockExclusive);
    if (blockNumber === null) {
      throw new Error(`No free B+ tree relocation block below ${maxBlockExclusive.toString()}`);
    }
    return blockNumber;
  }

  private async findParentNode(rootBlock: number, targetBlock: number): Promise<BlockInternalNode | null> {
    const root = await this.loadNode(rootBlock);
    return await this.findParentNodeInSubtree(root, targetBlock);
  }

  private async findParentNodeInSubtree(
    node: BlockLeafNode | BlockInternalNode,
    targetBlock: number,
  ): Promise<BlockInternalNode | null> {
    if (node.isLeaf) {
      return null;
    }

    if (node.getChildBlockNumbers().includes(targetBlock)) {
      return node;
    }

    for (const childBlock of node.getChildBlockNumbers()) {
      const child = await this.loadNode(childBlock);
      const found = await this.findParentNodeInSubtree(child, targetBlock);
      if (found) {
        return found;
      }
    }

    return null;
  }

  private async findLeafPointingTo(rootBlock: number, targetBlock: number): Promise<BlockLeafNode | null> {
    const root = await this.loadNode(rootBlock);
    const leaves: BlockLeafNode[] = [];
    await this.collectLeaves(root, leaves);
    return leaves.find((leaf) => leaf.getNextLeafBlockNumber() === targetBlock) ?? null;
  }

  private async collectNodeBlocks(node: BlockLeafNode | BlockInternalNode, result: BlockNodeLocation[]): Promise<void> {
    result.push({
      kind: node.isLeaf ? 'btree-leaf' : 'btree-internal',
      blockNumber: node.getBlockNumber(),
    });

    if (node.isLeaf) {
      return;
    }

    for (const childBlock of node.getChildBlockNumbers()) {
      await this.collectNodeBlocks(await this.loadNode(childBlock), result);
    }
  }

  private async collectLeaves(node: BlockLeafNode | BlockInternalNode, result: BlockLeafNode[]): Promise<void> {
    if (node.isLeaf) {
      result.push(node);
      return;
    }

    for (const childBlock of node.getChildBlockNumbers()) {
      await this.collectLeaves(await this.loadNode(childBlock), result);
    }
  }

  /**
   * Flush all dirty B+tree nodes into the FBF dirty-block cache.
   * Must be called before FreeBlockFile.commit() so every in-memory mutation
   * is serialised to the dirty-block map before the WAL write begins.
   */
  async flushDirtyNodes(): Promise<void> {
    this.assertHealthy();
    for (const node of this.nodeCache.values()) {
      await node.flush();
    }
  }

  dispose(): void {
    // A failed private build must be discarded completely before detaching its commit hook.
    if (this.buildFailure || (this.unpublished && this.ownedBlocks.size > 0)) {
      this.file.markMutationFailed(
        this.buildFailure ?? new Error('Unpublished B+ tree disposed without discarding its allocated blocks.'),
      );
    }
    this.nodeCache.clear();
    this.ownedBlocks.clear();
    this.currentRoot = null;
    this.file.removePreCommitHook(this.preCommitHook);
  }

  /** Discard a newly built, unpublished tree, including nodes not yet linked after a failed split. */
  async discardNewTree(): Promise<void> {
    if (!this.unpublished) throw new Error('Only unpublished B+ trees can be discarded.');
    this.file.assertHealthy();
    try {
      for (const block of this.ownedBlocks) {
        await this.file.freeBlock(block);
        this.ownedBlocks.delete(block);
      }
    } catch (error) {
      this.file.markMutationFailed(error);
      throw error;
    }
    this.buildFailure = undefined;
    this.dispose();
  }
}
