import { LeafCursorImpl, type LeafAccess } from './leafcursor.mjs';
import type { LeafCursor, LeafNode } from './interfaces.mjs';
import type { InternalNodeImpl } from './internalnode.mjs';
import { NodeBaseImpl, type NodeDescriptor } from './nodebase.mjs';
import type { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import type { BlockInternalNode } from './internalnode.mjs';

type Entry<K, V> = { key: K; value: V };
type LeafDescriptor<K, V> = NodeDescriptor<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>>;
type BlockLeafDescriptor = NodeDescriptor<Buffer, Buffer, BlockLeafNode, BlockInternalNode>;

export class LeafNodeImpl<K, V>
  extends NodeBaseImpl<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>>
  implements LeafNode<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>>
{
  readonly isLeaf = true;

  private entries: Entry<K, V>[] = [];
  private nextLeafNode: LeafNodeImpl<K, V> | null = null;
  private previousLeafNode: LeafNodeImpl<K, V> | null = null;
  private readonly minOccupancy: number;

  constructor(compareKeys: (a: K, b: K) => number, maxEntries: number) {
    super(compareKeys, maxEntries);
    this.minOccupancy = Math.ceil(maxEntries / 2);
  }

  setNextLeaf(next: LeafNodeImpl<K, V> | null) {
    this.nextLeafNode = next;
  }

  setPreviousLeaf(previous: LeafNodeImpl<K, V> | null) {
    this.previousLeafNode = previous;
  }

  getCursorBeforeFirst(): LeafCursorImpl<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>> {
    return new LeafCursorImpl<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>>(this.createLeafAccess(), -1);
  }

  getCursorBeforeKey(
    key: K,
  ):
    | { cursor: LeafCursorImpl<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>>; isAtKey: boolean }
    | PromiseLike<{ cursor: LeafCursorImpl<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>>; isAtKey: boolean }> {
    const access = this.createLeafAccess();
    const index = this.findFirstGreaterOrEqualIndex(key);
    const cursor = new LeafCursorImpl(access, index - 1);
    const isAtKey = index < this.entries.length && this.compareKeys(this.entries[index].key, key) === 0;
    return { cursor, isAtKey };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getNextLeaf(): Promise<LeafNodeImpl<K, V> | null> {
    return this.nextLeafNode;
  }

  getEntryCount(): number {
    return this.entries.length;
  }

  getKeyValuePairAt(index: number): [K, V] {
    const entry = this.entries[index];
    if (!entry) {
      throw new Error('Key-value pair not found.');
    }
    return [entry.key, entry.value];
  }

  insertAt(index: number, key: K, value: V): void {
    this.entries.splice(index, 0, { key, value });
  }

  removeAt(index: number): void {
    this.entries.splice(index, 1);
  }

  updateAt(index: number, value: V): void {
    const entry = this.entries[index];
    if (!entry) {
      throw new Error('Entry not found.');
    }
    entry.value = value;
  }

  describe(): LeafDescriptor<K, V> {
    if (this.entries.length === 0) {
      return { nodes: [], keys: [] };
    }
    return {
      nodes: [this],
      keys: [this.entries[this.entries.length - 1].key],
    };
  }

  splitIfNeeded(): LeafDescriptor<K, V> {
    if (this.entries.length <= this.maxOccupancy) {
      return this.describe();
    }
    const midpoint = Math.ceil(this.entries.length / 2);
    const rightEntries = this.entries.splice(midpoint);
    const rightNode = new LeafNodeImpl<K, V>(this.compareKeys, this.maxOccupancy);
    rightNode.entries = rightEntries;
    rightNode.nextLeafNode = this.nextLeafNode;
    if (this.nextLeafNode) {
      this.nextLeafNode.previousLeafNode = rightNode;
    }
    rightNode.previousLeafNode = this;
    this.nextLeafNode = rightNode;
    return {
      nodes: [this, rightNode],
      keys: [this.entries[this.entries.length - 1].key, rightEntries[rightEntries.length - 1].key],
    };
  }

  protected getOccupancy(): number {
    return this.entries.length;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected async absorbNextNode(nextNode: LeafNodeImpl<K, V> | InternalNodeImpl<K, V>): Promise<void> {
    if (!(nextNode instanceof LeafNodeImpl)) {
      throw new Error('Leaf nodes can only absorb other leaf nodes.');
    }
    this.entries.push(...nextNode.entries);
    this.nextLeafNode = nextNode.nextLeafNode;
    if (this.nextLeafNode) {
      this.nextLeafNode.previousLeafNode = this;
    }
  }

  protected greatestKeyInternal(): K {
    const entry = this.entries[this.entries.length - 1];
    if (!entry) {
      throw new Error('Leaf node is empty.');
    }
    return entry.key;
  }

  protected smallestKeyInternal(): K {
    const entry = this.entries[0];
    if (!entry) {
      throw new Error('Leaf node is empty.');
    }
    return entry.key;
  }

  private findFirstGreaterOrEqualIndex(key: K): number {
    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.compareKeys(this.entries[mid].key, key) < 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  private createLeafAccess(): LeafAccess<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>> {
    return {
      leaf: this,
      getEntryCount: () => this.entries.length,
      getKeyValuePairAt: (index: number) => this.getKeyValuePairAt(index),
      insertAt: (index: number, key: K, value: V) => this.insertAt(index, key, value),
      removeAt: (index: number) => this.removeAt(index),
      updateAt: (index: number, value: V) => this.updateAt(index, value),
      splitIfNeeded: () => this.splitIfNeeded(),
    };
  }
}

// ============================================================================
// Block-based leaf node implementation (persistent storage)
// ============================================================================

// Block layout for leaf node:
// [0]: node type (1 byte, 0x00 = leaf)
// [1-4]: entry count (uint32 LE)
// [5-8]: next leaf block number (uint32 LE, 0 = none)
// [9+]: entries, each entry:
//   - key length (uint16 LE)
//   - key data
//   - value length (uint16 LE)
//   - value data

const LEAF_TYPE_BYTE = 0x00;
const LEAF_HEADER_SIZE = 9;

type BlockEntry = { key: Buffer; value: Buffer };

/**
 * Block-based leaf node that stores data in a FreeBlockFile.
 */
export class BlockLeafNode implements LeafNode<Buffer, Buffer, BlockLeafNode, BlockInternalNode> {
  readonly isLeaf = true as const;

  private entries: BlockEntry[] = [];
  private nextLeafBlock: number = 0;
  private dirty = false;

  constructor(
    private readonly file: FreeBlockFile,
    private readonly blockNumber: number,
    private readonly compareKeys: (a: Buffer, b: Buffer) => number,
    private readonly blockSize: number,
    private readonly allocateNode: () => Promise<BlockLeafNode>,
  ) {}

  getBlockNumber(): number {
    return this.blockNumber;
  }

  /**
   * Load node data from disk.
   */
  async load(): Promise<void> {
    const rawBuffer = await this.file.readBlock(this.blockNumber);
    // FreeBlockFile stores block type at byte 0, our data starts at byte 1
    const buffer = rawBuffer.subarray(1);
    this.entries = [];
    
    // Our layout: [0]: type, [1-4]: count, [5-8]: next
    const count = buffer.readUInt32LE(1);
    this.nextLeafBlock = buffer.readUInt32LE(5);
    
    let offset = LEAF_HEADER_SIZE;
    for (let i = 0; i < count; i++) {
      const keyLen = buffer.readUInt16LE(offset);
      offset += 2;
      const key = Buffer.from(buffer.subarray(offset, offset + keyLen));
      offset += keyLen;
      
      const valueLen = buffer.readUInt16LE(offset);
      offset += 2;
      const value = Buffer.from(buffer.subarray(offset, offset + valueLen));
      offset += valueLen;
      
      this.entries.push({ key, value });
    }
    this.dirty = false;
  }

  /**
   * Write node data to disk.
   */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    
    // FreeBlockFile expects blockSize - 1 bytes (it reserves 1 byte for block type)
    const buffer = Buffer.alloc(this.blockSize - 1);
    buffer.writeUInt8(LEAF_TYPE_BYTE, 0);
    buffer.writeUInt32LE(this.entries.length, 1);
    buffer.writeUInt32LE(this.nextLeafBlock, 5);
    
    let offset = LEAF_HEADER_SIZE;
    for (const entry of this.entries) {
      buffer.writeUInt16LE(entry.key.length, offset);
      offset += 2;
      entry.key.copy(buffer, offset);
      offset += entry.key.length;
      
      buffer.writeUInt16LE(entry.value.length, offset);
      offset += 2;
      entry.value.copy(buffer, offset);
      offset += entry.value.length;
    }
    
    await this.file.writeBlock(this.blockNumber, buffer);
    this.dirty = false;
  }

  /**
   * Initialize as empty leaf and write to disk.
   */
  async initEmpty(): Promise<void> {
    this.entries = [];
    this.nextLeafBlock = 0;
    this.dirty = true;
    await this.flush();
  }

  getCursorBeforeFirst(): LeafCursor<Buffer, Buffer, BlockLeafNode, BlockInternalNode> {
    return new LeafCursorImpl<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(this.createLeafAccess(), -1);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getCursorBeforeKey(
    key: Buffer,
  ): Promise<{ cursor: LeafCursor<Buffer, Buffer, BlockLeafNode, BlockInternalNode>; isAtKey: boolean }> {
    const access = this.createLeafAccess();
    const index = this.findFirstGreaterOrEqualIndex(key);
    const cursor = new LeafCursorImpl(access, index - 1);
    const isAtKey = index < this.entries.length && this.compareKeys(this.entries[index].key, key) === 0;
    return { cursor, isAtKey };
  }

  async getNextLeaf(): Promise<BlockLeafNode | null> {
    if (this.nextLeafBlock === 0) {
      return null;
    }
    const nextLeaf = new BlockLeafNode(
      this.file, 
      this.nextLeafBlock, 
      this.compareKeys, 
      this.blockSize, 
      this.allocateNode
    );
    await nextLeaf.load();
    return nextLeaf;
  }

  describe(): BlockLeafDescriptor {
    if (this.entries.length === 0) {
      return { nodes: [], keys: [] };
    }
    return {
      nodes: [this],
      keys: [this.entries[this.entries.length - 1].key],
    };
  }

  canMergeWithNext(_key: Buffer, nextNode: BlockLeafNode | BlockInternalNode): boolean {
    if (!(nextNode instanceof BlockLeafNode)) {
      return false;
    }
    const combinedSize = this.calculateSize(this.entries) + 
                         this.calculateSize(nextNode.entries) - 
                         LEAF_HEADER_SIZE;
    // FreeBlockFile reserves 1 byte for block type
    return combinedSize <= this.blockSize - 1;
  }

  async mergeWithNext(_key: Buffer, nextNode: BlockLeafNode | BlockInternalNode): Promise<void> {
    if (!(nextNode instanceof BlockLeafNode)) {
      throw new Error('Cannot merge leaf with non-leaf node');
    }
    this.entries.push(...nextNode.entries);
    this.nextLeafBlock = nextNode.nextLeafBlock;
    this.dirty = true;
    await this.flush();
    await this.file.freeBlock(nextNode.blockNumber);
  }

  getEntryCount(): number {
    return this.entries.length;
  }

  getKeyValuePairAt(index: number): [Buffer, Buffer] {
    const entry = this.entries[index];
    if (!entry) {
      throw new Error('Key-value pair not found.');
    }
    return [entry.key, entry.value];
  }

  insertAt(index: number, key: Buffer, value: Buffer): void {
    this.entries.splice(index, 0, { key, value });
    this.dirty = true;
  }

  removeAt(index: number): void {
    this.entries.splice(index, 1);
    this.dirty = true;
  }

  updateAt(index: number, value: Buffer): void {
    const entry = this.entries[index];
    if (!entry) {
      throw new Error('Entry not found.');
    }
    entry.value = value;
    this.dirty = true;
  }

  async splitIfNeeded(): Promise<BlockLeafDescriptor> {
    if (!this.needsSplit()) {
      await this.flush();
      return this.describe();
    }
    
    // Find split point
    const midpoint = Math.ceil(this.entries.length / 2);
    const rightEntries = this.entries.splice(midpoint);
    
    // Allocate new node for right half
    const rightNode = await this.allocateNode();
    rightNode.entries = rightEntries;
    rightNode.nextLeafBlock = this.nextLeafBlock;
    rightNode.dirty = true;
    
    // Update this node to point to right node
    this.nextLeafBlock = rightNode.blockNumber;
    this.dirty = true;
    
    // Write both nodes
    await this.flush();
    await rightNode.flush();
    
    return {
      nodes: [this, rightNode],
      keys: [this.entries[this.entries.length - 1].key, rightEntries[rightEntries.length - 1].key],
    };
  }

  private needsSplit(): boolean {
    // FreeBlockFile reserves 1 byte for block type
    return this.calculateSize(this.entries) > this.blockSize - 1;
  }

  private calculateSize(entries: BlockEntry[]): number {
    let size = LEAF_HEADER_SIZE;
    for (const entry of entries) {
      size += 2 + entry.key.length + 2 + entry.value.length;
    }
    return size;
  }

  private findFirstGreaterOrEqualIndex(key: Buffer): number {
    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.compareKeys(this.entries[mid].key, key) < 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  private createLeafAccess(): LeafAccess<Buffer, Buffer, BlockLeafNode, BlockInternalNode> {
    return {
      leaf: this,
      getEntryCount: () => this.entries.length,
      getKeyValuePairAt: (index: number) => this.getKeyValuePairAt(index),
      insertAt: (index: number, key: Buffer, value: Buffer) => this.insertAt(index, key, value),
      removeAt: (index: number) => this.removeAt(index),
      updateAt: (index: number, value: Buffer) => this.updateAt(index, value),
      splitIfNeeded: () => this.splitIfNeeded(),
      flush: () => this.flush(),
    };
  }

  /**
   * Copy content from another leaf node (used for stable root).
   */
  copyFrom(other: BlockLeafNode): void {
    this.entries = [...other.entries];
    this.nextLeafBlock = other.nextLeafBlock;
    this.dirty = true;
  }
}
