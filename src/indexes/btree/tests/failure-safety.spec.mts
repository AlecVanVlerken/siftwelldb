import { describe, expect, it, vi } from 'vitest';
import { BPlusTree } from '../btree.mjs';
import { BlockNodeStorage } from '../nodestorage.mjs';
import { BlockInternalNode } from '../internalnode.mjs';
import { BlockLeafNode } from '../leafnode.mjs';
import { FreeBlockFile } from '../../../storage/blocks/freeblockfile.mjs';
import { AtomicFile } from '../../../storage/wal/atomicfile.mjs';
import { MockFile } from '../../../../tests/helpers/mockfile.mjs';

type BlockTree = BPlusTree<Buffer, Buffer, BlockLeafNode, BlockInternalNode>;
const keyAt = (index: number) => Buffer.from(index.toString().padStart(4, '0') + 'x'.repeat(20));
const value = Buffer.from('data');

async function createFixture(count: number) {
  const data = new MockFile(128);
  const log = new MockFile(4096);
  const file = new FreeBlockFile(new AtomicFile(data, log), 128);
  await file.create();
  const storage = new BlockNodeStorage(file);
  const tree = await BPlusTree.create(storage);
  const keys = Array.from({ length: count }, (_, index) => keyAt(index));
  for (const key of keys) await tree.insert(key, value);
  await file.setRootBlock(tree.getRoot().getBlockNumber());
  await file.commit();
  return { data, log, file, storage, tree, keys };
}

async function verifyDurableBaseline(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const { file, data, log, tree, keys, storage } = fixture;
  await expect(file.commit()).rejects.toThrow(/recover|reopen/i);
  await expect(tree.insert(keyAt(99), value)).rejects.toThrow(/recover|reopen/i);
  await expect(tree.get(keys[0])).rejects.toThrow(/recover|reopen/i);
  await expect(tree.iterate().next()).rejects.toThrow(/recover|reopen/i);
  expect((await log.stat()).size).toBe(0);
  storage.dispose();
  // Disposing a failed tree must not make its dirty block file committable.
  await expect(file.commit()).rejects.toThrow(/recover|reopen/i);
  await file.close();

  const reopenedFile = new FreeBlockFile(new AtomicFile(data, log), 128);
  await reopenedFile.open();
  const reopenedStorage = new BlockNodeStorage(reopenedFile);
  const reopened: BlockTree = BPlusTree.open(
    reopenedStorage,
    await reopenedStorage.openTree(await reopenedFile.getRootBlock()),
  );
  const actual: string[] = [];
  for await (const [key, entryValue] of reopened.iterate()) {
    actual.push(key.toString());
    expect(entryValue).toEqual(value);
  }
  expect(actual).toEqual(keys.map((key) => key.toString()));
  for (const key of keys) expect(await reopened.get(key)).toEqual(value);
  // A fresh session can complete a valid deletion and persist it.
  expect(await reopened.delete(keys[0])).toBe(true);
  await reopenedFile.setRootBlock(reopened.getRoot().getBlockNumber());
  await reopenedFile.commit();
  reopenedStorage.dispose();
  await reopenedFile.close();

  const finalFile = new FreeBlockFile(new AtomicFile(data, log), 128);
  await finalFile.open();
  const finalStorage = new BlockNodeStorage(finalFile);
  const finalTree = BPlusTree.open(finalStorage, await finalStorage.openTree(await finalFile.getRootBlock()));
  expect(await finalTree.get(keys[0])).toBeNull();
  for (const key of keys.slice(1)) expect(await finalTree.get(key)).toEqual(value);
  finalStorage.dispose();
  await finalFile.close();
}

describe('B+ tree structural failure safety', () => {
  it('keeps relocation traversal failures healthy before allocation or reference changes', async () => {
    const fixture = await createFixture(6);
    const rootBlock = fixture.tree.getRoot().getBlockNumber();
    const error = new Error('injected relocation traversal failure');
    const failure = vi.spyOn(fixture.storage, 'loadNode').mockRejectedValueOnce(error);
    await expect(fixture.storage.relocateNode(rootBlock, rootBlock)).rejects.toBe(error);
    failure.mockRestore();
    expect(fixture.file.isHealthy).toBe(true);
    expect(await fixture.tree.get(fixture.keys[0])).toEqual(value);
    await fixture.file.commit();
    fixture.storage.dispose();
    await fixture.file.close();
  });

  it('blocks direct commits when relocation fails after changing a parent pointer', async () => {
    const fixture = await createFixture(6);
    const rootBlock = fixture.tree.getRoot().getBlockNumber();
    const target = (await fixture.storage.listNodeBlocks(rootBlock)).find((node) => node.kind === 'btree-leaf');
    expect(target).toBeDefined();
    const error = new Error('injected relocation parent update failure');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The mock explicitly supplies the original node as this.
    const original = BlockInternalNode.prototype.replaceChildBlockNumber;
    const failure = vi.spyOn(BlockInternalNode.prototype, 'replaceChildBlockNumber');
    failure.mockImplementationOnce(function (this: BlockInternalNode, ...args) {
      original.apply(this, args);
      throw error;
    });
    try {
      await expect(fixture.storage.relocateNode(rootBlock, target!.blockNumber)).rejects.toBe(error);
    } finally {
      failure.mockRestore();
    }
    await verifyDurableBaseline(fixture);
  });

  it('blocks commits when creating a tree fails after staging a block allocation', async () => {
    const fixture = await createFixture(3);
    const error = new Error('injected tree creation allocation failure');
    const original = fixture.file.allocateBlock.bind(fixture.file);
    const failure = vi.spyOn(fixture.file, 'allocateBlock').mockImplementationOnce(async () => {
      await original();
      throw error;
    });
    const newStorage = new BlockNodeStorage(fixture.file);
    await expect(BPlusTree.create(newStorage)).rejects.toBe(error);
    failure.mockRestore();
    newStorage.dispose();
    await verifyDurableBaseline(fixture);
  });

  it('propagates leaf merge deallocation failures and prevents committing staged deletion', async () => {
    const fixture = await createFixture(6);
    const error = new Error('injected merged leaf deallocation failure');
    const failure = vi.spyOn(fixture.file, 'freeBlock').mockRejectedValueOnce(error);
    await expect(fixture.tree.delete(fixture.keys[0])).rejects.toBe(error);
    expect(failure).toHaveBeenCalledOnce();
    failure.mockRestore();
    await verifyDurableBaseline(fixture);
  });

  it('propagates sibling loading failures after a leaf deletion', async () => {
    const fixture = await createFixture(6);
    const error = new Error('injected sibling loading failure');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The mock explicitly supplies the original node as this.
    const original = BlockInternalNode.prototype.getChildAt;
    const failure = vi.spyOn(BlockInternalNode.prototype, 'getChildAt');
    failure.mockImplementation(function (this: BlockInternalNode, index) {
      if (index === 1) throw error;
      return original.call(this, index);
    });
    try {
      await expect(fixture.tree.delete(fixture.keys[0])).rejects.toBe(error);
    } finally {
      failure.mockRestore();
    }
    await verifyDurableBaseline(fixture);
  });

  it('blocks commits when a parent update fails after replacing merged children', async () => {
    const fixture = await createFixture(6);
    const error = new Error('injected parent separator update failure');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The mock explicitly supplies the original node as this.
    const original = BlockInternalNode.prototype.replaceChildren;
    const failure = vi.spyOn(BlockInternalNode.prototype, 'replaceChildren');
    failure.mockImplementationOnce(function (this: BlockInternalNode, ...args) {
      original.apply(this, args);
      throw error;
    });
    try {
      await expect(fixture.tree.delete(fixture.keys[0])).rejects.toBe(error);
    } finally {
      failure.mockRestore();
    }
    await verifyDurableBaseline(fixture);
  });

  it('propagates cache invalidation failures after modifying a merged leaf', async () => {
    const fixture = await createFixture(6);
    const error = new Error('injected merged node cache failure');
    const cache = fixture.storage as unknown as { invalidateNode(blockNumber: number): void };
    const original = cache.invalidateNode.bind(cache);
    const failure = vi.spyOn(cache, 'invalidateNode');
    failure.mockImplementationOnce(function (this: typeof cache, blockNumber) {
      original(blockNumber);
      throw error;
    });
    await expect(fixture.tree.delete(fixture.keys[0])).rejects.toBe(error);
    failure.mockRestore();
    await verifyDurableBaseline(fixture);
  });

  it('blocks commits when allocation fails after partitioning a leaf split', async () => {
    const fixture = await createFixture(3);
    const error = new Error('injected leaf split allocation failure');
    const failure = vi.spyOn(fixture.file, 'allocateBlock').mockRejectedValueOnce(error);
    await expect(fixture.tree.insert(keyAt(3), value)).rejects.toBe(error);
    expect(failure).toHaveBeenCalledOnce();
    failure.mockRestore();
    await verifyDurableBaseline(fixture);
  });

  it('blocks commits when an internal split allocation fails after partitioning children', async () => {
    const fixture = await createFixture(9);
    const error = new Error('injected internal split allocation failure');
    const original = fixture.file.allocateBlock.bind(fixture.file);
    let allocations = 0;
    const failure = vi.spyOn(fixture.file, 'allocateBlock').mockImplementation(async () => {
      if (++allocations === 2) throw error;
      return await original();
    });
    await expect(fixture.tree.insert(keyAt(9), value)).rejects.toBe(error);
    expect(allocations).toBe(2);
    failure.mockRestore();
    await verifyDurableBaseline(fixture);
  });

  it('propagates internal merge deallocation failures in a multi-level tree', async () => {
    const fixture = await createFixture(18);
    // Make the first internal page sparse enough to merge on the next deletion.
    for (const key of fixture.keys.splice(0, 2)) expect(await fixture.tree.delete(key)).toBe(true);
    await fixture.file.setRootBlock(fixture.tree.getRoot().getBlockNumber());
    await fixture.file.commit();
    expect(fixture.tree.getRoot().isLeaf).toBe(false);
    const error = new Error('injected internal merge deallocation failure');
    const originalFree = fixture.file.freeBlock.bind(fixture.file);
    let mergingInternal = false;
    const freeFailure = vi.spyOn(fixture.file, 'freeBlock').mockImplementation(async (blockNumber) => {
      if (mergingInternal) throw error;
      await originalFree(blockNumber);
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The mock explicitly supplies the original node as this.
    const originalMerge = BlockInternalNode.prototype.mergeWithNext;
    const merge = vi.spyOn(BlockInternalNode.prototype, 'mergeWithNext');
    merge.mockImplementation(async function (this: BlockInternalNode, ...args) {
      mergingInternal = true;
      try {
        await originalMerge.apply(this, args);
      } finally {
        mergingInternal = false;
      }
    });
    try {
      await expect(fixture.tree.delete(fixture.keys[0])).rejects.toBe(error);
      expect(merge).toHaveBeenCalledOnce();
    } finally {
      freeFailure.mockRestore();
      merge.mockRestore();
    }
    await verifyDurableBaseline(fixture);
  });

  it('blocks commits after updating a value when root finalization fails', async () => {
    const fixture = await createFixture(6);
    const error = new Error('injected root finalization failure');
    const original = fixture.storage.finalizeRoot.bind(fixture.storage);
    const failure = vi.spyOn(fixture.storage, 'finalizeRoot').mockImplementationOnce(async (root) => {
      await original(root);
      throw error;
    });
    await expect(fixture.tree.update(fixture.keys[0], Buffer.from('changed'))).rejects.toBe(error);
    failure.mockRestore();
    await verifyDurableBaseline(fixture);
  });

  it('keeps duplicate inserts and missing-key operations safe and usable', async () => {
    const fixture = await createFixture(6);
    await expect(fixture.tree.insert(fixture.keys[0], value)).rejects.toThrow('Duplicate');
    expect(await fixture.tree.delete(keyAt(99))).toBe(false);
    expect(await fixture.tree.update(keyAt(99), value)).toBe(false);
    expect(fixture.file.isHealthy).toBe(true);
    await fixture.tree.insert(keyAt(6), value);
    await fixture.file.setRootBlock(fixture.tree.getRoot().getBlockNumber());
    await fixture.file.commit();
    expect(await fixture.tree.get(keyAt(6))).toEqual(value);
    fixture.storage.dispose();
    await fixture.file.close();
  });

  it('discards an unpublished split and its unlinked nodes without poisoning the shared file', async () => {
    const fixture = await createFixture(3);
    const before = await fixture.file.getStats();
    const storage = new BlockNodeStorage(fixture.file, { unpublished: true });
    const tree = await BPlusTree.create(storage);
    for (let index = 0; index < 3; index++) await tree.insert(keyAt(index), value);
    const error = new Error('injected private split propagation failure');
    const failure = vi.spyOn(storage, 'allocateInternalNode').mockRejectedValueOnce(error);
    await expect(tree.insert(keyAt(3), value)).rejects.toBe(error);
    failure.mockRestore();
    expect(fixture.file.isHealthy).toBe(true);
    await expect(fixture.file.commit()).rejects.toThrow('discard');
    expect(() => storage.publish()).toThrow('discard');
    await storage.discardNewTree();
    expect((await fixture.file.getStats()).usedBlocks).toBe(before.usedBlocks);
    for (const key of fixture.keys) expect(await fixture.tree.get(key)).toEqual(value);
    await fixture.file.commit();
    fixture.storage.dispose();
    await fixture.file.close();
  });

  it.each(['constructor', 'initialization'])(
    'tracks unpublished allocations before a failing node %s so they can be discarded',
    async (stage) => {
      const fixture = await createFixture(3);
      const before = await fixture.file.getStats();
      const storage = new BlockNodeStorage(fixture.file, { unpublished: true });
      const error = new Error(`injected private node ${stage} failure`);
      const failure =
        stage === 'constructor'
          ? vi
              .spyOn(storage as unknown as { createLeafNode(block: number): BlockLeafNode }, 'createLeafNode')
              .mockImplementationOnce(() => {
                throw error;
              })
          : vi.spyOn(BlockLeafNode.prototype, 'initEmpty').mockRejectedValueOnce(error);
      await expect(BPlusTree.create(storage)).rejects.toBe(error);
      failure.mockRestore();
      await storage.discardNewTree();
      expect(fixture.file.isHealthy).toBe(true);
      expect((await fixture.file.getStats()).usedBlocks).toBe(before.usedBlocks);
      await fixture.file.commit();
      fixture.storage.dispose();
      await fixture.file.close();
    },
  );

  it('keeps an unpublished allocation failure unsafe when its staged block number was not returned', async () => {
    const fixture = await createFixture(3);
    const storage = new BlockNodeStorage(fixture.file, { unpublished: true });
    const error = new Error('injected unknown private allocation failure');
    const original = fixture.file.allocateBlock.bind(fixture.file);
    const failure = vi.spyOn(fixture.file, 'allocateBlock').mockImplementationOnce(async () => {
      await original();
      throw error;
    });
    await expect(BPlusTree.create(storage)).rejects.toBe(error);
    failure.mockRestore();
    await expect(storage.discardNewTree()).rejects.toThrow(/recover|reopen/i);
    storage.dispose();
    await verifyDurableBaseline(fixture);
  });

  it('uses shared failure protection after publishing a completed private tree', async () => {
    const fixture = await createFixture(3);
    const storage = new BlockNodeStorage(fixture.file, { unpublished: true });
    const tree = await BPlusTree.create(storage);
    await tree.insert(keyAt(0), value);
    await storage.flushDirtyNodes();
    storage.publish();
    const error = new Error('injected published update failure');
    const failure = vi.spyOn(storage, 'finalizeRoot').mockRejectedValueOnce(error);
    await expect(tree.update(keyAt(0), Buffer.from('changed'))).rejects.toBe(error);
    failure.mockRestore();
    storage.dispose();
    await verifyDurableBaseline(fixture);
  });

  it('refuses using unpublished storage to modify or load an existing tree', async () => {
    const fixture = await createFixture(3);
    const storage = new BlockNodeStorage(fixture.file, { unpublished: true });
    const rootBlock = fixture.tree.getRoot().getBlockNumber();
    await expect(storage.openTree(rootBlock)).rejects.toThrow('existing trees');
    await expect(storage.relocateNode(rootBlock, rootBlock)).rejects.toThrow('published before relocation');
    storage.dispose();
    expect(fixture.file.isHealthy).toBe(true);
    await fixture.file.commit();
    fixture.storage.dispose();
    await fixture.file.close();
  });

  it('blocks commits if an unpublished tree is disposed without discarding its nodes', async () => {
    const fixture = await createFixture(3);
    const storage = new BlockNodeStorage(fixture.file, { unpublished: true });
    const tree = await BPlusTree.create(storage);
    await tree.insert(keyAt(0), value);
    storage.dispose();
    await verifyDurableBaseline(fixture);
  });

  it('keeps private merge deallocation failures unsafe rather than attempting incomplete restoration', async () => {
    const fixture = await createFixture(3);
    const storage = new BlockNodeStorage(fixture.file, { unpublished: true });
    const tree = await BPlusTree.create(storage);
    for (let index = 0; index < 6; index++) await tree.insert(keyAt(index), value);
    const error = new Error('injected private merge deallocation failure');
    const failure = vi.spyOn(fixture.file, 'freeBlock').mockRejectedValueOnce(error);
    await expect(tree.delete(keyAt(0))).rejects.toBe(error);
    failure.mockRestore();
    await expect(storage.discardNewTree()).rejects.toThrow(/recover|reopen/i);
    storage.dispose();
    await verifyDurableBaseline(fixture);
  });

  it('discards a private cache failure after a completed merge without double-freeing its sibling', async () => {
    const fixture = await createFixture(3);
    const before = await fixture.file.getStats();
    const storage = new BlockNodeStorage(fixture.file, { unpublished: true });
    const tree = await BPlusTree.create(storage);
    for (let index = 0; index < 6; index++) await tree.insert(keyAt(index), value);
    const cache = storage as unknown as { invalidateNode(block: number): void };
    const original = cache.invalidateNode.bind(cache);
    const error = new Error('injected private cache invalidation failure');
    const failure = vi.spyOn(cache, 'invalidateNode').mockImplementationOnce((block) => {
      original(block);
      throw error;
    });
    await expect(tree.delete(keyAt(0))).rejects.toBe(error);
    failure.mockRestore();
    await storage.discardNewTree();
    expect(fixture.file.isHealthy).toBe(true);
    expect((await fixture.file.getStats()).usedBlocks).toBe(before.usedBlocks);
    await fixture.file.commit();
    fixture.storage.dispose();
    await fixture.file.close();
  });
});
