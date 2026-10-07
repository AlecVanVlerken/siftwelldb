import assert from 'assert';
import { describe, it } from 'vitest';

import { AtomicFile } from '../../wal/atomicfile.mjs';
import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { FreeBlockFile } from '../freeblockfile.mjs';

async function makeFreeBlockFile(blockSize = 256): Promise<{
  fbf: FreeBlockFile;
  data: MockFile;
  log: MockFile;
}> {
  const data = new MockFile(blockSize);
  const log = new MockFile(blockSize * 16);
  const fbf = new FreeBlockFile(new AtomicFile(data, log), blockSize);
  await fbf.create();
  return { fbf, data, log };
}

describe('FreeBlockFile.trimFreeTail', () => {
  it('returns zero when only the header block exists', async () => {
    const { fbf } = await makeFreeBlockFile();

    const result = await fbf.trimFreeTail();

    assert.deepStrictEqual(result, { removedBlocks: 0, newBlockCount: 1 });
    assert.strictEqual(fbf._getCachedBlockCount(), 1);
  });

  it('trims one highest free block', async () => {
    const { fbf } = await makeFreeBlockFile();
    const first = await fbf.allocateBlock();
    const second = await fbf.allocateBlock();
    await fbf.commit();

    await fbf.freeBlock(second);
    await fbf.commit();

    const result = await fbf.trimFreeTail();

    assert.deepStrictEqual(result, { removedBlocks: 1, newBlockCount: 2 });
    assert.strictEqual(fbf._getCachedBlockCount(), 2);
    await assert.rejects(() => fbf.readBlock(second));
    await assert.doesNotReject(() => fbf.readBlock(first));
  });

  it('trims the complete free suffix and preserves non-tail live blocks', async () => {
    const { fbf } = await makeFreeBlockFile();
    const first = await fbf.allocateBlock();
    const second = await fbf.allocateBlock();
    const third = await fbf.allocateBlock();
    const fourth = await fbf.allocateBlock();
    await fbf.commit();

    await fbf.freeBlock(third);
    await fbf.freeBlock(fourth);
    await fbf.commit();

    const result = await fbf.trimFreeTail();

    assert.deepStrictEqual(result, { removedBlocks: 2, newBlockCount: 3 });
    await assert.doesNotReject(() => fbf.readBlock(first));
    await assert.doesNotReject(() => fbf.readBlock(second));
    await assert.rejects(() => fbf.readBlock(third));
    await assert.rejects(() => fbf.readBlock(fourth));
  });

  it('does not trim when the highest block is live', async () => {
    const { fbf } = await makeFreeBlockFile();
    await fbf.allocateBlock();
    const middle = await fbf.allocateBlock();
    await fbf.allocateBlock();
    await fbf.commit();

    await fbf.freeBlock(middle);
    await fbf.commit();

    const result = await fbf.trimFreeTail();

    assert.deepStrictEqual(result, { removedBlocks: 0, newBlockCount: 4 });
    assert.strictEqual(await fbf.getFreeBlockCount(), 1);
  });

  it('removes trimmed blocks from the free list and keeps remaining free blocks reusable', async () => {
    const { fbf } = await makeFreeBlockFile();
    await fbf.allocateBlock();
    const nonTailFree = await fbf.allocateBlock();
    await fbf.allocateBlock();
    const tailFree = await fbf.allocateBlock();
    await fbf.commit();

    await fbf.freeBlock(nonTailFree);
    await fbf.freeBlock(tailFree);
    await fbf.commit();

    const result = await fbf.trimFreeTail();
    const reused = await fbf.allocateBlock();

    assert.deepStrictEqual(result, { removedBlocks: 1, newBlockCount: 4 });
    assert.strictEqual(reused, nonTailFree);
  });

  it('survives close and reopen after trimming', async () => {
    const { fbf, data, log } = await makeFreeBlockFile();
    await fbf.allocateBlock();
    const tail = await fbf.allocateBlock();
    await fbf.commit();
    await fbf.freeBlock(tail);
    await fbf.commit();

    const result = await fbf.trimFreeTail();
    await fbf.close();

    const reopened = new FreeBlockFile(new AtomicFile(data, log), 256);
    await reopened.open();

    assert.deepStrictEqual(result, { removedBlocks: 1, newBlockCount: 2 });
    assert.strictEqual(reopened._getCachedBlockCount(), 2);
    assert.strictEqual(await reopened.getFreeBlockCount(), 0);
    await reopened.close();
  });

  it('rejects trimming while dirty blocks are pending', async () => {
    const { fbf } = await makeFreeBlockFile();
    const block = await fbf.allocateBlock();
    await fbf.commit();
    await fbf.freeBlock(block);

    await assert.rejects(() => fbf.trimFreeTail(), /commit first/);
  });
});
