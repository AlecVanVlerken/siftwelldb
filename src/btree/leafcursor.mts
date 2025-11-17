import type { LeafCursor } from './interfaces.mts';
import type { LeafNode } from './interfaces.mts';

export class LeafCursorImpl<
  K,
  V,
  L extends LeafNode<K, V, L, I>,
  I extends import('./interfaces.mts').InternalNode<K, V, L, I>,
> implements LeafCursor<K, V, L, I>
{
  readonly leaf: L;

  constructor(leaf: L) {
    this.leaf = leaf;
  }

  isAfterLast(): boolean {
    throw new Error('Method not implemented.');
  }

  getKeyValuePairAfter(): [K, V] {
    throw new Error('Method not implemented.');
  }

  moveNext(): void {
    throw new Error('Method not implemented.');
  }

  async insert(key: K, value: V): Promise<{ nodes: L[]; keys: K[] }> {
    throw new Error('Method not implemented.');
  }

  async removeKeyValuePairAfter(): Promise<void> {
    throw new Error('Method not implemented.');
  }
}
