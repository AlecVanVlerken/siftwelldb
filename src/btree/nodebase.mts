import type { InternalNode, LeafNode, NodeBase } from './interfaces.mts';

export type NodeDescriptor<K, V, L extends LeafNode<K, V, L, I>, I extends InternalNode<K, V, L, I>> = {
  nodes: (L | I)[];
  keys: K[];
};

function isValidSeperatorKey<K>(
  greatestLeftKey: K,
  smallestRightKey: K,
  separatorKey: K,
  compareKeys: (a: K, b: K) => number,
): boolean {
  // all the left keys must be less than or equal to the separator key
  if (compareKeys(greatestLeftKey, separatorKey) > 0) {
    return false;
  }
  // all the right keys must be greater than the separator key
  if (compareKeys(smallestRightKey, separatorKey) <= 0) {
    return false;
  }
  return true;
}

export abstract class NodeBaseImpl<K, V, L extends LeafNode<K, V, L, I>, I extends InternalNode<K, V, L, I>>
  implements NodeBase<K, V, L, I>
{
  abstract readonly isLeaf: boolean;

  protected constructor(
    protected readonly compareKeys: (a: K, b: K) => number,
    protected readonly maxOccupancy: number,
  ) {}

  protected abstract getOccupancy(): number;
  protected abstract absorbNextNode(nextNode: L | I): Promise<void>;
  protected abstract greatestKeyInternal(): K;
  protected abstract smallestKeyInternal(): K;

  canMergeWithNext(_key: K, nextNode: L | I): boolean {
    if (!(nextNode instanceof NodeBaseImpl)) {
      throw new Error('Cannot merge nodes created by another implementation.');
    }
    const nextNodeImpl = nextNode as NodeBaseImpl<K, V, L, I>;
    if (!isValidSeperatorKey(this.getGreatestKey(), nextNodeImpl.getSmallestKey(), _key, this.compareKeys)) {
      return false;
    }
    // Still have to check wether _key is correct, but for now assume it is.
    return this.getOccupancy() + nextNodeImpl.getOccupancy() <= this.maxOccupancy;
  }

  async mergeWithNext(_key: K, nextNode: L | I): Promise<void> {
    // if (!(nextNode instanceof NodeBaseImpl)) {
    //   throw new Error('Cannot merge nodes created by another implementation.');
    // }
    if (!this.canMergeWithNext(_key, nextNode)) {
      throw new Error('Cannot merge nodes: not enough space.');
    }
    await this.absorbNextNode(nextNode);
  }

  getGreatestKey(): K {
    return this.greatestKeyInternal();
  }

  getSmallestKey(): K {
    return this.smallestKeyInternal();
  }

  protected describeSelf(): NodeDescriptor<K, V, L, I> {
    return { nodes: [this as unknown as L | I], keys: [this.greatestKeyInternal()] };
  }
}
