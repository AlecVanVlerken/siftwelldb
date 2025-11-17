import type { LeafNode } from './interfaces.mts';
import type { LeafCursor } from './interfaces.mts';
import type { InternalNode } from './interfaces.mts';
import { NodeBaseImpl } from './nodebase.mjs';

export abstract class LeafNodeImpl<K, V, L extends LeafNode<K, V, L, I>, I extends InternalNode<K, V, L, I>>
  extends NodeBaseImpl<K, V, L, I>
  implements LeafNode<K, V, L, I>
{
  readonly isLeaf = true;

  abstract getCursorBeforeFirst(): LeafCursor<K, V, L, I>;

  abstract getCursorBeforeKey(
    key: K,
  ):
    | { cursor: LeafCursor<K, V, L, I>; isAtKey: boolean }
    | PromiseLike<{ cursor: LeafCursor<K, V, L, I>; isAtKey: boolean }>;

  async getNextLeaf(): Promise<L | null> {
    throw new Error('Method not implemented.');
  }
}
