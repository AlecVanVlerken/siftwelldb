import type { NodeStorage } from './interfaces.mts';
import { InternalNodeImpl, BlockInternalNode } from './internalnode.mjs';
import { LeafNodeImpl, BlockLeafNode } from './leafnode.mjs';
import type { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';

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

  // eslint-disable-next-line @typescript-eslint/require-await
  async createTree(): Promise<LeafNodeImpl<K, V>> {
    return new LeafNodeImpl(this.compareKeys, this.maxLeafEntries);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async allocateInternalNode(
    nodes: (LeafNodeImpl<K, V> | InternalNodeImpl<K, V>)[],
    keys: K[],
  ): Promise<InternalNodeImpl<K, V>> {
    const node = new InternalNodeImpl(this.compareKeys, this.maxChildren);
    node.setChildren(nodes, keys);
    return node;
  }

  /**
   * For in-memory storage, finalizeRoot is a no-op.
   * Returns the root unchanged.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async finalizeRoot(
    root: LeafNodeImpl<K, V> | InternalNodeImpl<K, V>,
  ): Promise<LeafNodeImpl<K, V> | InternalNodeImpl<K, V>> {
    return root;
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

  // Cache for loaded nodes to avoid repeated disk reads
  private readonly nodeCache: Map<number, BlockLeafNode | BlockInternalNode> = new Map();

  constructor(
    private readonly file: FreeBlockFile,
    options: BlockNodeStorageOptions = {},
  ) {
    this.compareKeys = options.compareKeys ?? ((a, b) => Buffer.compare(a, b));
    this.blockSize = file._getBlockSize();
    // Register pre-commit hook so flushDirtyNodes() runs whenever file.commit() is called,
    // including in tests that invoke file.commit() directly (not via DbmsBack.commit()).
    file.addPreCommitHook(() => this.flushDirtyNodes());
  }

  getMaxKeySize(): number {
    // Reserve space for header and at least one entry
    return this.blockSize - 20;
  }

  /**
   * Create a new empty tree.
   * Returns the root node. The caller should store the root block number.
   */
  async createTree(): Promise<BlockLeafNode> {
    const blockNumber = await this.file.allocateBlock();
    const root = this.createLeafNode(blockNumber);
    await root.initEmpty();
    this.currentRoot = root;
    // Cache the newly created root
    this.nodeCache.set(blockNumber, root);
    return root;
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
    const blockNumber = await this.file.allocateBlock();
    const node = this.createInternalNode(blockNumber);
    await node.initWith(nodes, keys);
    // Cache the newly allocated node
    this.nodeCache.set(blockNumber, node);
    return node;
  }

  /**
   * For block storage with dynamic root, finalizeRoot is a no-op.
   * The root can be at any block - the caller tracks the root block number.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async finalizeRoot(root: BlockLeafNode | BlockInternalNode): Promise<BlockLeafNode | BlockInternalNode> {
    this.currentRoot = root;
    return root;
  }

  /**
   * Allocate a new leaf node.
   */
  async allocateLeafNode(): Promise<BlockLeafNode> {
    const blockNumber = await this.file.allocateBlock();
    const node = this.createLeafNode(blockNumber);
    await node.initEmpty();
    // Cache the newly allocated node
    this.nodeCache.set(blockNumber, node);
    return node;
  }

  /**
   * Load a node from disk by block number.
   */
  async loadNode(blockNumber: number): Promise<BlockLeafNode | BlockInternalNode> {
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
        const bn = await this.file.allocateBlock();
        return this.createInternalNode(bn);
      },
      (bn) => this.invalidateNode(bn),
    );
  }

  /**
   * Remove a node from the cache when it is freed (e.g., after merge).
   */
  private invalidateNode(blockNumber: number): void {
    this.nodeCache.delete(blockNumber);
  }

  /**
   * Flush all dirty B+tree nodes into the FBF dirty-block cache.
   * Must be called before FreeBlockFile.commit() so every in-memory mutation
   * is serialised to the dirty-block map before the WAL write begins.
   */
  async flushDirtyNodes(): Promise<void> {
    for (const node of this.nodeCache.values()) {
      await node.flush();
    }
  }
}
