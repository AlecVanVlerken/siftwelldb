import type { NodeBase } from './interfaces.mts';
import type { LeafNode } from './interfaces.mts';
import type { InternalNode } from './interfaces.mts';

export abstract class NodeBaseImpl<K, V, L extends LeafNode<K, V, L, I>, I extends InternalNode<K, V, L, I>>
  implements NodeBase<K, V, L, I>
{
  abstract readonly isLeaf: boolean;

  canMergeWithNext(key: K, nextNode: L | I): boolean {
    throw new Error('Method not implemented.');
  }

  async mergeWithNext(key: K, nextNode: L | I): Promise<void> {
    throw new Error('Method not implemented.');
  }
}
