import type { ChildCursor } from './interfaces.mts';
import type { InternalNode } from './interfaces.mts';
import type { LeafNode } from './interfaces.mts';
import type { NodeDescriptor } from './nodebase.mts';

export type ChildAccess<K, V, L extends LeafNode<K, V, L, I>, I extends InternalNode<K, V, L, I>> = {
  node: I;
  getChildCount(): number;
  getChildAt(index: number): L | I;
  getKeyAt(index: number): K;
  replaceChildren(startIndex: number, count: number, replacementKeys: K[], replacementChildren: (L | I)[]): void;
  splitIfNeeded(): NodeDescriptor<K, V, L, I>;
  describe(): NodeDescriptor<K, V, L, I>;
};

export class ChildCursorImpl<K, V, L extends LeafNode<K, V, L, I>, I extends InternalNode<K, V, L, I>>
  implements ChildCursor<K, V, L, I>
{
  private readonly access: ChildAccess<K, V, L, I>;
  private index: number;

  constructor(access: ChildAccess<K, V, L, I>, index: number) {
    this.access = access;
    this.index = index;
  }

  isFirstChild(): boolean {
    return this.index === 0;
  }

  isLastChild(): boolean {
    return this.index === this.access.getChildCount() - 1;
  }

  async getChild(offset = 0): Promise<L | I> {
    return this.access.getChildAt(this.index + offset);
  }

  getKeyAfter(): K {
    return this.access.getKeyAt(this.index);
  }

  movePrevious(): void {
    if (this.index === 0) {
      throw new Error('Cursor already at first child.');
    }
    this.index--;
  }

  moveNext(): void {
    if (this.index >= this.access.getChildCount() - 1) {
      throw new Error('Cursor already at last child.');
    }
    this.index++;
  }

  async replaceKeysAndChildrenAfterBy(
    count: number,
    replacementKeys: K[],
    replacementChildren: (L | I)[],
  ): Promise<{ nodes: (L | I)[]; keys: K[] }> {
    this.access.replaceChildren(this.index, count, replacementKeys, replacementChildren);
    if (this.index >= this.access.getChildCount()) {
      this.index = Math.max(0, this.access.getChildCount() - 1);
    }
    const descriptor = this.access.splitIfNeeded();
    return descriptor;
  }
}
