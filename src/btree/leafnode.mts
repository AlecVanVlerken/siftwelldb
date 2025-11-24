import { LeafCursorImpl, type LeafAccess } from './leafcursor.mts';
import type { LeafCursor, LeafNode } from './interfaces.mts';
import type { InternalNode } from './interfaces.mts';
import type { InternalNodeImpl } from './internalnode.mts';
import { NodeBaseImpl, type NodeDescriptor } from './nodebase.mts';

type Entry<K, V> = { key: K; value: V };
type LeafDescriptor<K, V> = NodeDescriptor<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>>;

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

  getCursorBeforeFirst(): LeafCursor<K, V, L, I> {
    return new LeafCursorImpl<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>>(this.createLeafAccess(), -1);
  }

  getCursorBeforeKey(
    key: K,
  ):
    | { cursor: LeafCursor<K, V, L, I>; isAtKey: boolean }
    | PromiseLike<{ cursor: LeafCursor<K, V, L, I>; isAtKey: boolean }> {
    const access = this.createLeafAccess();
    const index = this.findFirstGreaterOrEqualIndex(key);
    const cursor = new LeafCursorImpl(access, index - 1);
    const isAtKey = index < this.entries.length && this.compareKeys(this.entries[index]!.key, key) === 0;
    return { cursor, isAtKey };
  }

  async getNextLeaf(): Promise<L | null> {
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

  describe(): LeafDescriptor<K, V> {
    if (this.entries.length === 0) {
      return { nodes: [], keys: [] };
    }
    return {
      nodes: [this],
      keys: [this.entries[this.entries.length - 1]!.key],
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
      keys: [this.entries[this.entries.length - 1]!.key, rightEntries[rightEntries.length - 1]!.key],
    };
  }

  protected getOccupancy(): number {
    return this.entries.length;
  }

  protected async absorbNextNode(nextNode: L | I): Promise<void> {
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

  private findFirstGreaterOrEqualIndex(key: K): number {
    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.compareKeys(this.entries[mid]!.key, key) < 0) {
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
      splitIfNeeded: () => this.splitIfNeeded(),
    };
  }
}
