import type { ChildCursor, InternalNode, LeafNode } from './interfaces.mts';
import { NodeBaseImpl, type NodeDescriptor } from './nodebase.mjs';
import { ChildCursorImpl, type ChildAccess } from './childcursor.mjs';
import type { LeafNodeImpl } from './leafnode.mts';

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

  getChildCursorAtFirstChild(): Promise<ChildCursor<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>>> {
    return Promise.resolve(new ChildCursorImpl(this.createAccess(), 0));
  }

  getChildCursorAtKey(key: K): Promise<ChildCursor<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>>> {
    const index = this.findChildIndex(key);
    return Promise.resolve(new ChildCursorImpl(this.createAccess(), index));
  }

  describe(): NodeDescriptor<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>> {
    if (this.children.length === 0) {
      return { nodes: [], keys: [] };
    }
    return { nodes: [this], keys: [this.keys[this.keys.length - 1]!] };
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

  async deallocateUnderfull(): Promise<LeafNodeImpl<K, V> | InternalNodeImpl<K, V>> {
    if (this.children.length !== 1) {
      throw new Error('Internal node can only be deallocated when it has exactly one child.');
    }
    return this.children[0]!;
  }

  async moveLastChildTo(_separatorKey: K, nextNode: InternalNodeImpl<K, V>): Promise<K> {
    const child = this.children.pop();
    const key = this.keys.pop();
    if (!child || key === undefined) {
      throw new Error('Internal node has no child to move.');
    }
    nextNode.prependChild(child, key);
    return this.getKeyAt(this.keys.length - 1);
  }

  async moveFirstChildTo(previousNode: InternalNodeImpl<K, V>, _separatorKey: K): Promise<K> {
    if (this.children.length === 0) {
      throw new Error('Internal node has no child to move.');
    }
    const child = this.children.shift()!;
    const key = this.keys.shift();
    previousNode.appendChild(child, key ?? previousNode.keys[previousNode.keys.length - 1]!);
    return this.keys[this.keys.length - 1] ?? previousNode.keys[previousNode.keys.length - 1]!;
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
      keys: [this.keys[this.keys.length - 1]!, rightKeys[rightKeys.length - 1]!],
    };
  }

  protected getOccupancy(): number {
    return this.children.length;
  }

  protected async absorbNextNode(nextNode: LeafNodeImpl<K, V> | InternalNodeImpl<K, V>): Promise<void> {
    if (!(nextNode instanceof InternalNodeImpl)) {
      throw new Error('Internal nodes can only absorb other internal nodes.');
    }
    this.children.push(...nextNode.children);
    this.keys.push(...nextNode.keys);
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
      if (this.compareKeys(key, this.keys[mid]!) <= 0) {
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
