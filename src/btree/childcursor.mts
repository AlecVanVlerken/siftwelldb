import type { ChildCursor } from './interfaces.mts';
import type { LeafNode } from './interfaces.mts';
import type { InternalNode } from './interfaces.mts';

export class ChildCursorImpl<K, V, L extends LeafNode<K, V, L, I>, I extends InternalNode<K, V, L, I>>
  implements ChildCursor<K, V, L, I>
{
  isFirstChild(): boolean {
    throw new Error('Method not implemented.');
  }

  isLastChild(): boolean {
    throw new Error('Method not implemented.');
  }

  async getChild(offset?: number): Promise<L | I> {
    throw new Error('Method not implemented.');
  }

  getKeyAfter(): K {
    throw new Error('Method not implemented.');
  }

  movePrevious(): void {
    throw new Error('Method not implemented.');
  }

  moveNext(): void {
    throw new Error('Method not implemented.');
  }

  async replaceKeysAndChildrenAfterBy(
    count: number,
    replacementKeys: K[],
    replacementChildren: (L | I)[],
  ): Promise<{ nodes: (L | I)[]; keys: K[] }> {
    throw new Error('Method not implemented.');
  }
}
