import type { LeafCursor } from './interfaces.mts';
import type { LeafNode } from './interfaces.mts';
import type { NodeDescriptor } from './nodebase.mts';

export type LeafAccess<
  K,
  V,
  L extends LeafNode<K, V, L, I>,
  I extends import('./interfaces.mts').InternalNode<K, V, L, I>,
> = {
  leaf: L;
  getEntryCount(): number;
  getKeyValuePairAt(index: number): [K, V];
  insertAt(index: number, key: K, value: V): void;
  removeAt(index: number): void;
  splitIfNeeded(): NodeDescriptor<K, V, L, I>;
};

export class LeafCursorImpl<
  K,
  V,
  L extends LeafNode<K, V, L, I>,
  I extends import('./interfaces.mts').InternalNode<K, V, L, I>,
> implements LeafCursor<K, V, L, I>
{
  readonly leaf: L;
  private position: number;
  private readonly access: LeafAccess<K, V, L, I>;

  constructor(leafAccess: LeafAccess<K, V, L, I>, position = -1) {
    this.leaf = leafAccess.leaf;
    this.position = position;
    this.access = leafAccess;
  }

  isAfterLast(): boolean {
    return this.position >= this.access.getEntryCount() - 1;
  }

  getKeyValuePairAfter(): [K, V] {
    return this.access.getKeyValuePairAt(this.position + 1);
  }

  moveNext(): void {
    this.position++;
  }

  async insert(key: K, value: V): Promise<{ nodes: L[]; keys: K[] }> {
    const insertIndex = this.position + 1;
    this.access.insertAt(insertIndex, key, value);
    this.position = insertIndex;
    const descriptor = this.access.splitIfNeeded();
    return { nodes: descriptor.nodes as L[], keys: descriptor.keys };
  }

  async removeKeyValuePairAfter(): Promise<void> {
    this.access.removeAt(this.position + 1);
    this.position = Math.min(this.position, this.access.getEntryCount() - 1);
  }
}
