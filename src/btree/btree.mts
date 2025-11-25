import type { ChildCursor } from './interfaces.mts';
import type { NodeDescriptor } from './nodebase.mts';
import { InternalNodeImpl } from './internalnode.mjs';
import { LeafNodeImpl } from './leafnode.mjs';
import { NodeStorageImpl, type NodeStorageOptions } from './nodestorage.mjs';

type PathEntry<K, V> = {
  cursor: ChildCursor<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>>;
};

export class BPlusTree<K, V> {
  private constructor(
    private root: LeafNodeImpl<K, V> | InternalNodeImpl<K, V>,
    private readonly storage: NodeStorageImpl<K, V>,
  ) {}

  static async create<K, V>(options: NodeStorageOptions<K>): Promise<BPlusTree<K, V>> {
    const storage = new NodeStorageImpl<K, V>(options);
    const root = await storage.createTree();
    return new BPlusTree(root, storage);
  }

  async get(key: K): Promise<V | null> {
    const { leaf } = await this.findLeafPath(key);
    const { cursor, isAtKey } = await leaf.getCursorBeforeKey(key);
    if (!isAtKey) {
      return null;
    }
    const [, value] = cursor.getKeyValuePairAfter();
    return value;
  }

  async insert(key: K, value: V): Promise<void> {
    const { leaf, path } = await this.findLeafPath(key);
    const { cursor, isAtKey } = await leaf.getCursorBeforeKey(key);
    if (isAtKey) {
      throw new Error('Duplicate keys are not allowed in B+ trees.');
    }
    const descriptor = await cursor.insert(key, value);
    await this.propagateChange(path, descriptor);
  }

  async delete(key: K): Promise<boolean> {
    const { leaf, path } = await this.findLeafPath(key);
    const { cursor, isAtKey } = await leaf.getCursorBeforeKey(key);
    if (!isAtKey) {
      return false;
    }
    await cursor.removeKeyValuePairAfter();
    const descriptor = leaf.describe();
    await this.propagateChange(path, descriptor);
    return true;
  }

  async *iterate(fromKey?: K): AsyncGenerator<[K, V]> {
    const { leaf } = await this.findLeafPath(fromKey);
    const cursorInfo =
      fromKey === undefined ? { cursor: leaf.getCursorBeforeFirst() } : await leaf.getCursorBeforeKey(fromKey);
    let cursor = cursorInfo.cursor;
    while (true) {
      while (!cursor.isAfterLast()) {
        const [key, value] = cursor.getKeyValuePairAfter();
        if (fromKey === undefined || this.storage.compareKeys(key, fromKey) >= 0) {
          yield [key, value];
        }
        cursor.moveNext();
      }
      const nextLeaf = await cursor.leaf.getNextLeaf();
      if (!nextLeaf) {
        break;
      }
      cursor = nextLeaf.getCursorBeforeFirst();
    }
  }

  private async findLeafPath(key?: K): Promise<{
    leaf: LeafNodeImpl<K, V>;
    path: PathEntry<K, V>[];
  }> {
    const path: PathEntry<K, V>[] = [];
    let node: LeafNodeImpl<K, V> | InternalNodeImpl<K, V> = this.root;
    while (!node.isLeaf) {
      const internalNode = node as InternalNodeImpl<K, V>;
      const cursor =
        key === undefined
          ? await internalNode.getChildCursorAtFirstChild()
          : await internalNode.getChildCursorAtKey(key);
      const child = await cursor.getChild();
      path.push({ cursor });
      node = child as LeafNodeImpl<K, V> | InternalNodeImpl<K, V>;
    }
    return { leaf: node as LeafNodeImpl<K, V>, path };
  }

  private async propagateChange(
    path: PathEntry<K, V>[],
    descriptor: NodeDescriptor<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>>,
  ): Promise<void> {
    let currentDescriptor = descriptor;
    for (let i = path.length - 1; i >= 0; i--) {
      currentDescriptor = await path[i]!.cursor.replaceKeysAndChildrenAfterBy(
        1,
        currentDescriptor.keys,
        currentDescriptor.nodes,
      );
    }
    await this.rebuildRoot(currentDescriptor);
  }

  private async rebuildRoot(
    descriptor: NodeDescriptor<K, V, LeafNodeImpl<K, V>, InternalNodeImpl<K, V>>,
  ): Promise<void> {
    if (descriptor.nodes.length === 0) {
      this.root = await this.storage.createTree();
      return;
    }
    if (descriptor.nodes.length === 1) {
      this.root = descriptor.nodes[0] as LeafNodeImpl<K, V> | InternalNodeImpl<K, V>;
      this.compressRootIfPossible();
      return;
    }
    this.root = await this.storage.allocateInternalNode(descriptor.nodes, descriptor.keys);
  }

  private compressRootIfPossible() {
    while (!this.root.isLeaf) {
      const internalRoot = this.root as InternalNodeImpl<K, V>;
      if (internalRoot.childCount() !== 1) {
        break;
      }
      this.root = internalRoot.getChildAt(0) as LeafNodeImpl<K, V> | InternalNodeImpl<K, V>;
    }
  }
}
