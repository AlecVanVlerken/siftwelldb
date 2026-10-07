import { describe, expect, it } from 'vitest';
import { BPlusTree } from '../btree.mjs';
import { NodeStorageImpl } from '../nodestorage.mjs';
import { LeafNodeImpl } from '../leafnode.mjs';
import { InternalNodeImpl } from '../internalnode.mjs';

const compareNumbers = (a: number, b: number) => a - b;

// Helper to create in-memory tree with options
async function createTree<K, V>(options: {
  compareKeys?: (a: K, b: K) => number;
  maxLeafEntries?: number;
  maxChildren?: number;
}) {
  const storage = new NodeStorageImpl<K, V>(options);
  return BPlusTree.create(storage);
}

describe('BPlusTree', () => {
  it('inserts and retrieves values', async () => {
    const tree = await createTree<number, string>({
      maxLeafEntries: 4,
      maxChildren: 4,
    });
    await tree.insert(3, 'three');
    await tree.insert(1, 'one');
    await tree.insert(2, 'two');
    await tree.insert(5, 'five');

    expect(await tree.get(1)).toBe('one');
    expect(await tree.get(3)).toBe('three');
    expect(await tree.get(5)).toBe('five');
    expect(await tree.get(4)).toBeNull();
  });

  it('iterates keys in order starting from a specific key', async () => {
    const tree = await createTree<number, number>({
      maxLeafEntries: 4,
      maxChildren: 4,
    });
    const keys = [10, 5, 8, 12, 2, 15];
    for (const key of keys) {
      await tree.insert(key, key * 10);
    }

    const iterated: number[] = [];
    for await (const [key] of tree.iterate(8)) {
      iterated.push(key);
    }
    expect(iterated).toEqual([8, 10, 12, 15]);
  });

  it('deletes keys and collapses the tree when empty', async () => {
    const tree = await createTree<number, string>({
      maxLeafEntries: 3,
      maxChildren: 3,
    });
    const values = [
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
      [4, 'd'],
    ] as const;
    for (const [key, value] of values) {
      await tree.insert(key, value);
    }

    expect(await tree.delete(2)).toBe(true);
    expect(await tree.get(2)).toBeNull();
    expect(await tree.delete(42)).toBe(false);

    await tree.delete(1);
    await tree.delete(3);
    await tree.delete(4);

    const allKeys: number[] = [];
    for await (const [key] of tree.iterate()) {
      allKeys.push(key);
    }
    expect(allKeys).toEqual([]);

    await tree.insert(7, 'g');
    expect(await tree.get(7)).toBe('g');
  });

  it('rejects duplicate keys', async () => {
    const tree = await createTree<number, string>({
      maxLeafEntries: 3,
      maxChildren: 3,
    });
    await tree.insert(1, 'one');
    await expect(tree.insert(1, 'uno')).rejects.toThrow(/Duplicate keys/);
  });

  it('updates an existing value', async () => {
    const tree = await createTree<number, string>({
      maxLeafEntries: 3,
      maxChildren: 3,
    });
    await tree.insert(1, 'one');
    expect(await tree.get(1)).toBe('one');

    const updated = await tree.update(1, 'ONE');
    expect(updated).toBe(true);
    expect(await tree.get(1)).toBe('ONE');
  });

  it('returns false when updating non-existent key', async () => {
    const tree = await createTree<number, string>({
      maxLeafEntries: 3,
      maxChildren: 3,
    });
    const updated = await tree.update(999, 'value');
    expect(updated).toBe(false);
  });

  it('maintains order for large sequential inserts', async () => {
    const tree = await createTree<number, number>({
      maxLeafEntries: 4,
      maxChildren: 4,
    });
    const count = 50;
    for (let i = 0; i < count; i++) {
      await tree.insert(i, i);
    }
    const keys: number[] = [];
    for await (const [key] of tree.iterate()) {
      keys.push(key);
    }
    expect(keys).toEqual([...Array(count).keys()]);
  });

  it('rebalances parents after mixed deletions', async () => {
    const tree = await createTree<number, string>({
      maxLeafEntries: 3,
      maxChildren: 3,
    });
    const keys = [10, 20, 30, 40, 50, 60, 70, 80];
    for (const key of keys) {
      await tree.insert(key, `${key}`);
    }
    for (const key of [25, 30, 40, 10, 80]) {
      // some keys may not exist (25) to ensure false is returned
      await tree.delete(key);
    }
    const remaining: number[] = [];
    for await (const [key] of tree.iterate()) {
      remaining.push(key);
    }
    expect(remaining).toEqual([20, 50, 60, 70]);
  });

  it('iterates entire tree when no start key is provided', async () => {
    const tree = await createTree<number, number>({
      maxLeafEntries: 4,
      maxChildren: 4,
    });
    const values = [5, 2, 9, 1];
    for (const v of values) {
      await tree.insert(v, v);
    }
    const iterated: number[] = [];
    for await (const [key] of tree.iterate()) {
      iterated.push(key);
    }
    expect(iterated).toEqual([1, 2, 5, 9]);
  });

  it('never exceeds configured max occupancies', async () => {
    const maxLeafEntries = 2;
    const maxChildren = 3;
    const tree = await createTree<number, number>({
      maxLeafEntries,
      maxChildren,
    });
    for (let i = 0; i < 30; i++) {
      await tree.insert(i, i);
    }
    for (let i = 0; i < 30; i += 2) {
      await tree.delete(i);
    }
    const queue: (LeafNodeImpl<number, number> | InternalNodeImpl<number, number>)[] = [tree.getRoot()];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (node.isLeaf) {
        expect(node.getEntryCount()).toBeLessThanOrEqual(maxLeafEntries);
      } else {
        const internal = node;
        expect(internal.childCount()).toBeLessThanOrEqual(maxChildren);
        for (let i = 0; i < internal.childCount(); i++) {
          queue.push(internal.getChildAt(i));
        }
      }
    }
  });

  it('splits root correctly when leaf overflows', async () => {
    const tree = await createTree<number, number>({
      compareKeys: compareNumbers,
      maxLeafEntries: 2,
      maxChildren: 3,
    });
    await tree.insert(1, 10);
    await tree.insert(2, 20);
    await tree.insert(3, 30); // triggers split
    const keys: number[] = [];
    for await (const [key] of tree.iterate()) keys.push(key);
    expect(keys).toEqual([1, 2, 3]);
    expect(tree.getRoot().isLeaf).toBe(false); // new root should be internal
  });
});

describe('BPlusTree – rigorous missing tests', () => {
  it('compresses root correctly after deletions', async () => {
    const tree = await createTree<number, number>({
      compareKeys: compareNumbers,
      maxLeafEntries: 2,
      maxChildren: 3,
    });

    // Insert enough keys to create a multi-level tree
    for (const k of [1, 2, 3, 4, 5]) await tree.insert(k, k);

    // Delete keys until only one key remains in the tree
    await tree.delete(1);
    await tree.delete(2);
    await tree.delete(3);
    await tree.delete(4);

    // Only key 5 should remain
    const keys: number[] = [];
    for await (const [key] of tree.iterate()) keys.push(key);
    expect(keys).toEqual([5]);

    // Now root should be a leaf, because compressRootIfPossible triggers
    expect(tree.getRoot().isLeaf).toBe(true);

    // Verify that get works for remaining key
    expect(await tree.get(5)).toBe(5);
  });

  it('creates new root when tree becomes empty', async () => {
    const tree = await createTree<number, number>({
      compareKeys: compareNumbers,
      maxLeafEntries: 2,
      maxChildren: 3,
    });
    await tree.insert(1, 10);
    await tree.delete(1);
    const keys: number[] = [];
    for await (const [key] of tree.iterate()) keys.push(key);
    expect(keys).toEqual([]);
    // Root should be a leaf
    expect(tree.getRoot().isLeaf).toBe(true);
  });

  it('iteration from a non-existent key yields next higher key', async () => {
    const tree = await createTree<number, number>({
      compareKeys: compareNumbers,
      maxLeafEntries: 4,
      maxChildren: 4,
    });
    for (const k of [10, 20, 30]) await tree.insert(k, k);
    const iterated: number[] = [];
    for await (const [key] of tree.iterate(15)) iterated.push(key);
    expect(iterated).toEqual([20, 30]);
  });

  it('iteration starting before first key yields all keys', async () => {
    const tree = await createTree<number, number>({
      compareKeys: compareNumbers,
      maxLeafEntries: 4,
      maxChildren: 4,
    });
    for (const k of [10, 20, 30]) await tree.insert(k, k);
    const iterated: number[] = [];
    for await (const [key] of tree.iterate(5)) iterated.push(key);
    expect(iterated).toEqual([10, 20, 30]);
  });

  it('iteration starting beyond last key yields nothing', async () => {
    const tree = await createTree<number, number>({
      compareKeys: compareNumbers,
      maxLeafEntries: 4,
      maxChildren: 4,
    });
    for (const k of [10, 20, 30]) await tree.insert(k, k);
    const iterated: number[] = [];
    for await (const [key] of tree.iterate(50)) iterated.push(key);
    expect(iterated).toEqual([]);
  });

  it('delete followed by re-insert works correctly', async () => {
    const tree = await createTree<number, string>({
      compareKeys: compareNumbers,
      maxLeafEntries: 3,
      maxChildren: 3,
    });
    await tree.insert(10, 'ten');
    await tree.delete(10);
    await tree.insert(10, 'TEN');
    expect(await tree.get(10)).toBe('TEN');
  });

  it('multi-level tree maintains order after mixed insertions and deletions', async () => {
    const tree = await createTree<number, number>({
      compareKeys: compareNumbers,
      maxLeafEntries: 3,
      maxChildren: 3,
    });
    const keys = Array.from({ length: 20 }, (_, i) => i + 1);
    for (const k of keys) await tree.insert(k, k);
    // Delete some keys to potentially trigger compressions
    for (const k of [2, 5, 7, 11, 13, 17]) await tree.delete(k);
    const iterated: number[] = [];
    for await (const [key] of tree.iterate()) iterated.push(key);
    expect(iterated).toEqual(keys.filter((k) => ![2, 5, 7, 11, 13, 17].includes(k)));
  });

  it('handles extreme boundary keys correctly', async () => {
    const tree = await createTree<number, string>({
      compareKeys: compareNumbers,
      maxLeafEntries: 3,
      maxChildren: 3,
    });
    const boundaryKeys = [Number.MIN_SAFE_INTEGER, -1, 0, 1, Number.MAX_SAFE_INTEGER];
    for (const k of boundaryKeys) await tree.insert(k, String(k));
    for (const k of boundaryKeys) {
      expect(await tree.get(k)).toBe(String(k));
    }
    // Delete some boundary keys
    await tree.delete(Number.MIN_SAFE_INTEGER);
    await tree.delete(Number.MAX_SAFE_INTEGER);
    const remaining: number[] = [];
    for await (const [key] of tree.iterate()) remaining.push(key);
    expect(remaining).toEqual([-1, 0, 1]);
  });
});
