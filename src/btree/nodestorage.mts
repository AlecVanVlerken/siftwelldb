import type { NodeStorage } from './interfaces.mts';
import type { LeafNode } from './interfaces.mts';
import type { InternalNode } from './interfaces.mts';

export class NodeStorageImpl<K, V, L extends LeafNode<K, V, L, I>, I extends InternalNode<K, V, L, I>>
  implements NodeStorage<K, V, L, I>
{
  readonly compareKeys = (a: K, b: K) => {
    throw new Error('Method not implemented.');
  };

  readonly keySize = (key: K) => {
    throw new Error('Method not implemented.');
  };

  getMaxKeySize(): number {
    throw new Error('Method not implemented.');
  }

  async createTree(): Promise<L> {
    throw new Error('Method not implemented.');
  }

  async allocateInternalNode(nodes: (L | I)[], keys: K[]): Promise<I> {
    throw new Error('Method not implemented.');
  }
}
