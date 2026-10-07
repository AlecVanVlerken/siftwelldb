import assert from 'assert';
import { describe, it } from 'vitest';

import { AtomicFile } from '../../../storage/wal/atomicfile.mjs';
import { FreeBlockFile } from '../../../storage/blocks/freeblockfile.mjs';
import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { BPlusTree } from '../btree.mjs';
import { BlockInternalNode } from '../internalnode.mjs';
import { BlockLeafNode } from '../leafnode.mjs';
import { BlockNodeStorage } from '../nodestorage.mjs';

type BlockTree = BPlusTree<Buffer, Buffer, BlockLeafNode, BlockInternalNode>;

async function makeStorage(blockSize = 128): Promise<BlockNodeStorage> {
  return (await makeStorageAndFile(blockSize)).storage;
}

async function makeStorageAndFile(blockSize = 128): Promise<{ storage: BlockNodeStorage; file: FreeBlockFile }> {
  const data = new MockFile(blockSize);
  const log = new MockFile(4096);
  const file = new FreeBlockFile(new AtomicFile(data, log), blockSize);
  await file.create();
  return { storage: new BlockNodeStorage(file), file };
}

async function makeTree(storage: BlockNodeStorage, count: number): Promise<BlockTree> {
  const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);
  for (let i = 0; i < count; i++) {
    const key = Buffer.from(i.toString().padStart(4, '0'));
    await tree.insert(key, Buffer.from(`value-${i}`));
  }
  return tree;
}

async function assertTreeContents(tree: BlockTree, count: number): Promise<void> {
  const iteratedKeys: string[] = [];

  for (let i = 0; i < count; i++) {
    const key = Buffer.from(i.toString().padStart(4, '0'));
    const value = await tree.get(key);
    assert.strictEqual(value?.toString(), `value-${i}`);
  }

  for await (const [key] of tree.iterate()) {
    iteratedKeys.push(key.toString());
  }

  assert.strictEqual(iteratedKeys.length, count);
  assert.deepStrictEqual(iteratedKeys, iteratedKeys.slice().sort());
}

describe('B+ tree node relocation', () => {
  it('relocates a root leaf and keeps searches working', async () => {
    const storage = await makeStorage();
    const tree = await makeTree(storage, 4);
    const oldRootBlock = tree.getRoot().getBlockNumber();

    const result = await storage.relocateNode(oldRootBlock, oldRootBlock);
    const reopened = BPlusTree.open<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(
      storage,
      await storage.openTree(result.newRootBlock),
    );

    assert.strictEqual(result.kind, 'btree-leaf');
    assert.notStrictEqual(result.newRootBlock, oldRootBlock);
    assert.strictEqual(result.newBlockNumber, result.newRootBlock);
    await assertTreeContents(reopened, 4);

    const locations = await storage.listNodeBlocks(result.newRootBlock);
    assert(!locations.some((location) => location.blockNumber === oldRootBlock));
  });

  it('relocates a non-root leaf and preserves leaf-chain iteration', async () => {
    const storage = await makeStorage();
    const tree = await makeTree(storage, 120);
    const rootBlock = tree.getRoot().getBlockNumber();
    const leaf = (await storage.listNodeBlocks(rootBlock)).find(
      (location) => location.kind === 'btree-leaf' && location.blockNumber !== rootBlock,
    );
    assert(leaf);

    const result = await storage.relocateNode(rootBlock, leaf.blockNumber);
    const reopened = BPlusTree.open<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(
      storage,
      await storage.openTree(result.newRootBlock),
    );

    assert.strictEqual(result.kind, 'btree-leaf');
    assert.strictEqual(result.newRootBlock, rootBlock);
    await assertTreeContents(reopened, 120);

    const locations = await storage.listNodeBlocks(result.newRootBlock);
    assert(!locations.some((location) => location.blockNumber === leaf.blockNumber));
    assert(locations.some((location) => location.blockNumber === result.newBlockNumber));
  });

  it('relocates an internal root and returns the new root block', async () => {
    const storage = await makeStorage();
    const tree = await makeTree(storage, 120);
    const oldRootBlock = tree.getRoot().getBlockNumber();

    const result = await storage.relocateNode(oldRootBlock, oldRootBlock);
    const reopened = BPlusTree.open<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(
      storage,
      await storage.openTree(result.newRootBlock),
    );

    assert.strictEqual(result.kind, 'btree-internal');
    assert.notStrictEqual(result.newRootBlock, oldRootBlock);
    assert.strictEqual(result.newBlockNumber, result.newRootBlock);
    await assertTreeContents(reopened, 120);

    const locations = await storage.listNodeBlocks(result.newRootBlock);
    assert(!locations.some((location) => location.blockNumber === oldRootBlock));
  });

  it('relocates a non-root internal node and preserves traversal', async () => {
    const storage = await makeStorage();
    const tree = await makeTree(storage, 300);
    const rootBlock = tree.getRoot().getBlockNumber();
    const internal = (await storage.listNodeBlocks(rootBlock)).find(
      (location) => location.kind === 'btree-internal' && location.blockNumber !== rootBlock,
    );
    assert(internal);

    const result = await storage.relocateNode(rootBlock, internal.blockNumber);
    const reopened = BPlusTree.open<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(
      storage,
      await storage.openTree(result.newRootBlock),
    );

    assert.strictEqual(result.kind, 'btree-internal');
    assert.strictEqual(result.newRootBlock, rootBlock);
    await assertTreeContents(reopened, 300);

    const locations = await storage.listNodeBlocks(result.newRootBlock);
    assert(!locations.some((location) => location.blockNumber === internal.blockNumber));
    assert(locations.some((location) => location.blockNumber === result.newBlockNumber));
  });

  it('frees the old block-backed root when deleting the last key creates a fresh empty root', async () => {
    const { storage, file } = await makeStorageAndFile();
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);

    await tree.insert(Buffer.from('only'), Buffer.from('value'));
    await file.commit();

    const oldRootBlock = tree.getRoot().getBlockNumber();
    const beforeDelete = await file.getStats();

    assert.strictEqual(await tree.delete(Buffer.from('only')), true);
    await file.commit();

    const newRootBlock = tree.getRoot().getBlockNumber();
    const afterDelete = await file.getStats();

    assert.notStrictEqual(newRootBlock, oldRootBlock);
    assert(afterDelete.freeBlocks > beforeDelete.freeBlocks, 'old empty root should be returned to the free list');

    const recycledBlock = await file.allocateBlock();
    assert.strictEqual(recycledBlock, oldRootBlock);
  });
});
