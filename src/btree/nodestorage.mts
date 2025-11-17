import { LeafNode } from './leafnode.mjs';
import { InternalNode } from './internalnode.mjs';

export interface NodeStorage<
  K,
  V,
  LeafNodeType extends LeafNode<K, V, LeafNodeType, InternalNodeType>,
  InternalNodeType extends InternalNode<K, V, LeafNodeType, InternalNodeType>,
> {
  readonly compareKeys: (a: K, b: K) => number;
  readonly keySize: (key: K) => number;

  getMaxKeySize(): number;
  createTree(): Promise<LeafNodeType>;
  allocateInternalNode(nodes: (LeafNodeType | InternalNodeType)[], keys: K[]): Promise<InternalNodeType>;
}
