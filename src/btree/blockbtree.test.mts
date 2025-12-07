import { describe, expect, it, beforeEach } from 'vitest';
import { BPlusTree } from './btree.mjs';
import { BlockNodeStorage } from './nodestorage.mjs';
import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { MockFile } from '../core/mockfile.mjs';

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
    await file.open();
    storage = new BlockNodeStorage(file);
  });

  const key = (s: string) => Buffer.from(s);
  const val = (s: string) => Buffer.from(s);

  it('creates an empty tree', async () => {
    const tree = await BPlusTree.create(storage);
    expect(storage.getStableRootBlock()).toBeGreaterThan(0);

    const result = await tree.get(key('nonexistent'));
    expect(result).toBeNull();
  });

  it('inserts and retrieves a single value', async () => {
    const tree = await BPlusTree.create(storage);

    await tree.insert(key('hello'), val('world'));

    const result = await tree.get(key('hello'));
    expect(result?.toString()).toBe('world');
  });

  it('inserts multiple values and retrieves them', async () => {
    const tree = await BPlusTree.create(storage);

    await tree.insert(key('c'), val('3'));
    await tree.insert(key('a'), val('1'));
    await tree.insert(key('b'), val('2'));

    expect((await tree.get(key('a')))?.toString()).toBe('1');
    expect((await tree.get(key('b')))?.toString()).toBe('2');
    expect((await tree.get(key('c')))?.toString()).toBe('3');
    expect(await tree.get(key('d'))).toBeNull();
  });

  it('iterates in sorted order', async () => {
    const tree = await BPlusTree.create(storage);

    await tree.insert(key('c'), val('3'));
    await tree.insert(key('a'), val('1'));
    await tree.insert(key('b'), val('2'));

    const results: string[] = [];
    for await (const [k, v] of tree.iterate()) {
      results.push(`${k.toString()}=${(v as Buffer).toString()}`);
    }

    expect(results).toEqual(['a=1', 'b=2', 'c=3']);
  });

  it('iterates from a specific key', async () => {
    const tree = await BPlusTree.create(storage);

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
    const tree = await BPlusTree.create(storage);

    await tree.insert(key('a'), val('1'));
    await tree.insert(key('b'), val('2'));

    expect(await tree.delete(key('a'))).toBe(true);
    expect(await tree.get(key('a'))).toBeNull();
    expect((await tree.get(key('b')))?.toString()).toBe('2');
  });

  it('returns false when deleting non-existent key', async () => {
    const tree = await BPlusTree.create(storage);

    await tree.insert(key('a'), val('1'));

    expect(await tree.delete(key('b'))).toBe(false);
  });

  it('rejects duplicate keys', async () => {
    const tree = await BPlusTree.create(storage);

    await tree.insert(key('a'), val('1'));
    await expect(tree.insert(key('a'), val('2'))).rejects.toThrow('Duplicate key');
  });

  it('handles many inserts causing splits', async () => {
    const tree = await BPlusTree.create(storage);

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

  it('maintains stable root block across splits', async () => {
    const tree = await BPlusTree.create(storage);
    const rootBlock = storage.getStableRootBlock();

    // Insert enough to cause splits
    for (let i = 0; i < 50; i++) {
      await tree.insert(key(`key${i.toString().padStart(3, '0')}`), val(`val${i}`));
    }

    // Root block should not have changed
    expect(storage.getStableRootBlock()).toBe(rootBlock);
  });

  it('can reopen tree from root block', async () => {
    const tree1 = await BPlusTree.create(storage);
    const rootBlock = storage.getStableRootBlock();

    await tree1.insert(key('test'), val('value'));
    await file.commit();

    // Create new storage and reopen the tree
    const storage2 = new BlockNodeStorage(file);
    const root = await storage2.openTree(rootBlock);
    const tree2 = await BPlusTree.create(storage2);
    // Replace root with opened root
    (tree2 as unknown as { root: typeof root }).root = root;

    const result = await tree2.get(key('test'));
    expect(result?.toString()).toBe('value');
  });

  it('updates an existing value', async () => {
    const tree = await BPlusTree.create(storage);

    await tree.insert(key('hello'), val('world'));
    expect((await tree.get(key('hello')))?.toString()).toBe('world');

    const updated = await tree.update(key('hello'), val('universe'));
    expect(updated).toBe(true);
    expect((await tree.get(key('hello')))?.toString()).toBe('universe');
  });

  it('returns false when updating non-existent key', async () => {
    const tree = await BPlusTree.create(storage);

    const updated = await tree.update(key('nonexistent'), val('value'));
    expect(updated).toBe(false);
  });

  it('opens existing tree with BPlusTree.open()', async () => {
    // Create and populate a tree
    const tree1 = await BPlusTree.create(storage);
    await tree1.insert(key('a'), val('1'));
    await tree1.insert(key('b'), val('2'));
    await file.commit();

    const rootBlock = storage.getStableRootBlock();

    // Open the tree using the new open() method
    const storage2 = new BlockNodeStorage(file);
    const root = await storage2.openTree(rootBlock);
    const tree2 = BPlusTree.open(storage2, root);

    // Verify data is accessible
    expect((await tree2.get(key('a')))?.toString()).toBe('1');
    expect((await tree2.get(key('b')))?.toString()).toBe('2');

    // Verify we can continue operations
    await tree2.insert(key('c'), val('3'));
    expect((await tree2.get(key('c')))?.toString()).toBe('3');
  });

  it('persists data after commit and reopen', async () => {
    // Create and populate tree
    const tree1 = await BPlusTree.create(storage);
    const rootBlock = storage.getStableRootBlock();

    await tree1.insert(key('hello'), val('world'));
    await tree1.insert(key('foo'), val('bar'));
    await file.commit();

    // Simulate reopening by creating new storage
    const storage2 = new BlockNodeStorage(file);
    const root = await storage2.openTree(rootBlock);

    // Manually test the root node
    if (root.isLeaf) {
      const cursor = root.getCursorBeforeFirst();
      const entries: string[] = [];
      while (!cursor.isAfterLast()) {
        cursor.moveNext();
        if (!cursor.isAfterLast()) {
          const [k, v] = cursor.getKeyValuePairAfter();
          entries.push(`${k.toString()}=${v.toString()}`);
        }
      }
      // Tree should have data
      expect(entries.length).toBeGreaterThan(0);
    }
  });

  it('uses custom compareKeys function', async () => {
    // Custom comparison: reverse order
    const reverseStorage = new BlockNodeStorage(file, {
      compareKeys: (a, b) => Buffer.compare(b, a), // Reversed!
    });
    const tree = await BPlusTree.create(reverseStorage);

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
    const tree = await BPlusTree.create(storage);
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

    // Root should still be stable
    expect(storage.getStableRootBlock()).toBeGreaterThan(0);
  });

  it('handles deletion from deep multi-level tree', async () => {
    const tree = await BPlusTree.create(storage);

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
    const tree = await BPlusTree.create(storage);

    // Block size is 256, header is ~9 bytes, each entry has 4 bytes overhead
    // So we can fit maybe 1-2 entries with ~100 byte keys/values
    const largeKey = Buffer.alloc(50, 'k');
    const largeValue = Buffer.alloc(100, 'v');

    await tree.insert(largeKey, largeValue);

    const result = await tree.get(largeKey);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(100);
    expect((result as Buffer).every((b: number) => b === 'v'.charCodeAt(0))).toBe(true);
  });

  it('handles multiple large entries causing splits', async () => {
    const tree = await BPlusTree.create(storage);

    // Insert several large entries that will force splits
    for (let i = 0; i < 20; i++) {
      const k = Buffer.alloc(30);
      k.write(i.toString().padStart(3, '0'));
      const v = Buffer.alloc(50, i);
      await tree.insert(k, v);
    }

    // Verify all entries
    let count = 0;
    for await (const [_k, _v] of tree.iterate()) {
      count++;
    }
    expect(count).toBe(20);
  });

  it('maintains data integrity after interleaved operations', async () => {
    const tree = await BPlusTree.create(storage);
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

  it('stable root survives many splits and merges', async () => {
    const tree = await BPlusTree.create(storage);
    const rootBlock = storage.getStableRootBlock();

    // Insert many
    for (let i = 0; i < 100; i++) {
      await tree.insert(key(i.toString().padStart(3, '0')), val(`v${i}`));
    }
    expect(storage.getStableRootBlock()).toBe(rootBlock);

    // Delete most
    for (let i = 0; i < 90; i++) {
      await tree.delete(key(i.toString().padStart(3, '0')));
    }
    expect(storage.getStableRootBlock()).toBe(rootBlock);

    // Insert again
    for (let i = 100; i < 150; i++) {
      await tree.insert(key(i.toString().padStart(3, '0')), val(`v${i}`));
    }
    expect(storage.getStableRootBlock()).toBe(rootBlock);

    // Verify data
    let count = 0;
    for await (const [_k] of tree.iterate()) {
      count++;
    }
    expect(count).toBe(60); // 10 remaining + 50 new
  });
});
