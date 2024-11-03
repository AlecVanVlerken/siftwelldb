import assert from 'node:assert';

/*

This file provides an outline and test suite for an implementation of a 2-3-tree algorithm. Completing this algorithm is a
good way to bootstrap your B-tree implementation. (A 2-3-tree is a special case of a B-tree.)

Note: this outline and test suite is for an implementation where the values in the interior nodes are duplicates of values
that also appear in leaf nodes. It therefore corresponds to a B+-tree rather than a B-tree. For this project, you may choose
to implement either a B-tree or a B+-tree (or any other data structure that offers the specified performance). In the material
we provide, we often use "B-tree" and "B+-tree" interchangeably. Both are perfectly balanced trees with a variable number of
children per interior node.

*/

type LeafNode = string;
/**
 * An interior node is an array of odd length, where the elements at even indices are either string values (i.e. leaf nodes)
 * or child interior nodes, and each element at odd index i is a string value v such that the values in the subtree rooted
 * at index i - 1 are not greater than v, and the values in the subtree rooted at index i + 1 are greater than v.
 *
 * In a 2-3-tree, all interior nodes have either two or three children.
 */
type InteriorNode = (Node | string)[];
type Node = LeafNode | InteriorNode;
/**
 * `null` represents the empty tree.
 */
type Tree = Node | null;

/**
 * Returns an updated version of the interior node, which may be overfull (more than 3 children/5 elements).
 *
 * If the node's children are themselves interior nodes, this function calls itself recursively on the appropriate child.
 * Then, it replaces the child by the recursive call's result (after splitting it if it is overfull).
 */
function insertIntoSubtree(node: InteriorNode, value: string): InteriorNode {
  throw new Error('Not yet implemented');
}

/**
 * If the tree is an interior node, calls insertIntoSubtree on it. Then, if the result is overfull, it splits it into multiple nodes.
 */
function insert(tree: Tree, value: string): Tree {
  throw new Error('Not yet implemented');
}

/**
 * Returns an updated version of the interior node, which may be underfull (just 1 child/element).
 *
 * If the node's children are themselves interior nodes, this function calls itself recursively on the appropriate child.
 * Then, if the child is underfull:
 * - if it has a predecessor and the predecessor has size 2, it is merged with the predecessor
 * - if it has a predecessor and the predecessor has size 3, the predecessor's last child is split off and added to the front of the child.
 * - otherwise, it must have a successor. If it has size 2, it is merged with the successor.
 * - otherwise, the successor has size 3. The successor's first child is split off and added to the end of the child.
 */
function deleteFromSubtree(node: InteriorNode, value: string): InteriorNode {
  throw new Error('Not yet implemented');
}

/**
 * If the tree is an interior node, calls deleteFromSubtree on it. Then, if the result is underfull,
 * it uses the sole child node as the new root node.
 */
function delete_(tree: Tree, value: string): Tree {
  throw new Error('Not yet implemented');
}

process.nextTick(() => {
  let tree: Tree = null;
  tree = insert(tree, 'hello');
  assert.deepEqual(tree, 'hello');
  tree = insert(tree, 'world');
  assert.deepEqual(tree, ['hello', 'hello', 'world']);
  tree = insert(tree, 'zzz');
  assert.deepEqual(tree, ['hello', 'hello', 'world', 'world', 'zzz']);
  tree = insert(tree, 'lazy');
  assert.deepEqual(tree, [['hello', 'hello', 'lazy'], 'lazy', ['world', 'world', 'zzz']]);
  tree = insert(tree, 'my');
  assert.deepEqual(tree, [['hello', 'hello', 'lazy'], 'lazy', ['my', 'my', 'world', 'world', 'zzz']]);
  tree = insert(tree, 'sweet');
  assert.deepEqual(tree, [
    ['hello', 'hello', 'lazy'],
    'lazy',
    ['my', 'my', 'sweet'],
    'sweet',
    ['world', 'world', 'zzz'],
  ]);
  tree = insert(tree, 'so');
  assert.deepEqual(tree, [
    ['hello', 'hello', 'lazy'],
    'lazy',
    ['my', 'my', 'so', 'so', 'sweet'],
    'sweet',
    ['world', 'world', 'zzz'],
  ]);
  tree = insert(tree, 'oh');
  assert.deepEqual(tree, [
    [['hello', 'hello', 'lazy'], 'lazy', ['my', 'my', 'oh']],
    'oh',
    [['so', 'so', 'sweet'], 'sweet', ['world', 'world', 'zzz']],
  ]);

  tree = delete_(tree, 'oh');
  assert.deepEqual(tree, [
    ['hello', 'hello', 'lazy', 'lazy', 'my'],
    'oh',
    ['so', 'so', 'sweet'],
    'sweet',
    ['world', 'world', 'zzz'],
  ]);
  tree = delete_(tree, 'so');
  assert.deepEqual(tree, [
    ['hello', 'hello', 'lazy'],
    'lazy',
    ['my', 'oh', 'sweet'],
    'sweet',
    ['world', 'world', 'zzz'],
  ]);
});
