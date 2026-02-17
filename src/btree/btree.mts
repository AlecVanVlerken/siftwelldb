import type { ChildCursor, InternalNode, LeafNode, NodeStorage } from './interfaces.mts';
import type { NodeDescriptor } from './nodebase.mts';

type PathEntry<K, V, L extends LeafNode<K, V, L, I>, I extends InternalNode<K, V, L, I>> = {
  cursor: ChildCursor<K, V, L, I>;
};

export class BPlusTree<K, V, L extends LeafNode<K, V, L, I>, I extends InternalNode<K, V, L, I>> {
  private constructor(
    private root: L | I,
    private readonly storage: NodeStorage<K, V, L, I>,
  ) {}

  /**
   * Create a new empty B+ tree with the given storage.
   */
  static async create<K, V, L extends LeafNode<K, V, L, I>, I extends InternalNode<K, V, L, I>>(
    storage: NodeStorage<K, V, L, I>,
  ): Promise<BPlusTree<K, V, L, I>> {
    const root = await storage.createTree();
    const tree = new BPlusTree<K, V, L, I>(root, storage);
    return tree;
  }

  /**
   * Open an existing B+ tree with the given storage and root node.
   * Use this when loading a tree from disk.
   */
  static open<K, V, L extends LeafNode<K, V, L, I>, I extends InternalNode<K, V, L, I>>(
    storage: NodeStorage<K, V, L, I>,
    root: L | I,
  ): BPlusTree<K, V, L, I> {
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
    await this.propagateChange(path, descriptor, false);
  }

  async delete(key: K): Promise<boolean> {
    const { leaf, path } = await this.findLeafPath(key);
    const { cursor, isAtKey } = await leaf.getCursorBeforeKey(key);
    if (!isAtKey) {
      return false;
    }
    await cursor.removeKeyValuePairAfter();
    const descriptor = leaf.describe();
    await this.propagateChange(path, descriptor, true);
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
    await this.propagateChange(path, descriptor, false);
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
    attemptMerge: boolean,
  ): Promise<void> {
    let currentDescriptor = descriptor;
    let replaceCount = 1; // How many children to replace (normally 1, 2 after merge)

    for (let i = path.length - 1; i >= 0; i--) {
      const cursor = path[i].cursor;

      // Try to merge with siblings before propagating up (only during deletes)
      // During inserts/updates, nodes only grow, so merging is never needed
      if (attemptMerge && currentDescriptor.nodes.length === 1) {
        const mergeResult = await this.tryMergeWithSibling(cursor, currentDescriptor);
        currentDescriptor = mergeResult.descriptor;
        replaceCount = mergeResult.mergedWithPrev ? 2 : mergeResult.mergedWithNext ? 2 : 1;
      }

      currentDescriptor = await cursor.replaceKeysAndChildrenAfterBy(
        replaceCount,
        currentDescriptor.keys,
        currentDescriptor.nodes,
      );
      replaceCount = 1; // Reset for next level
    }
    await this.rebuildRoot(currentDescriptor);
  }

  /**
   * Attempt to merge a node with its sibling if possible.
   * This is called during delete to keep the tree compact.
   * Returns the updated descriptor and flags indicating if merge occurred.
   *
   * IMPORTANT: When merging, cursor position matters for replaceKeysAndChildrenAfterBy:
   * - mergedWithPrev: cursor stays at prev position, replace 2 children from there
   * - mergedWithNext: cursor stays at current position, replace 2 children from there
   */
  private async tryMergeWithSibling(
    cursor: ChildCursor<K, V, L, I>,
    descriptor: NodeDescriptor<K, V, L, I>,
  ): Promise<{ descriptor: NodeDescriptor<K, V, L, I>; mergedWithPrev: boolean; mergedWithNext: boolean }> {
    const noMerge = { descriptor, mergedWithPrev: false, mergedWithNext: false };

    if (descriptor.nodes.length !== 1) {
      return noMerge;
    }

    const node = descriptor.nodes[0];
    const nodeKey = descriptor.keys[0];

    // Try to merge with next sibling FIRST (simpler cursor handling)
    // When merging with next, cursor stays at current position
    if (!cursor.isLastChild()) {
      try {
        cursor.moveNext();
        const nextSibling = await cursor.getChild();
        const nextKey = cursor.getKeyAfter();

        if (node.canMergeWithNext(nodeKey, nextSibling)) {
          // Merge: node absorbs nextSibling
          await node.mergeWithNext(nodeKey, nextSibling);
          cursor.movePrevious(); // Move back to original position (at node)
          // Parent will replace node + nextSibling with just node
          return {
            descriptor: {
              nodes: [node],
              keys: [nextKey], // Use the larger key
            },
            mergedWithPrev: false,
            mergedWithNext: true,
          };
        }
        cursor.movePrevious(); // Move back to original position
      } catch {
        // If movement fails, continue without merging
      }
    }

    // Try to merge with previous sibling
    // When merging with prev, we need cursor at prev position for correct replacement
    if (!cursor.isFirstChild()) {
      try {
        cursor.movePrevious();
        const prevSibling = await cursor.getChild();
        const separatorKey = cursor.getKeyAfter();

        if (prevSibling.canMergeWithNext(separatorKey, node)) {
          // Merge: prevSibling absorbs node
          await prevSibling.mergeWithNext(separatorKey, node);
          // Cursor STAYS at prevSibling position (don't move back!)
          // Parent will replace prevSibling + node with just prevSibling
          return {
            descriptor: {
              nodes: [prevSibling],
              keys: [nodeKey], // Use the larger key
            },
            mergedWithPrev: true,
            mergedWithNext: false,
          };
        }
        cursor.moveNext(); // Move back to original position
      } catch {
        // If movement fails, continue without merging
      }
    }

    return noMerge;
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
      this.root = await this.storage.finalizeRoot(this.root);
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
