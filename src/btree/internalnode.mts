import type { InternalNode } from './interfaces.mts';
import type { LeafNode } from './interfaces.mts';
import type { ChildCursor } from './interfaces.mts';
import { NodeBaseImpl } from './nodebase.mjs';

export abstract class InternalNodeImpl<K, V, L extends LeafNode<K, V, L, I>, I extends InternalNode<K, V, L, I>>
  extends NodeBaseImpl<K, V, L, I>
  implements InternalNode<K, V, L, I>
{
  readonly isLeaf = false;

  abstract getChildCursorAtFirstChild(): Promise<ChildCursor<K, V, L, I>>;
  abstract getChildCursorAtKey(key: K): Promise<ChildCursor<K, V, L, I>>;

  isUnderfull(): boolean {
    throw new Error('Method not implemented.');
  }

  async deallocateUnderfull(): Promise<L | I> {
    throw new Error('Method not implemented.');
  }

  async moveLastChildTo(separatorKey: K, nextNode: I): Promise<K> {
    throw new Error('Method not implemented.');
  }

  async moveFirstChildTo(previousNode: I, separatorKey: K): Promise<K> {
    throw new Error('Method not implemented.');
  }
}
