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
  /**
   * Called after tree operations to finalize the root.
   * For all storage types: returns the root unchanged.
   * The caller is responsible for tracking the root block number.
   */
  finalizeRoot(root: LeafNodeType | InternalNodeType): Promise<LeafNodeType | InternalNodeType>;
  releaseRoot?(root: LeafNodeType | InternalNodeType): Promise<void>;
}

export interface NodeBase<
  K,
  V,
  LeafNodeType extends LeafNode<K, V, LeafNodeType, InternalNodeType>,
  InternalNodeType extends InternalNode<K, V, LeafNodeType, InternalNodeType>,
> {
  readonly isLeaf: boolean;
  canMergeWithNext(key: K, nextNode: LeafNodeType | InternalNodeType): boolean;
  /**
   * Merges `nextNode`, which must be the successor sibling of this node, into this node. Deallocates `nextNode`.
   */
  mergeWithNext(key: K, nextNode: LeafNodeType | InternalNodeType): Promise<void>;
}

export interface LeafNode<
  K,
  V,
  LeafNodeType extends LeafNode<K, V, LeafNodeType, InternalNodeType>,
  InternalNodeType extends InternalNode<K, V, LeafNodeType, InternalNodeType>,
> extends NodeBase<K, V, LeafNodeType, InternalNodeType> {
  readonly isLeaf: true;
  getCursorBeforeFirst(): LeafCursor<K, V, LeafNodeType, InternalNodeType>;
  getCursorBeforeKey(
    key: K,
  ):
    | { cursor: LeafCursor<K, V, LeafNodeType, InternalNodeType>; isAtKey: boolean }
    | PromiseLike<{ cursor: LeafCursor<K, V, LeafNodeType, InternalNodeType>; isAtKey: boolean }>;
  getNextLeaf(): Promise<LeafNode<K, V, LeafNodeType, InternalNodeType> | null>;
  /**
   * Returns a descriptor of this node for propagating changes up the tree.
   */
  describe(): { nodes: (LeafNodeType | InternalNodeType)[]; keys: K[] };
}

export interface LeafCursor<
  K,
  V,
  LeafNodeType extends LeafNode<K, V, LeafNodeType, InternalNodeType>,
  InternalNodeType extends InternalNode<K, V, LeafNodeType, InternalNodeType>,
> {
  readonly leaf: LeafNodeType;
  isAfterLast(): boolean;
  getKeyValuePairAfter(): [K, V];
  moveNext(): void;
  insert(key: K, value: V): Promise<{ nodes: LeafNodeType[]; keys: K[] }>;
  removeKeyValuePairAfter(): Promise<void>;
  updateValueAfter(value: V): Promise<{ nodes: LeafNodeType[]; keys: K[] }>;
}

export interface InternalNode<
  K,
  V,
  LeafNodeType extends LeafNode<K, V, LeafNodeType, InternalNodeType>,
  InternalNodeType extends InternalNode<K, V, LeafNodeType, InternalNodeType>,
> extends NodeBase<K, V, LeafNodeType, InternalNodeType> {
  readonly isLeaf: false;
  /** Split an over-capacity node before persisting it, including a new root. */
  splitIfNeeded():
    | { nodes: (LeafNodeType | InternalNodeType)[]; keys: K[] }
    | Promise<{ nodes: (LeafNodeType | InternalNodeType)[]; keys: K[] }>;
  getChildCursorAtFirstChild():
    | ChildCursor<K, V, LeafNodeType, InternalNodeType>
    | PromiseLike<ChildCursor<K, V, LeafNodeType, InternalNodeType>>;
  getChildCursorAtKey(
    key: K,
  ): ChildCursor<K, V, LeafNodeType, InternalNodeType> | PromiseLike<ChildCursor<K, V, LeafNodeType, InternalNodeType>>;
  isUnderfull(): boolean;
  deallocateUnderfull(): Promise<LeafNodeType | InternalNodeType>;
  /**
   * Move this node's last child to become the first child of `nextNode`.
   * @param separatorKey The key that separates this node and `nextNode`
   * @param nextNode
   * @return The new separator key for this node and `nextNode`.
   */
  moveLastChildTo(separatorKey: K, nextNode: InternalNodeType): Promise<K>;
  /**
   * Move this node's first child to become the last child of `previousNode`.
   * @param separatorKey The key that separates `previousNode` and this node
   * @param previousNode
   * @return The new separator key for `previousNode` and this node.
   */
  moveFirstChildTo(previousNode: InternalNodeType, separatorKey: K): Promise<K>;
}

/**
 * A cursor that points to a child pointer in an internal node.
 */
export interface ChildCursor<
  K,
  V,
  LeafNodeType extends LeafNode<K, V, LeafNodeType, InternalNodeType>,
  InternalNodeType extends InternalNode<K, V, LeafNodeType, InternalNodeType>,
> {
  isFirstChild(): boolean;
  isLastChild(): boolean;
  getChild(offset?: number): LeafNodeType | InternalNodeType | PromiseLike<LeafNodeType | InternalNodeType>;
  getKeyAfter(): K;
  movePrevious(): void;
  moveNext(): void;
  /**
   * Replaces the `count` keys and child pointers after the cursor by `newKeys` and `newChildren`.
   * Precondition: `newChildren.length === newKeys.length`.
   * If the new keys and children don't fit, the node is split.
   * Returns the list of nodes, with intervening keys, that replaces this cursor's parent node.
   */
  replaceKeysAndChildrenAfterBy(
    count: number,
    replacementKeys: K[],
    replacementChildren: (LeafNodeType | InternalNodeType)[],
  ): Promise<{ nodes: (LeafNodeType | InternalNodeType)[]; keys: K[] }>;
}
