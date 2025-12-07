import type { ChildCursor, InternalNode, LeafNode, NodeStorage } from './interfaces.mts';
import type { NodeDescriptor } from './nodebase.mts';

type PathEntry<K, V, L extends LeafNode<K, V, L, I>, I extends InternalNode<K, V, L, I>> = {
  cursor: ChildCursor<K, V, L, I>;
};

export class BPlusTree<
  K,
  V,
  L extends LeafNode<K, V, L, I>,
  I extends InternalNode<K, V, L, I>,
> {
  private constructor(
    private root: L | I,
    private readonly storage: NodeStorage<K, V, L, I>,
  ) {}

  /**
   * Create a new empty B+ tree with the given storage.
   */
  static async create<
    K,
    V,
    L extends LeafNode<K, V, L, I>,
    I extends InternalNode<K, V, L, I>,
  >(storage: NodeStorage<K, V, L, I>): Promise<BPlusTree<K, V, L, I>> {
    const root = await storage.createTree();
    const tree = new BPlusTree<K, V, L, I>(root, storage);
    return tree;
  }

  /**
   * Open an existing B+ tree with the given storage and root node.
   * Use this when loading a tree from disk.
   */
  static open<
    K,
    V,
    L extends LeafNode<K, V, L, I>,
    I extends InternalNode<K, V, L, I>,
  >(storage: NodeStorage<K, V, L, I>, root: L | I): BPlusTree<K, V, L, I> {
    return new BPlusTree<K, V, L, I>(root, storage);
  }

  /**
   * Get the current root node.
   */
  getRoot(): L | I {
    return this.root;
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

  /**
   * Update the value for an existing key.
   * Returns true if key was found and updated, false if key not found.
   * Note: If the new value is larger, this may trigger a node split.
   */
  async update(key: K, value: V): Promise<boolean> {
    const { leaf, path } = await this.findLeafPath(key);
    const { cursor, isAtKey } = await leaf.getCursorBeforeKey(key);
    if (!isAtKey) {
      return false;
    }
    const descriptor = await cursor.updateValueAfter(value);
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
    leaf: L;
    path: PathEntry<K, V, L, I>[];
  }> {
    const path: PathEntry<K, V, L, I>[] = [];
    let node: L | I = this.root;
    while (!node.isLeaf) {
      const internalNode = node;
      const cursor =
        key === undefined
          ? await internalNode.getChildCursorAtFirstChild()
          : await internalNode.getChildCursorAtKey(key);
      const child = await cursor.getChild();
      path.push({ cursor });
      node = child;
    }
    return { leaf: node, path };
  }

  private async propagateChange(
    path: PathEntry<K, V, L, I>[],
    descriptor: NodeDescriptor<K, V, L, I>,
  ): Promise<void> {
    let currentDescriptor = descriptor;
    for (let i = path.length - 1; i >= 0; i--) {
      currentDescriptor = await path[i].cursor.replaceKeysAndChildrenAfterBy(
        1,
        currentDescriptor.keys,
        currentDescriptor.nodes,
      );
    }
    await this.rebuildRoot(currentDescriptor);
  }

  private async rebuildRoot(descriptor: NodeDescriptor<K, V, L, I>): Promise<void> {
    if (descriptor.nodes.length === 0) {
      this.root = await this.storage.createTree();
      this.root = (await this.storage.finalizeRoot(this.root)) as L;
      return;
    }
    if (descriptor.nodes.length === 1) {
      this.root = descriptor.nodes[0];
      await this.compressRootIfPossible();
      this.root = (await this.storage.finalizeRoot(this.root));
      return;
    }
    this.root = await this.storage.allocateInternalNode(descriptor.nodes, descriptor.keys);
    this.root = (await this.storage.finalizeRoot(this.root)) as I;
  }

  private async compressRootIfPossible(): Promise<void> {
    while (!this.root.isLeaf) {
      const internalRoot = this.root;
      if (!internalRoot.isUnderfull() || (await this.getChildCount(internalRoot)) !== 1) {
        break;
      }
      this.root = await internalRoot.deallocateUnderfull();
    }
  }

  private async getChildCount(node: I): Promise<number> {
    const cursor = await node.getChildCursorAtFirstChild();
    let count = 1;
    while (!cursor.isLastChild()) {
      cursor.moveNext();
      count++;
    }
    return count;
  }
}
