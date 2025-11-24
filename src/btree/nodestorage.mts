import type { InternalNode, LeafNode, NodeStorage } from './interfaces.mts';
import { InternalNodeImpl } from './internalnode.mjs';
import { LeafNodeImpl } from './leafnode.mjs';

export type NodeStorageOptions<K> = {
  compareKeys: (a: K, b: K) => number;
  keySize?: (key: K) => number;
  maxLeafEntries?: number;
  maxChildren?: number;
  maxKeySize?: number;
};

export class NodeStorageImpl<K, V> implements NodeStorage<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>> {
  readonly compareKeys: (a: K, b: K) => number;
  readonly keySize: (key: K) => number;

  private readonly maxLeafEntries: number;
  private readonly maxChildren: number;
  private readonly maxKeySize: number;

  constructor(options: NodeStorageOptions<K>) {
    this.compareKeys = options.compareKeys;
    this.keySize = options.keySize ?? (() => 1);
    this.maxLeafEntries = options.maxLeafEntries ?? 8;
    this.maxChildren = options.maxChildren ?? 8;
    this.maxKeySize = options.maxKeySize ?? Number.MAX_SAFE_INTEGER;
  }

  getMaxKeySize(): number {
    return this.maxKeySize;
  }

  async createTree(): Promise<LeafNodeImpl<K, V>> {
    return new LeafNodeImpl<K, V>(this.compareKeys, this.maxLeafEntries);
  }

  async allocateInternalNode(
    nodes: (LeafNodeImpl<K, V> | InternalNodeImpl<K, V>)[],
    keys: K[],
  ): Promise<InternalNodeImpl<K, V>> {
    const node = new InternalNodeImpl<K, V>(this.compareKeys, this.maxChildren);
    node.setChildren(nodes, keys);
    return node;
  }
}
