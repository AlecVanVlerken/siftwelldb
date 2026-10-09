import type { ChildCursor, InternalNode } from './interfaces.mjs';
import { NodeBaseImpl, type NodeDescriptor } from './nodebase.mjs';
import { ChildCursorImpl, type ChildAccess } from './childcursor.mjs';
import type { BlockLeafNode, LeafNodeImpl } from './leafnode.mjs';
import type { FreeBlockFile } from '../../storage/blocks/freeblockfile.mjs';

type BlockInternalDescriptor = NodeDescriptor<Buffer, Buffer, BlockLeafNode, BlockInternalNode>;

export class InternalNodeImpl<K, V>
  extends NodeBaseImpl<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>>
  implements InternalNode<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>>
{
  readonly isLeaf = false;

  private children: (LeafNodeImpl<K, V> | InternalNodeImpl<K, V>)[] = [];
  private keys: K[] = [];
  private readonly minChildren: number;

  constructor(compareKeys: (a: K, b: K) => number, maxChildren: number) {
    super(compareKeys, maxChildren);
    this.minChildren = Math.max(2, Math.ceil(maxChildren / 2));
  }

  initialize(children: (LeafNodeImpl<K, V> | InternalNodeImpl<K, V>)[], keys: K[]) {
    if (children.length !== keys.length) {
      throw new Error('Children and key arrays must be of equal length.');
    }
    this.children = [...children];
    this.keys = [...keys];
  }

  getChildCursorAtFirstChild(): ChildCursor<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>> {
    return new ChildCursorImpl(this.createAccess(), 0);
  }

  getChildCursorAtKey(key: K): ChildCursor<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>> {
    const index = this.findChildIndex(key);
    return new ChildCursorImpl(this.createAccess(), index);
  }

  describe(): NodeDescriptor<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>> {
    if (this.children.length === 0) {
      return { nodes: [], keys: [] };
    }
    return { nodes: [this], keys: [this.keys[this.keys.length - 1]] };
  }

  setChildren(newChildren: (LeafNodeImpl<K, V> | InternalNodeImpl<K, V>)[], newKeys: K[]) {
    if (newChildren.length !== newKeys.length) {
      throw new Error('Every child requires a corresponding key.');
    }
    this.children = [...newChildren];
    this.keys = [...newKeys];
  }

  childCount(): number {
    return this.children.length;
  }

  getChildAt(index: number): LeafNodeImpl<K, V> | InternalNodeImpl<K, V> {
    const child = this.children[index];
    if (!child) {
      throw new Error('Child index out of range.');
    }
    return child;
  }

  getKeyAt(index: number): K {
    const key = this.keys[index];
    if (key === undefined) {
      throw new Error('Key index out of range.');
    }
    return key;
  }

  isUnderfull(): boolean {
    return this.children.length < this.minChildren && this.children.length > 0;
  }

  deallocateUnderfull(): Promise<LeafNodeImpl<K, V> | InternalNodeImpl<K, V>> {
    if (this.children.length !== 1) {
      throw new Error('Internal node can only be deallocated when it has exactly one child.');
    }
    return Promise.resolve(this.children[0]);
  }

  moveLastChildTo(_separatorKey: K, nextNode: InternalNodeImpl<K, V>): Promise<K> {
    const child = this.children.pop();
    const key = this.keys.pop();
    if (!child || key === undefined) {
      throw new Error('Internal node has no child to move.');
    }
    nextNode.prependChild(child, key);
    return Promise.resolve(this.getKeyAt(this.keys.length - 1));
  }

  moveFirstChildTo(previousNode: InternalNodeImpl<K, V>, _separatorKey: K): Promise<K> {
    if (this.children.length === 0) {
      throw new Error('Internal node has no child to move.');
    }
    const child = this.children.shift()!;
    const key = this.keys.shift();
    previousNode.appendChild(child, key ?? previousNode.keys[previousNode.keys.length - 1]);
    return Promise.resolve(this.keys[this.keys.length - 1] ?? previousNode.keys[previousNode.keys.length - 1]);
  }

  replaceChildren(
    startIndex: number,
    count: number,
    newChildren: (LeafNodeImpl<K, V> | InternalNodeImpl<K, V>)[],
    newKeys: K[],
  ): void {
    if (newChildren.length !== newKeys.length) {
      throw new Error('Replacement children and keys must match in length.');
    }
    this.children.splice(startIndex, count, ...newChildren);
    this.keys.splice(startIndex, count, ...newKeys);
  }

  splitIfNeeded(): NodeDescriptor<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>> {
    if (this.children.length === 0) {
      return { nodes: [], keys: [] };
    }
    if (this.children.length <= this.maxOccupancy) {
      return this.describe();
    }
    const midpoint = Math.ceil(this.children.length / 2);
    const rightChildren = this.children.splice(midpoint);
    const rightKeys = this.keys.splice(midpoint);
    const rightNode = new InternalNodeImpl<K, V>(this.compareKeys, this.maxOccupancy);
    rightNode.setChildren(rightChildren, rightKeys);
    return {
      nodes: [this, rightNode],
      keys: [this.keys[this.keys.length - 1], rightKeys[rightKeys.length - 1]],
    };
  }

  protected getOccupancy(): number {
    return this.children.length;
  }

  protected absorbNextNode(nextNode: LeafNodeImpl<K, V> | InternalNodeImpl<K, V>): Promise<void> {
    if (!(nextNode instanceof InternalNodeImpl)) {
      throw new Error('Internal nodes can only absorb other internal nodes.');
    }
    this.children.push(...nextNode.children);
    this.keys.push(...nextNode.keys);
    return Promise.resolve();
  }

  protected greatestKeyInternal(): K {
    if (this.keys.length === 0) {
      throw new Error('Internal node is empty.');
    }
    return this.getKeyAt(this.keys.length - 1);
  }

  protected smallestKeyInternal(): K {
    if (this.keys.length === 0) {
      throw new Error('Internal node is empty.');
    }
    return this.getKeyAt(0);
  }

  private prependChild(child: LeafNodeImpl<K, V> | InternalNodeImpl<K, V>, key: K) {
    this.children.unshift(child);
    this.keys.unshift(key);
  }

  private appendChild(child: LeafNodeImpl<K, V> | InternalNodeImpl<K, V>, key: K) {
    this.children.push(child);
    this.keys.push(key);
  }

  private findChildIndex(key: K): number {
    let low = 0;
    let high = this.keys.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.compareKeys(key, this.keys[mid]) <= 0) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    return Math.min(low, Math.max(0, this.keys.length - 1));
  }

  private createAccess(): ChildAccess<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>> {
    return {
      node: this,
      getChildCount: () => this.children.length,
      getChildAt: (index: number) => this.getChildAt(index),
      getKeyAt: (index: number) => this.getKeyAt(index),
      replaceChildren: (
        start: number,
        count: number,
        replacementKeys: K[],
        replacementChildren: (LeafNodeImpl<K, V> | InternalNodeImpl<K, V>)[],
      ) => this.replaceChildren(start, count, replacementChildren, replacementKeys),
      splitIfNeeded: () => this.splitIfNeeded(),
      describe: () => this.describe(),
    };
  }
}

// ============================================================================
// Block-based internal node implementation (persistent storage)
// ============================================================================

// Block layout for internal node:
// [0]: node type (1 byte, 0x01 = internal)
// [1-4]: child count (uint32 LE)
// [5+]: children, each child:
//   - child block number (uint32 LE)
//   - key length (uint16 LE)
//   - key data (max key in child's subtree)

const INTERNAL_TYPE_BYTE = 0x01;
const INTERNAL_HEADER_SIZE = 5;

type BlockChild = { blockNumber: number; key: Buffer };

export type BlockInternalNodeSnapshot = {
  children: BlockChild[];
  loadedChildren: Array<[number, BlockLeafNode | BlockInternalNode]>;
};

/**
 * Block-based internal node that stores data in a FreeBlockFile.
 */
export class BlockInternalNode implements InternalNode<Buffer, Buffer, BlockLeafNode, BlockInternalNode> {
  readonly isLeaf = false as const;

  private children: BlockChild[] = [];
  private dirty = false;
  private childrenLoaded: Map<number, BlockLeafNode | BlockInternalNode> = new Map();
  /** Incrementally maintained serialized size. Avoids O(n) scans in needsSplit / canMergeWithNext. */
  private currentSize: number = INTERNAL_HEADER_SIZE;
  /**
   * Pre-created access object — avoids allocating a new object + closures on every B+tree
   * traversal. No flush callback: flushing is deferred to flushDirtyNodes() at commit time.
   */
  private _childAccess: ChildAccess<Buffer, Buffer, BlockLeafNode, BlockInternalNode>;
  /**
   * Persistent raw block buffer reused across commit cycles (same semantics as BlockLeafNode._rawBuffer).
   */
  private _rawBuffer: Buffer | undefined = undefined;

  constructor(
    private readonly file: FreeBlockFile,
    private readonly blockNumber: number,
    private readonly compareKeys: (a: Buffer, b: Buffer) => number,
    private readonly blockSize: number,
    private readonly loadNode: (blockNumber: number) => Promise<BlockLeafNode | BlockInternalNode>,
    private readonly allocateInternalNode: () => Promise<BlockInternalNode>,
    private readonly onNodeFreed?: (blockNumber: number) => void,
  ) {
    this._childAccess = {
      node: this,
      getChildCount: () => this.children.length,
      getChildAt: (index: number) => this.getChildAt(index),
      getKeyAt: (index: number) => this.getKeyAt(index),
      replaceChildren: (
        start: number,
        count: number,
        replacementKeys: Buffer[],
        replacementChildren: (BlockLeafNode | BlockInternalNode)[],
      ) => this.replaceChildren(start, count, replacementChildren, replacementKeys),
      splitIfNeeded: () => this.splitIfNeeded(),
      describe: () => this.describe(),
    };
  }

  getBlockNumber(): number {
    return this.blockNumber;
  }

  getChildBlockNumbers(): number[] {
    return this.children.map((child) => child.blockNumber);
  }

  replaceChildBlockNumber(
    oldBlockNumber: number,
    newBlockNumber: number,
    loadedNode?: BlockLeafNode | BlockInternalNode,
  ): boolean {
    const child = this.children.find((candidate) => candidate.blockNumber === oldBlockNumber);
    if (!child) {
      return false;
    }

    const cached = this.childrenLoaded.get(oldBlockNumber);
    this.childrenLoaded.delete(oldBlockNumber);
    child.blockNumber = newBlockNumber;
    if (loadedNode) {
      this.childrenLoaded.set(newBlockNumber, loadedNode);
    } else if (cached) {
      this.childrenLoaded.set(newBlockNumber, cached);
    }
    this.dirty = true;
    return true;
  }

  exportSnapshot(): BlockInternalNodeSnapshot {
    return {
      children: this.children.map((child) => ({
        blockNumber: child.blockNumber,
        key: Buffer.from(child.key),
      })),
      loadedChildren: [...this.childrenLoaded.entries()],
    };
  }

  initFromSnapshot(snapshot: BlockInternalNodeSnapshot): void {
    this.children = snapshot.children.map((child) => ({
      blockNumber: child.blockNumber,
      key: Buffer.from(child.key),
    }));
    this.childrenLoaded.clear();
    for (const [blockNumber, child] of snapshot.loadedChildren) {
      this.childrenLoaded.set(blockNumber, child);
    }
    this.currentSize = this.calculateSize(this.children);
    this.dirty = true;
  }

  /**
   * Load node data from disk.
   */
  async load(rawBuffer?: Buffer): Promise<void> {
    const buf = rawBuffer ?? (await this.file.readBlock(this.blockNumber));
    // FreeBlockFile stores block type at byte 0, our data starts at byte 1
    const buffer = buf.subarray(1);
    this.children = [];
    this.childrenLoaded.clear();

    // Our layout: [0]: type, [1-4]: count
    const count = buffer.readUInt32LE(1);

    let offset = INTERNAL_HEADER_SIZE;
    for (let i = 0; i < count; i++) {
      const childBlock = buffer.readUInt32LE(offset);
      offset += 4;

      const keyLen = buffer.readUInt16LE(offset);
      offset += 2;
      const key = Buffer.from(buffer.subarray(offset, offset + keyLen));
      offset += keyLen;

      this.children.push({ blockNumber: childBlock, key });
    }
    this.currentSize = INTERNAL_HEADER_SIZE;
    for (const c of this.children) this.currentSize += 4 + 2 + c.key.length;
    this.dirty = false;
  }

  /**
   * Serialise children directly into the FBF dirty block (zero-copy: no data.copy via writeBlock).
   * Deferred: only called at commit time via BlockNodeStorage.flushDirtyNodes().
   */
  async flush(): Promise<void> {
    if (!this.dirty) return;

    // Obtain raw block buffer: prefer existing dirty entry,
    // fall back to cached own buffer, then allocate once from disk.
    let rawBlock = this.file._getDirtyBlock(this.blockNumber);
    if (rawBlock !== undefined) {
      this._rawBuffer = rawBlock;
    } else if (this._rawBuffer !== undefined) {
      this.file._setDirtyBlock(this.blockNumber, this._rawBuffer);
      rawBlock = this._rawBuffer;
    } else {
      rawBlock = await this.file.readBlock(this.blockNumber);
      this._rawBuffer = rawBlock;
      this.file._setDirtyBlock(this.blockNumber, rawBlock);
    }
    const buffer = rawBlock.subarray(1);
    buffer.writeUInt8(INTERNAL_TYPE_BYTE, 0);
    buffer.writeUInt32LE(this.children.length, 1);

    let offset = INTERNAL_HEADER_SIZE;
    for (const child of this.children) {
      buffer.writeUInt32LE(child.blockNumber, offset);
      offset += 4;

      buffer.writeUInt16LE(child.key.length, offset);
      offset += 2;
      child.key.copy(buffer, offset);
      offset += child.key.length;
    }
    this.dirty = false;
  }

  /**
   * Initialize with children. Flush is deferred to flushDirtyNodes() at commit time.
   */
  initWith(children: (BlockLeafNode | BlockInternalNode)[], keys: Buffer[]): Promise<void> {
    this.children = [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const blockNum = child instanceof BlockInternalNode ? child.blockNumber : child.getBlockNumber();
      this.children.push({ blockNumber: blockNum, key: keys[i] });
      this.childrenLoaded.set(blockNum, child);
    }
    this.currentSize = INTERNAL_HEADER_SIZE;
    for (const c of this.children) this.currentSize += 4 + 2 + c.key.length;
    this.dirty = true;
    return Promise.resolve();
  }

  getChildCursorAtFirstChild(): ChildCursor<Buffer, Buffer, BlockLeafNode, BlockInternalNode> {
    return new ChildCursorImpl(this._childAccess, 0);
  }

  getChildCursorAtKey(key: Buffer): ChildCursor<Buffer, Buffer, BlockLeafNode, BlockInternalNode> {
    const index = this.findChildIndex(key);
    return new ChildCursorImpl(this._childAccess, index);
  }

  describe(): BlockInternalDescriptor {
    if (this.children.length === 0) {
      return { nodes: [], keys: [] };
    }
    return { nodes: [this], keys: [this.children[this.children.length - 1].key] };
  }

  childCount(): number {
    return this.children.length;
  }

  getChildAt(index: number): BlockLeafNode | BlockInternalNode | Promise<BlockLeafNode | BlockInternalNode> {
    const child = this.children[index];
    if (!child) {
      throw new Error('Child index out of range.');
    }

    // Cache hit: return synchronously to avoid microtask overhead
    const cached = this.childrenLoaded.get(child.blockNumber);
    if (cached) return cached;

    // Cache miss: load from disk asynchronously
    return this.loadNode(child.blockNumber).then((loaded) => {
      this.childrenLoaded.set(child.blockNumber, loaded);
      return loaded;
    });
  }

  getKeyAt(index: number): Buffer {
    const child = this.children[index];
    if (!child) {
      throw new Error('Key index out of range.');
    }
    return child.key;
  }

  isUnderfull(): boolean {
    const minChildren = Math.max(2, Math.ceil(this.getMaxChildren() / 2));
    return this.children.length < minChildren && this.children.length > 0;
  }

  async deallocateUnderfull(): Promise<BlockLeafNode | BlockInternalNode> {
    if (this.children.length !== 1) {
      throw new Error('Internal node can only be deallocated when it has exactly one child.');
    }
    const child = await this.getChildAt(0);
    // Invalidate this node from cache before freeing
    this.onNodeFreed?.(this.blockNumber);
    await this.file.freeBlock(this.blockNumber);
    return child;
  }

  moveLastChildTo(_separatorKey: Buffer, nextNode: BlockInternalNode): Promise<Buffer> {
    const child = this.children.pop();
    if (!child) {
      throw new Error('Internal node has no child to move.');
    }
    this.currentSize -= 4 + 2 + child.key.length;
    nextNode.prependChild(child.blockNumber, child.key);
    this.dirty = true;
    return Promise.resolve(this.children[this.children.length - 1].key);
  }

  moveFirstChildTo(previousNode: BlockInternalNode, _separatorKey: Buffer): Promise<Buffer> {
    if (this.children.length === 0) {
      throw new Error('Internal node has no child to move.');
    }
    const child = this.children.shift()!;
    this.currentSize -= 4 + 2 + child.key.length;
    previousNode.appendChild(child.blockNumber, child.key);
    this.dirty = true;
    return Promise.resolve(
      this.children[this.children.length - 1]?.key ?? previousNode.children[previousNode.children.length - 1].key,
    );
  }

  canMergeWithNext(_key: Buffer, nextNode: BlockLeafNode | BlockInternalNode): boolean {
    if (!(nextNode instanceof BlockInternalNode)) {
      return false;
    }
    // FreeBlockFile reserves 1 byte for block type
    return this.currentSize + nextNode.currentSize - INTERNAL_HEADER_SIZE <= this.blockSize - 1;
  }

  async mergeWithNext(_key: Buffer, nextNode: BlockLeafNode | BlockInternalNode): Promise<void> {
    if (!(nextNode instanceof BlockInternalNode)) {
      throw new Error('Cannot merge internal node with non-internal node');
    }
    this.currentSize += nextNode.currentSize - INTERNAL_HEADER_SIZE;
    this.children.push(...nextNode.children);
    // Copy the loaded children cache from the merged node
    for (const [blockNum, child] of nextNode.childrenLoaded) {
      this.childrenLoaded.set(blockNum, child);
    }
    this.dirty = true;
    // Invalidate the merged node from cache before freeing its block
    this.onNodeFreed?.(nextNode.blockNumber);
    await this.file.freeBlock(nextNode.blockNumber);
  }

  replaceChildren(
    startIndex: number,
    count: number,
    newChildren: (BlockLeafNode | BlockInternalNode)[],
    newKeys: Buffer[],
  ): void {
    // Clear cache entries for old children being removed
    // This prevents stale cache hits if blocks are reallocated
    for (let i = startIndex; i < startIndex + count && i < this.children.length; i++) {
      const oldBlockNum = this.children[i].blockNumber;
      this.childrenLoaded.delete(oldBlockNum);
    }

    const newChildEntries: BlockChild[] = [];
    for (let i = 0; i < newChildren.length; i++) {
      const child = newChildren[i];
      const blockNum = child instanceof BlockInternalNode ? child.blockNumber : child.getBlockNumber();
      newChildEntries.push({ blockNumber: blockNum, key: newKeys[i] });
      this.childrenLoaded.set(blockNum, child);
    }
    let sizeChange = 0;
    for (let i = startIndex; i < startIndex + count && i < this.children.length; i++) {
      sizeChange -= 4 + 2 + this.children[i].key.length;
    }
    for (const entry of newChildEntries) {
      sizeChange += 4 + 2 + entry.key.length;
    }
    this.currentSize += sizeChange;
    this.children.splice(startIndex, count, ...newChildEntries);
    this.dirty = true;
  }

  async splitIfNeeded(): Promise<BlockInternalDescriptor> {
    if (this.children.length === 0) {
      return { nodes: [], keys: [] };
    }

    if (!this.needsSplit()) {
      return this.describe();
    }

    let midpoint = Math.ceil(this.children.length / 2);
    const capacity = this.blockSize - 1;
    const leftSize = this.calculateSize(this.children.slice(0, midpoint));
    const rightHalfSize = this.currentSize - leftSize + INTERNAL_HEADER_SIZE;
    if (leftSize > capacity || rightHalfSize > capacity) {
      let size = INTERNAL_HEADER_SIZE;
      let bestDifference = Infinity;
      for (let i = 0; i < this.children.length - 1; i++) {
        size += 6 + this.children[i].key.length;
        const otherSize = this.currentSize - size + INTERNAL_HEADER_SIZE;
        const difference = Math.abs(size - otherSize);
        if (size <= capacity && otherSize <= capacity && difference < bestDifference) {
          midpoint = i + 1;
          bestDifference = difference;
        }
      }
      // Deletion can replace several short separators with long ones after
      // child merges. Valid individual keys may then require more than two
      // contiguous nodes; a two-way split is not always mathematically possible.
      if (!Number.isFinite(bestDifference)) return this.splitByCapacity();
    }
    const rightChildren = this.children.splice(midpoint);

    // Compute sizes for both halves
    let rightSize = INTERNAL_HEADER_SIZE;
    for (const c of rightChildren) rightSize += 4 + 2 + c.key.length;
    this.currentSize -= rightSize - INTERNAL_HEADER_SIZE;

    // Allocate new node for right half
    const rightNode = await this.allocateInternalNode();
    rightNode.children = rightChildren;
    rightNode.currentSize = rightSize;
    rightNode.dirty = true;

    // Copy loaded children to right node
    for (const child of rightChildren) {
      const loaded = this.childrenLoaded.get(child.blockNumber);
      if (loaded) {
        rightNode.childrenLoaded.set(child.blockNumber, loaded);
      }
    }

    this.dirty = true;

    return {
      nodes: [this, rightNode],
      keys: [this.children[this.children.length - 1].key, rightChildren[rightChildren.length - 1].key],
    };
  }

  private needsSplit(): boolean {
    // FreeBlockFile reserves 1 byte for block type
    return this.currentSize > this.blockSize - 1;
  }

  private async splitByCapacity(): Promise<BlockInternalDescriptor> {
    const capacity = this.blockSize - 1;
    const groups: BlockChild[][] = [[]];
    let size = INTERNAL_HEADER_SIZE;
    for (const child of this.children) {
      const bytes = 6 + child.key.length;
      if (INTERNAL_HEADER_SIZE + bytes > capacity) throw new Error('B+ tree key cannot fit an internal node.');
      if (size + bytes > capacity) {
        groups.push([]);
        size = INTERNAL_HEADER_SIZE;
      }
      groups[groups.length - 1].push(child);
      size += bytes;
    }

    const nodes: BlockInternalNode[] = [this];
    for (let i = 1; i < groups.length; i++) nodes.push(await this.allocateInternalNode());
    for (let i = 1; i < nodes.length; i++) {
      for (const child of groups[i]) {
        const loaded = this.childrenLoaded.get(child.blockNumber);
        if (loaded) nodes[i].childrenLoaded.set(child.blockNumber, loaded);
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].children = groups[i];
      nodes[i].currentSize = this.calculateSize(groups[i]);
      nodes[i].dirty = true;
    }
    return { nodes, keys: nodes.map((node) => node.children[node.children.length - 1].key) };
  }

  private calculateSize(children: BlockChild[]): number {
    let size = INTERNAL_HEADER_SIZE;
    for (const child of children) {
      size += 4 + 2 + child.key.length;
    }
    return size;
  }

  private getMaxChildren(): number {
    // Estimate based on block size
    // Each child needs at least 4 (block number) + 2 (key length) + 1 (min key) = 7 bytes
    return Math.floor((this.blockSize - INTERNAL_HEADER_SIZE) / 7);
  }

  private findChildIndex(key: Buffer): number {
    let low = 0;
    let high = this.children.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.compareKeys(key, this.children[mid].key) <= 0) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    return Math.min(low, Math.max(0, this.children.length - 1));
  }

  private prependChild(blockNumber: number, key: Buffer): void {
    this.currentSize += 4 + 2 + key.length;
    this.children.unshift({ blockNumber, key });
    this.dirty = true;
  }

  private appendChild(blockNumber: number, key: Buffer): void {
    this.currentSize += 4 + 2 + key.length;
    this.children.push({ blockNumber, key });
    this.dirty = true;
  }
}
