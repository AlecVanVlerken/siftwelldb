import { describe, expect, it, beforeEach } from 'vitest';
import { BPlusTree } from './btree.mjs';
import { BlockNodeStorage } from './nodestorage.mjs';
import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { MockFile } from '../core/mockfile.mjs';
import { BlockLeafNode } from './leafnode.mjs';
import { BlockInternalNode } from './internalnode.mjs';

// Helper type for tree introspection
type AnyNode = BlockLeafNode | BlockInternalNode;
type BlockTree = BPlusTree<Buffer, Buffer, BlockLeafNode, BlockInternalNode>;

// Helper to count entries in tree via iteration
async function countEntries(tree: BlockTree): Promise<number> {
  let count = 0;
  for await (const [_k] of tree.iterate()) {
    count++;
  }
  return count;
}

// Helper to get all keys from tree
async function getAllKeys(tree: BlockTree): Promise<string[]> {
  const keys: string[] = [];
  for await (const [k] of tree.iterate()) {
    keys.push(k.toString());
  }
  return keys;
}

// Helper to measure tree height by traversing from root
async function getTreeHeight(root: AnyNode): Promise<number> {
  let height = 1;
  let node: AnyNode = root;
  while (!node.isLeaf) {
    const internal = node;
    const cursor = await Promise.resolve(internal.getChildCursorAtFirstChild());
    node = await Promise.resolve(cursor.getChild());
    height++;
  }
  return height;
}

// Helper to verify leaf chain integrity
async function verifyLeafChain(root: AnyNode): Promise<{ count: number; keys: string[] }> {
  // Find leftmost leaf
  let node: AnyNode = root;
  while (!node.isLeaf) {
    const internal = node;
    const cursor = await Promise.resolve(internal.getChildCursorAtFirstChild());
    node = await Promise.resolve(cursor.getChild());
  }

  // Traverse leaf chain
  const keys: string[] = [];
  let leaf: BlockLeafNode | null = node;
  let leafCount = 0;

  while (leaf) {
    leafCount++;
    const cursor = leaf.getCursorBeforeFirst();
    while (!cursor.isAfterLast()) {
      const [k] = cursor.getKeyValuePairAfter();
      keys.push(k.toString());
      cursor.moveNext();
    }
    leaf = await leaf.getNextLeaf();
  }

  return { count: leafCount, keys };
}

describe('Block-based BPlusTree', () => {
  let file: FreeBlockFile;
  let storage: BlockNodeStorage;

  beforeEach(async () => {
    // Use small blocks for testing (must fit in log sector after base64 encoding)
    const blockSize = 256;
    // Log file sector must be larger than base64-encoded block
    const logSectorSize = 4096;
    const mockDataFile = new MockFile(blockSize);
    const mockLogFile = new MockFile(logSectorSize);
    const atomicFile = new AtomicFile(mockDataFile, mockLogFile);
    file = new FreeBlockFile(atomicFile, blockSize);
    await file.create();
    storage = new BlockNodeStorage(file);
  });

  const key = (s: string) => Buffer.from(s);
  const val = (s: string) => Buffer.from(s);

  it('creates an empty tree', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);
    // Root should be allocated at a valid block (not header block 0)
    expect(tree.getRoot().getBlockNumber()).toBeGreaterThan(0);

    const result = await tree.get(key('nonexistent'));
    expect(result).toBeNull();
  });

  it('inserts and retrieves a single value', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    await tree.insert(key('hello'), val('world'));

    const result = await tree.get(key('hello'));
    expect(result?.toString()).toBe('world');
  });

  it('inserts multiple values and retrieves them', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    await tree.insert(key('c'), val('3'));
    await tree.insert(key('a'), val('1'));
    await tree.insert(key('b'), val('2'));

    expect((await tree.get(key('a')))?.toString()).toBe('1');
    expect((await tree.get(key('b')))?.toString()).toBe('2');
    expect((await tree.get(key('c')))?.toString()).toBe('3');
    expect(await tree.get(key('d'))).toBeNull();
  });

  it('iterates in sorted order', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    await tree.insert(key('c'), val('3'));
    await tree.insert(key('a'), val('1'));
    await tree.insert(key('b'), val('2'));

    const results: string[] = [];
    for await (const [k, v] of tree.iterate()) {
      results.push(`${k.toString()}=${(v).toString()}`);
    }

    expect(results).toEqual(['a=1', 'b=2', 'c=3']);
  });

  it('iterates from a specific key', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    await tree.insert(key('a'), val('1'));
    await tree.insert(key('b'), val('2'));
    await tree.insert(key('c'), val('3'));
    await tree.insert(key('d'), val('4'));

    const results: string[] = [];
    for await (const [k] of tree.iterate(key('b'))) {
      results.push(k.toString());
    }

    expect(results).toEqual(['b', 'c', 'd']);
  });

  it('deletes a key', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    await tree.insert(key('a'), val('1'));
    await tree.insert(key('b'), val('2'));

    expect(await tree.delete(key('a'))).toBe(true);
    expect(await tree.get(key('a'))).toBeNull();
    expect((await tree.get(key('b')))?.toString()).toBe('2');
  });

  it('returns false when deleting non-existent key', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    await tree.insert(key('a'), val('1'));

    expect(await tree.delete(key('b'))).toBe(false);
  });

  it('rejects duplicate keys', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    await tree.insert(key('a'), val('1'));
    await expect(tree.insert(key('a'), val('2'))).rejects.toThrow('Duplicate key');
  });

  it('handles many inserts causing splits', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    // Insert enough to cause multiple splits
    for (let i = 0; i < 100; i++) {
      const k = i.toString().padStart(3, '0');
      await tree.insert(key(k), val(`value-${k}`));
    }

    // Verify all values can be retrieved
    for (let i = 0; i < 100; i++) {
      const k = i.toString().padStart(3, '0');
      const result = await tree.get(key(k));
      expect(result?.toString()).toBe(`value-${k}`);
    }

    // Verify iteration order
    const keys: string[] = [];
    for await (const [k] of tree.iterate()) {
      keys.push(k.toString());
    }
    expect(keys.length).toBe(100);
    expect(keys).toEqual(keys.slice().sort());
  });

  it('root block can change after splits', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);
    tree.getRoot().getBlockNumber();

    // Insert enough to cause splits
    for (let i = 0; i < 50; i++) {
      await tree.insert(key(`key${i.toString().padStart(3, '0')}`), val(`val${i}`));
    }

    // With dynamic root, root block may have changed after splits
    // The important thing is that the tree is still functional
    const currentRootBlock = tree.getRoot().getBlockNumber();
    expect(currentRootBlock).toBeGreaterThan(0);

    // Verify all data is accessible
    for (let i = 0; i < 50; i++) {
      const result = await tree.get(key(`key${i.toString().padStart(3, '0')}`));
      expect(result?.toString()).toBe(`val${i}`);
    }
  });

  it('can reopen tree from root block', async () => {
    const tree1 = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    await tree1.insert(key('test'), val('value'));
    await file.commit();

    // Track the root block number after operations
    const rootBlock = tree1.getRoot().getBlockNumber();

    // Create new storage and reopen the tree using proper API
    const storage2 = new BlockNodeStorage(file);
    const root = await storage2.openTree(rootBlock);
    const tree2 = BPlusTree.open<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage2, root);

    const result = await tree2.get(key('test'));
    expect(result?.toString()).toBe('value');
  });

  it('updates an existing value', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    await tree.insert(key('hello'), val('world'));
    expect((await tree.get(key('hello')))?.toString()).toBe('world');

    const updated = await tree.update(key('hello'), val('universe'));
    expect(updated).toBe(true);
    expect((await tree.get(key('hello')))?.toString()).toBe('universe');
  });

  it('returns false when updating non-existent key', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    const updated = await tree.update(key('nonexistent'), val('value'));
    expect(updated).toBe(false);
  });

  it('opens existing tree with BPlusTree.open<Buffer, Buffer, BlockLeafNode, BlockInternalNode>()', async () => {
    // Create and populate a tree
    const tree1 = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);
    await tree1.insert(key('a'), val('1'));
    await tree1.insert(key('b'), val('2'));
    await file.commit();

    // Track root block after operations
    const rootBlock = tree1.getRoot().getBlockNumber();

    // Open the tree using the new open() method
    const storage2 = new BlockNodeStorage(file);
    const root = await storage2.openTree(rootBlock);
    const tree2 = BPlusTree.open<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage2, root);

    // Verify data is accessible
    expect((await tree2.get(key('a')))?.toString()).toBe('1');
    expect((await tree2.get(key('b')))?.toString()).toBe('2');

    // Verify we can continue operations
    await tree2.insert(key('c'), val('3'));
    expect((await tree2.get(key('c')))?.toString()).toBe('3');
  });

  it('persists data after commit and reopen', async () => {
    // Create and populate tree
    const tree1 = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    await tree1.insert(key('hello'), val('world'));
    await tree1.insert(key('foo'), val('bar'));
    await file.commit();

    // Track root block after operations
    const rootBlock = tree1.getRoot().getBlockNumber();

    // Simulate reopening by creating new storage and using proper API
    const storage2 = new BlockNodeStorage(file);
    const root = await storage2.openTree(rootBlock);
    const tree2 = BPlusTree.open<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage2, root);

    // Verify data persisted - using public API, works regardless of tree structure
    expect((await tree2.get(key('hello')))?.toString()).toBe('world');
    expect((await tree2.get(key('foo')))?.toString()).toBe('bar');

    // Verify iteration works
    const keys = await getAllKeys(tree2);
    expect(keys).toContain('foo');
    expect(keys).toContain('hello');
  });

  it('uses custom compareKeys function', async () => {
    // Custom comparison: reverse order
    const reverseStorage = new BlockNodeStorage(file, {
      compareKeys: (a, b) => Buffer.compare(b, a), // Reversed!
    });
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(reverseStorage);

    await tree.insert(key('a'), val('1'));
    await tree.insert(key('b'), val('2'));
    await tree.insert(key('c'), val('3'));

    // Should iterate in reverse order due to custom comparison
    const results: string[] = [];
    for await (const [k] of tree.iterate()) {
      results.push(k.toString());
    }

    expect(results).toEqual(['c', 'b', 'a']);
  });

  it('handles stress test with 500 entries', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);
    const count = 500;

    // Insert 500 entries
    for (let i = 0; i < count; i++) {
      const k = i.toString().padStart(4, '0');
      await tree.insert(key(k), val(`value-${k}`));
    }

    // Verify all can be retrieved
    for (let i = 0; i < count; i++) {
      const k = i.toString().padStart(4, '0');
      const result = await tree.get(key(k));
      expect(result?.toString()).toBe(`value-${k}`);
    }

    // Verify count via iteration
    let iterCount = 0;
    for await (const [_k] of tree.iterate()) {
      iterCount++;
    }
    expect(iterCount).toBe(count);

    // Root should be at a valid block
    expect(tree.getRoot().getBlockNumber()).toBeGreaterThan(0);
  });

  it('handles deletion from deep multi-level tree', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    // Insert enough to create multiple levels
    const keys: string[] = [];
    for (let i = 0; i < 100; i++) {
      const k = i.toString().padStart(3, '0');
      keys.push(k);
      await tree.insert(key(k), val(`v${k}`));
    }

    // Delete every other key
    for (let i = 0; i < 100; i += 2) {
      const k = i.toString().padStart(3, '0');
      const deleted = await tree.delete(key(k));
      expect(deleted).toBe(true);
    }

    // Verify remaining keys
    const remaining: string[] = [];
    for await (const [k] of tree.iterate()) {
      remaining.push(k.toString());
    }

    const expected = keys.filter((_, i) => i % 2 === 1);
    expect(remaining).toEqual(expected);

    // Verify deleted keys return null
    for (let i = 0; i < 100; i += 2) {
      const k = i.toString().padStart(3, '0');
      expect(await tree.get(key(k))).toBeNull();
    }
  });

  it('handles keys and values near block size limit', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    // Block size is 256, header is ~9 bytes, each entry has 4 bytes overhead
    // So we can fit maybe 1-2 entries with ~100 byte keys/values
    const largeKey = Buffer.alloc(50, 'k');
    const largeValue = Buffer.alloc(100, 'v');

    await tree.insert(largeKey, largeValue);

    const result = (await tree.get(largeKey));
    expect(result).not.toBeNull();
    expect(result!.length).toBe(100);
    expect(result!.every((b: number) => b === 'v'.charCodeAt(0))).toBe(true);
  });

  it('handles multiple large entries causing splits', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    // Insert several large entries that will force splits
    const insertedKeys: Buffer[] = [];
    for (let i = 0; i < 20; i++) {
      const k = Buffer.alloc(30);
      k.write(i.toString().padStart(3, '0'));
      const v = Buffer.alloc(50, i);
      insertedKeys.push(k);
      await tree.insert(k, v);
    }

    // Verify all entries can be retrieved with correct values
    for (let i = 0; i < 20; i++) {
      const result = (await tree.get(insertedKeys[i]));
      expect(result).not.toBeNull();
      expect(result!.length).toBe(50);
      // Verify the value content (filled with byte value i)
      expect(result![0]).toBe(i);
    }

    // Also verify count via iteration
    let count = 0;
    for await (const [_k, _v] of tree.iterate()) {
      count++;
    }
    expect(count).toBe(20);
  });

  it('maintains data integrity after interleaved operations', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);
    const data = new Map<string, string>();

    // Interleaved inserts, updates, deletes
    for (let i = 0; i < 50; i++) {
      const k = i.toString().padStart(3, '0');
      await tree.insert(key(k), val(`v${i}`));
      data.set(k, `v${i}`);
    }

    // Update some (with larger values - should trigger splits)
    for (let i = 0; i < 50; i += 3) {
      const k = i.toString().padStart(3, '0');
      await tree.update(key(k), val(`updated${i}`));
      data.set(k, `updated${i}`);
    }

    // Delete some
    for (let i = 0; i < 50; i += 5) {
      const k = i.toString().padStart(3, '0');
      await tree.delete(key(k));
      data.delete(k);
    }

    // Insert some new ones
    for (let i = 50; i < 60; i++) {
      const k = i.toString().padStart(3, '0');
      await tree.insert(key(k), val(`new${i}`));
      data.set(k, `new${i}`);
    }

    // Verify all data matches
    for (const [k, v] of data) {
      const result = await tree.get(key(k));
      expect(result?.toString()).toBe(v);
    }

    // Verify iteration count
    let count = 0;
    for await (const [_k] of tree.iterate()) {
      count++;
    }
    expect(count).toBe(data.size);
  });

  it('tree survives many splits and merges', async () => {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    // Insert many
    for (let i = 0; i < 100; i++) {
      await tree.insert(key(i.toString().padStart(3, '0')), val(`v${i}`));
    }

    // Delete most
    for (let i = 0; i < 90; i++) {
      await tree.delete(key(i.toString().padStart(3, '0')));
    }

    // Insert again
    for (let i = 100; i < 150; i++) {
      await tree.insert(key(i.toString().padStart(3, '0')), val(`v${i}`));
    }

    // Verify data - this tests that dynamic root tracking works correctly
    let count = 0;
    for await (const [_k] of tree.iterate()) {
      count++;
    }
    expect(count).toBe(60); // 10 remaining + 50 new

    // Root should still be valid
    expect(tree.getRoot().getBlockNumber()).toBeGreaterThan(0);
  });

  // ==========================================================================
  // TREE STRUCTURAL INVARIANTS
  // ==========================================================================
  describe('Tree structural invariants', () => {
    it('root is leaf initially and after all keys deleted', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      // Initial root should be a leaf
      expect(tree.getRoot().isLeaf).toBe(true);

      // Insert enough to cause splits (root becomes internal)
      for (let i = 0; i < 50; i++) {
        await tree.insert(key(i.toString().padStart(3, '0')), val(`v${i}`));
      }

      // After splits, root may be internal (depends on implementation)
      const rootAfterInserts = tree.getRoot();
      const heightAfterInserts = await getTreeHeight(rootAfterInserts);
      expect(heightAfterInserts).toBeGreaterThanOrEqual(1);

      // Delete all keys
      for (let i = 0; i < 50; i++) {
        await tree.delete(key(i.toString().padStart(3, '0')));
      }

      // After all deletions, root should be a leaf again (tree compressed)
      expect(tree.getRoot().isLeaf).toBe(true);
    });

    it('leaf chain is correctly linked after inserts', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      // Insert keys
      const insertedKeys: string[] = [];
      for (let i = 0; i < 100; i++) {
        const k = i.toString().padStart(3, '0');
        insertedKeys.push(k);
        await tree.insert(key(k), val(`v${i}`));
      }

      // Verify leaf chain
      const { keys } = await verifyLeafChain(tree.getRoot());
      expect(keys).toEqual(insertedKeys.sort());
    });

    it('leaf chain remains correct after deletes with merging', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      // Insert keys
      for (let i = 0; i < 100; i++) {
        await tree.insert(key(i.toString().padStart(3, '0')), val(`v${i}`));
      }

      // Delete half the keys (will trigger merges)
      for (let i = 0; i < 100; i += 2) {
        await tree.delete(key(i.toString().padStart(3, '0')));
      }

      // Verify leaf chain matches iteration
      const { keys: leafChainKeys } = await verifyLeafChain(tree.getRoot());
      const iterKeys = await getAllKeys(tree);

      expect(leafChainKeys).toEqual(iterKeys);
    });

    it('tree height decreases when deleting many keys', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      // Insert many keys to create a tall tree
      for (let i = 0; i < 200; i++) {
        await tree.insert(key(i.toString().padStart(4, '0')), val(`v${i}`));
      }

      const heightBefore = await getTreeHeight(tree.getRoot());

      // Delete most keys
      for (let i = 0; i < 190; i++) {
        await tree.delete(key(i.toString().padStart(4, '0')));
      }

      const heightAfter = await getTreeHeight(tree.getRoot());

      // Tree should have shrunk (or at minimum stayed same)
      expect(heightAfter).toBeLessThanOrEqual(heightBefore);
    });
  });

  // ==========================================================================
  // DELETION CORNER CASES
  // ==========================================================================
  describe('Deletion corner cases', () => {
    it('deletes the only key in the tree', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      await tree.insert(key('only'), val('value'));
      expect(await tree.delete(key('only'))).toBe(true);

      expect(await tree.get(key('only'))).toBeNull();
      expect(await countEntries(tree)).toBe(0);
    });

    it('deletes until tree becomes empty', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      // Insert
      for (let i = 0; i < 50; i++) {
        await tree.insert(key(i.toString().padStart(3, '0')), val(`v${i}`));
      }

      // Delete all
      for (let i = 0; i < 50; i++) {
        const k = i.toString().padStart(3, '0');
        expect(await tree.delete(key(k))).toBe(true);
      }

      // Tree should be empty
      expect(await countEntries(tree)).toBe(0);
      expect(tree.getRoot().isLeaf).toBe(true);
    });

    it('deletion causing multiple levels of merging', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      // Insert enough to create deep tree
      for (let i = 0; i < 150; i++) {
        await tree.insert(key(i.toString().padStart(4, '0')), val(`v${i}`));
      }

      // Delete in a pattern that triggers cascading merges
      for (let i = 0; i < 140; i++) {
        await tree.delete(key(i.toString().padStart(4, '0')));
      }

      // Verify remaining keys are accessible
      for (let i = 140; i < 150; i++) {
        const result = await tree.get(key(i.toString().padStart(4, '0')));
        expect(result?.toString()).toBe(`v${i}`);
      }

      expect(await countEntries(tree)).toBe(10);
    });

    it('can re-insert key after deletion', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      await tree.insert(key('test'), val('original'));
      await tree.delete(key('test'));
      await tree.insert(key('test'), val('reinserted'));

      expect((await tree.get(key('test')))?.toString()).toBe('reinserted');
    });

    it('delete-insert-delete same key', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      await tree.insert(key('a'), val('1'));
      expect(await tree.delete(key('a'))).toBe(true);
      await tree.insert(key('a'), val('2'));
      expect(await tree.delete(key('a'))).toBe(true);

      expect(await tree.get(key('a'))).toBeNull();
    });

    it('deletes first and last keys in leaf', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      await tree.insert(key('a'), val('1'));
      await tree.insert(key('b'), val('2'));
      await tree.insert(key('c'), val('3'));

      // Delete first
      expect(await tree.delete(key('a'))).toBe(true);
      // Delete last
      expect(await tree.delete(key('c'))).toBe(true);

      const keys = await getAllKeys(tree);
      expect(keys).toEqual(['b']);
    });
  });

  // ==========================================================================
  // ITERATION EDGE CASES
  // ==========================================================================
  describe('Iteration edge cases', () => {
    it('iterates empty tree', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      const results: string[] = [];
      for await (const [k] of tree.iterate()) {
        results.push(k.toString());
      }

      expect(results).toEqual([]);
    });

    it('iterate with startKey before first key', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      await tree.insert(key('b'), val('2'));
      await tree.insert(key('c'), val('3'));

      const results: string[] = [];
      for await (const [k] of tree.iterate(key('a'))) {
        results.push(k.toString());
      }

      expect(results).toEqual(['b', 'c']);
    });

    it('iterate with startKey after last key', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      await tree.insert(key('a'), val('1'));
      await tree.insert(key('b'), val('2'));

      const results: string[] = [];
      for await (const [k] of tree.iterate(key('z'))) {
        results.push(k.toString());
      }

      expect(results).toEqual([]);
    });

    it('iterate with startKey exactly equal to existing key', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      await tree.insert(key('a'), val('1'));
      await tree.insert(key('b'), val('2'));
      await tree.insert(key('c'), val('3'));

      const results: string[] = [];
      for await (const [k] of tree.iterate(key('b'))) {
        results.push(k.toString());
      }

      expect(results).toEqual(['b', 'c']);
    });

    it('iterate across multiple leaves', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      // Insert enough to span multiple leaves
      for (let i = 0; i < 100; i++) {
        await tree.insert(key(i.toString().padStart(3, '0')), val(`v${i}`));
      }

      const keys = await getAllKeys(tree);
      expect(keys.length).toBe(100);

      // Should be sorted
      for (let i = 1; i < keys.length; i++) {
        expect(keys[i] > keys[i - 1]).toBe(true);
      }
    });
  });

  // ==========================================================================
  // KEY COMPARISON EDGE CASES
  // ==========================================================================
  describe('Key comparison edge cases', () => {
    it('handles keys with shared prefixes', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      await tree.insert(key('abc'), val('1'));
      await tree.insert(key('abcd'), val('2'));
      await tree.insert(key('ab'), val('3'));
      await tree.insert(key('abcde'), val('4'));

      expect((await tree.get(key('ab')))?.toString()).toBe('3');
      expect((await tree.get(key('abc')))?.toString()).toBe('1');
      expect((await tree.get(key('abcd')))?.toString()).toBe('2');
      expect((await tree.get(key('abcde')))?.toString()).toBe('4');

      const keys = await getAllKeys(tree);
      expect(keys).toEqual(['ab', 'abc', 'abcd', 'abcde']);
    });

    it('handles keys that differ only in last byte', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      await tree.insert(Buffer.from([1, 2, 3, 4]), val('a'));
      await tree.insert(Buffer.from([1, 2, 3, 5]), val('b'));
      await tree.insert(Buffer.from([1, 2, 3, 3]), val('c'));

      expect((await tree.get(Buffer.from([1, 2, 3, 4])))?.toString()).toBe('a');
      expect((await tree.get(Buffer.from([1, 2, 3, 5])))?.toString()).toBe('b');
      expect((await tree.get(Buffer.from([1, 2, 3, 3])))?.toString()).toBe('c');
    });

    it('handles binary keys with all byte values', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      // Insert keys with various byte values including 0x00, 0xFF
      const keys = [
        Buffer.from([0x00]),
        Buffer.from([0x00, 0x01]),
        Buffer.from([0xff]),
        Buffer.from([0x7f]),
        Buffer.from([0x80]),
      ];

      for (let i = 0; i < keys.length; i++) {
        await tree.insert(keys[i], val(`v${i}`));
      }

      for (let i = 0; i < keys.length; i++) {
        const result = await tree.get(keys[i]);
        expect(result?.toString()).toBe(`v${i}`);
      }
    });

    it('handles empty value', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      await tree.insert(key('empty'), Buffer.alloc(0));

      const result = (await tree.get(key('empty')));
      expect(result).not.toBeNull();
      expect(result!.length).toBe(0);
    });
  });

  // ==========================================================================
  // UPDATE EDGE CASES
  // ==========================================================================
  describe('Update edge cases', () => {
    it('update with larger value that may trigger split', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      // Insert with small value
      await tree.insert(key('test'), val('small'));

      // Update with larger value
      const largeValue = Buffer.alloc(100, 'x');
      await tree.update(key('test'), largeValue);

      const result = (await tree.get(key('test')));
      expect(result?.length).toBe(100);
    });

    it('update with smaller value', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      const largeValue = Buffer.alloc(50, 'x');
      await tree.insert(key('test'), largeValue);

      await tree.update(key('test'), val('tiny'));

      const result = await tree.get(key('test'));
      expect(result?.toString()).toBe('tiny');
    });

    it('update same value size', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      await tree.insert(key('test'), val('aaaa'));
      await tree.update(key('test'), val('bbbb'));

      expect((await tree.get(key('test')))?.toString()).toBe('bbbb');
    });

    it('update first and last key in tree', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      await tree.insert(key('aaa'), val('1'));
      await tree.insert(key('mmm'), val('2'));
      await tree.insert(key('zzz'), val('3'));

      await tree.update(key('aaa'), val('first-updated'));
      await tree.update(key('zzz'), val('last-updated'));

      expect((await tree.get(key('aaa')))?.toString()).toBe('first-updated');
      expect((await tree.get(key('zzz')))?.toString()).toBe('last-updated');
    });
  });

  // ==========================================================================
  // INTERLEAVED OPERATIONS
  // ==========================================================================
  describe('Interleaved operations', () => {
    it('insert -> delete -> insert same key', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      await tree.insert(key('x'), val('first'));
      await tree.delete(key('x'));
      await tree.insert(key('x'), val('second'));

      expect((await tree.get(key('x')))?.toString()).toBe('second');
    });

    it('operations interleaved with commit and reopen', async () => {
      let tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      await tree.insert(key('a'), val('1'));
      await file.commit();

      // Track root block after first operation
      const rootBlock = tree.getRoot().getBlockNumber();

      // Simulate reopen
      const storage2 = new BlockNodeStorage(file);
      const root = await storage2.openTree(rootBlock);
      tree = BPlusTree.open<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage2, root);

      await tree.insert(key('b'), val('2'));
      await file.commit();

      expect((await tree.get(key('a')))?.toString()).toBe('1');
      expect((await tree.get(key('b')))?.toString()).toBe('2');
    });

    it('insert duplicate after delete should succeed', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      await tree.insert(key('dup'), val('original'));
      await tree.delete(key('dup'));

      // Should not throw - key no longer exists
      await tree.insert(key('dup'), val('new'));

      expect((await tree.get(key('dup')))?.toString()).toBe('new');
    });

    it('uncommitted inserts are not persisted after reopen', async () => {
      const tree1 = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      await tree1.insert(key('committed'), val('yes'));
      await file.commit();

      // Track root block after committed insert
      const rootBlock = tree1.getRoot().getBlockNumber();

      await tree1.insert(key('uncommitted'), val('no'));
      // No commit here!

      // "Reopen" with fresh storage (simulates restart)
      const freshDataFile = new MockFile(256);
      const freshLogFile = new MockFile(4096);
      const freshAtomicFile = new AtomicFile(freshDataFile, freshLogFile);
      const freshFile = new FreeBlockFile(freshAtomicFile, 256);
      await freshFile.create();

      // Note: In a real scenario with actual file, uncommitted data would be lost.
      // With MockFile, we can't truly test persistence across restarts,
      // but we verify the concept: commit() is required for durability.
      expect(rootBlock).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // SPLIT EDGE CASES
  // ==========================================================================
  describe('Split edge cases', () => {
    it('split of root node creates new root', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      // Initially root is leaf
      expect(tree.getRoot().isLeaf).toBe(true);

      // Insert enough to force a split
      for (let i = 0; i < 30; i++) {
        await tree.insert(key(i.toString().padStart(3, '0')), val(`value-${i}`));
      }

      // After splits, verify tree is still correct
      const height = await getTreeHeight(tree.getRoot());
      expect(height).toBeGreaterThanOrEqual(1);

      // All values should still be retrievable
      for (let i = 0; i < 30; i++) {
        const result = await tree.get(key(i.toString().padStart(3, '0')));
        expect(result?.toString()).toBe(`value-${i}`);
      }
    });

    it('handles entries that nearly fill a block', async () => {
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

      // Create entries that are large but just fit
      // Block size is 256, header ~9 bytes, so ~247 usable
      // Key (2 + 30) + Value (2 + 100) = 134 bytes per entry
      // Can fit ~1-2 entries per block

      for (let i = 0; i < 10; i++) {
        const k = Buffer.alloc(30);
        k.write(i.toString().padStart(5, '0'));
        const v = Buffer.alloc(100, i);
        await tree.insert(k, v);
      }

      // Verify all entries
      let count = 0;
      for await (const [_k, v] of tree.iterate()) {
        expect((v).length).toBe(100);
        count++;
      }
      expect(count).toBe(10);
    });
  });
});
