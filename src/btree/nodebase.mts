import type { InternalNode, LeafNode, NodeBase } from './interfaces.mts';

export type NodeDescriptor<K, V, L extends LeafNode<K, V, L, I>, I extends InternalNode<K, V, L, I>> = {
  nodes: (L | I)[];
  keys: K[];
};

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

  canMergeWithNext(_key: K, nextNode: L | I): boolean {
    if (!(nextNode instanceof NodeBaseImpl)) {
      return false;
    }
    return this.getOccupancy() + (nextNode as NodeBaseImpl<K, V, L, I>).getOccupancy() <= this.maxOccupancy;
  }

  async mergeWithNext(_key: K, nextNode: L | I): Promise<void> {
    if (!(nextNode instanceof NodeBaseImpl)) {
      throw new Error('Cannot merge nodes created by another implementation.');
    }
    await this.absorbNextNode(nextNode);
  }

  getGreatestKey(): K {
    return this.greatestKeyInternal();
  }

  protected describeSelf(): NodeDescriptor<K, V, L, I> {
    return { nodes: [this as unknown as L | I], keys: [this.greatestKeyInternal()] };
  }
}
