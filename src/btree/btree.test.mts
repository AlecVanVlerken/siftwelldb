import { describe, expect, it } from 'vitest';
import { BPlusTree } from './btree.mjs';
import { LeafNodeImpl } from './leafnode.mjs';
import { InternalNodeImpl } from './internalnode.mjs';

const compareNumbers = (a: number, b: number) => a - b;

describe('BPlusTree', () => {
  it('inserts and retrieves values', async () => {
    const tree = await BPlusTree.create<number, string>({
      compareKeys: compareNumbers,
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
    const tree = await BPlusTree.create<number, number>({
      compareKeys: compareNumbers,
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
    const tree = await BPlusTree.create<number, string>({
      compareKeys: compareNumbers,
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
    const tree = await BPlusTree.create<number, string>({
      compareKeys: compareNumbers,
      maxLeafEntries: 3,
      maxChildren: 3,
    });
    await tree.insert(1, 'one');
    await expect(tree.insert(1, 'uno')).rejects.toThrow(/Duplicate keys/);
  });

  it('maintains order for large sequential inserts', async () => {
    const tree = await BPlusTree.create<number, number>({
      compareKeys: compareNumbers,
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
    const tree = await BPlusTree.create<number, string>({
      compareKeys: compareNumbers,
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
    const tree = await BPlusTree.create<number, number>({
      compareKeys: compareNumbers,
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
    const tree = await BPlusTree.create<number, number>({
      compareKeys: compareNumbers,
      maxLeafEntries,
      maxChildren,
    });
    for (let i = 0; i < 30; i++) {
      await tree.insert(i, i);
    }
    for (let i = 0; i < 30; i += 2) {
      await tree.delete(i);
    }
    const queue: (LeafNodeImpl<number, number> | InternalNodeImpl<number, number>)[] = [
      (tree as unknown as { root: LeafNodeImpl<number, number> | InternalNodeImpl<number, number> }).root,
    ];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (node.isLeaf) {
        expect((node as LeafNodeImpl<number, number>).getEntryCount()).toBeLessThanOrEqual(maxLeafEntries);
      } else {
        const internal = node as InternalNodeImpl<number, number>;
        expect(internal.childCount()).toBeLessThanOrEqual(maxChildren);
        for (let i = 0; i < internal.childCount(); i++) {
          queue.push(internal.getChildAt(i) as LeafNodeImpl<number, number> | InternalNodeImpl<number, number>);
        }
      }
    }
  });
});
