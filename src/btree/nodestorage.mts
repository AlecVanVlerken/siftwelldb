import type { NodeStorage } from './interfaces.mts';
import { InternalNodeImpl, BlockInternalNode } from './internalnode.mjs';
import { LeafNodeImpl, BlockLeafNode } from './leafnode.mjs';
import type { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';

// Interface to help TypeScript resolve the method type correctly
interface HasRelocateChildFromBlock {
  relocateChildFromBlock(
    blockNumber: number,
    allocateLeafNode: () => Promise<BlockLeafNode>,
    allocateInternalNodeBlock?: () => Promise<number>,
  ): Promise<void>;
  getBlockNumber(): number;
  copyFrom(other: unknown): void;
  flush(): Promise<void>;
}

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
 * Stores B+ tree nodes in a FreeBlockFile with stable root block.
 */
export class BlockNodeStorage implements NodeStorage<Buffer, Buffer, BlockLeafNode, BlockInternalNode> {
  readonly compareKeys: (a: Buffer, b: Buffer) => number;
  readonly keySize: (key: Buffer) => number = (key) => key.length;

  private readonly blockSize: number;
  private stableRootBlock: number = 0;
  private currentRoot: BlockLeafNode | BlockInternalNode | null = null;

  // Cache for loaded nodes to avoid repeated disk reads
  private readonly nodeCache: Map<number, BlockLeafNode | BlockInternalNode> = new Map();

  constructor(
    private readonly file: FreeBlockFile,
    options: BlockNodeStorageOptions = {},
  ) {
    this.compareKeys = options.compareKeys ?? ((a, b) => Buffer.compare(a, b));
    this.blockSize = file._getBlockSize();
  }

  getMaxKeySize(): number {
    // Reserve space for header and at least one entry
    return this.blockSize - 20;
  }

  /**
   * Get the stable root block number.
   * This number never changes after tree creation.
   */
  getStableRootBlock(): number {
    return this.stableRootBlock;
  }

  /**
   * Create a new empty tree.
   * Allocates a stable root block.
   */
  async createTree(): Promise<BlockLeafNode> {
    this.stableRootBlock = await this.file.allocateBlock();
    const root = this.createLeafNode(this.stableRootBlock);
    await root.initEmpty();
    this.currentRoot = root;
    // Cache the newly created root
    this.nodeCache.set(this.stableRootBlock, root);
    return root;
  }

  /**
   * Open an existing tree from its stable root block.
   */
  async openTree(stableRootBlock: number): Promise<BlockLeafNode | BlockInternalNode> {
    this.stableRootBlock = stableRootBlock;
    const root = await this.loadNode(stableRootBlock);
    this.currentRoot = root;
    // Cache the opened root
    this.nodeCache.set(stableRootBlock, root);
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
   * Ensures root is in the stable root block.
   * If root has moved (due to split), copies content to stable block.
   *
   * IMPORTANT: When the root is an internal node, we must check if any of its
   * children point to the stable root block. If so, we must move that child
   * to a new block first to avoid circular references.
   */
  async finalizeRoot(root: BlockLeafNode | BlockInternalNode): Promise<BlockLeafNode | BlockInternalNode> {
    const rootBlockNumber = root instanceof BlockInternalNode ? root.getBlockNumber() : root.getBlockNumber();

    if (rootBlockNumber === this.stableRootBlock) {
      // Root is already in stable block
      this.currentRoot = root;
      // Update cache with current root
      this.nodeCache.set(this.stableRootBlock, root);
      return root;
    }

    // Root has moved - copy content to stable block
    if (root instanceof BlockLeafNode) {
      const stableRoot = this.createLeafNode(this.stableRootBlock);
      stableRoot.copyFrom(root);
      await stableRoot.flush();
      // Invalidate the old block from cache and cache the new stable root
      this.nodeCache.delete(root.getBlockNumber());
      this.nodeCache.set(this.stableRootBlock, stableRoot);
      await this.file.freeBlock(root.getBlockNumber());
      this.currentRoot = stableRoot;
      return stableRoot;
    }

    // For internal nodes, we must check if any child points to the stable root block.
    // This can happen when a leaf at the stable root splits and becomes an internal node.
    // If we copy the internal node to stable root without moving the child that points
    // to stable root, we create a circular reference.
    const internalRoot = root;
    await this.relocateChildFromStableRoot(internalRoot);

    const stableRoot = this.createInternalNode(this.stableRootBlock);
    stableRoot.copyFrom(internalRoot);
    await stableRoot.flush();
    // Invalidate the old block from cache and cache the new stable root
    this.nodeCache.delete(internalRoot.getBlockNumber());
    this.nodeCache.set(this.stableRootBlock, stableRoot);
    await this.file.freeBlock(internalRoot.getBlockNumber());
    this.currentRoot = stableRoot;
    return stableRoot;
  }

  /**
   * Helper to relocate any child that points to the stable root block.
   */
  private async relocateChildFromStableRoot(node: HasRelocateChildFromBlock): Promise<void> {
    await node.relocateChildFromBlock(
      this.stableRootBlock,
      () => this.allocateLeafNode(),
      async () => this.file.allocateBlock(),
    );
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
      await node.load();
    } else if (nodeType === BLOCK_NODE_TYPE_INTERNAL) {
      node = this.createInternalNode(blockNumber);
      await node.load();
    } else {
      throw new Error(`Unknown node type: ${nodeType}`);
    }

    // Cache the loaded node
    this.nodeCache.set(blockNumber, node);
    return node;
  }

  private createLeafNode(blockNumber: number): BlockLeafNode {
    return new BlockLeafNode(this.file, blockNumber, this.compareKeys, this.blockSize, () => this.allocateLeafNode());
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
      this.stableRootBlock,
    );
  }
}
