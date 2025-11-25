import type { InternalNode, LeafNode, NodeStorage } from './interfaces.mts';
import { InternalNodeImpl } from './internalnode.mjs';
import { LeafNodeImpl } from './leafnode.mjs';

export type NodeStorageOptions<K> = {
  keySize?: (key: K) => number;
  maxLeafEntries?: number;
  maxChildren?: number;
  maxKeySize?: number;
};


export class NodeStorageImpl<K extends string | number, V> implements NodeStorage<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>> {

  readonly compareKeys: (a: K, b: K) => number = (a: K, b: K) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  };

  // default toeveoegen? bv numbers 8 bytes en strings 2 bytes per char
  readonly keySize: (key: K) => number;

  private readonly maxLeafEntries: number;
  private readonly maxChildren: number;
  private readonly maxKeySize: number;

  constructor(options: NodeStorageOptions<K>) {
    this.keySize = options.keySize ?? (() => 1);
    this.maxLeafEntries = options.maxLeafEntries ?? 8;
    this.maxChildren = options.maxChildren ?? 8;
    this.maxKeySize = options.maxKeySize ?? Number.MAX_SAFE_INTEGER;
  }

  getMaxKeySize(): number {
    return this.maxKeySize;
  }

  async createTree(): Promise<LeafNodeImpl<K, V>> {
    return Promise.resolve(new LeafNodeImpl(this.compareKeys, this.maxLeafEntries));
  }

  async allocateInternalNode(
    nodes: (LeafNodeImpl<K, V> | InternalNodeImpl<K, V>)[],
    keys: K[],
  ): Promise<InternalNodeImpl<K, V>> {
    const node = new InternalNodeImpl(this.compareKeys, this.maxChildren);
    node.setChildren(nodes, keys);
    return Promise.resolve(node);
  }
}