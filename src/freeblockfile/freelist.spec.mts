// @author: Alec Van Vlerken, Arthur Cukier
// @date: 2025-12-03

import assert from 'assert';
import { describe, it, beforeEach } from 'vitest';

import { MockFile } from '../core/mockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { FreeBlockFile } from './freeblockfile.mjs';

import { allocateBlock, allocateBlocksBelow, freeBlock, getFreeBlockCount } from './freelist.mjs';
import * as layout from './layout.mjs';
import { getHeader } from './header.mjs';
import { getBlockCount } from './io.mjs';

//
// Test setup helpers
//
async function makeFBF(blockSize = 64) {
  const raw = new MockFile(blockSize);
  const log = new MockFile(4096);
  const af = new AtomicFile(raw, log);
  const fbf = new FreeBlockFile(af, blockSize);

  await fbf.create();
  return fbf;
}

function crashRaw(fbf: FreeBlockFile) {
  const atomic = fbf._getFile();
  const raw = atomic['dataFile'] as MockFile;
  raw.crash();
}

//
// TEST SUITE
//
describe('freelist.mjs', () => {
  let fbf: FreeBlockFile;

  beforeEach(async () => {
    fbf = await makeFBF();
  });

  // ---------------------------------------------------------
  // getFirstFreeBlock()
  // ---------------------------------------------------------
  it('default free list head is 0', async () => {
    const header = await getHeader(fbf);
    const first = header.readUInt32LE(layout.HEADER_FIRST_FREE_OFFSET);
    assert.strictEqual(first, 0);
  });

  // ---------------------------------------------------------
  // setFirstFreeBlock()
  // ---------------------------------------------------------
  it('allocateBlock creates a new Data block with correct type', async () => {
    const b = await allocateBlock(fbf);
    const buf = await fbf.readBlock(b);
    assert.strictEqual(buf.readUInt8(0), layout.BlockType.Data);
  });

  it('newly allocated block increases logical block count before commit', async () => {
    const before = getBlockCount(fbf);
    await allocateBlock(fbf);
    const after = getBlockCount(fbf);
    assert.strictEqual(after, before + 1);
  });

  it('uncommitted allocateBlock disappears after crash', async () => {
    const atomic = fbf._getFile();

    await allocateBlock(fbf);

    crashRaw(fbf);
    fbf = new FreeBlockFile(atomic, fbf._getBlockSize());
    await fbf.open();

    const count = getBlockCount(fbf);
    assert.strictEqual(count, 1);
  });

  it('clears the free list head when last free block is consumed', async () => {
    const b = await allocateBlock(fbf);
    await freeBlock(fbf, b);

    const reused = await allocateBlock(fbf);
    assert.strictEqual(reused, b);

    const header = await getHeader(fbf);
    const head = header.readUInt32LE(layout.HEADER_FIRST_FREE_OFFSET);

    assert.strictEqual(head, 0, 'free list should now be empty');
  });

  it('setFirstFreeBlock rejects invalid block numbers', async () => {
    await assert.rejects(() => fbf.freeBlock(9999));
  });

  // ---------------------------------------------------------
  // allocateBlock()
  // ---------------------------------------------------------
  it('allocates a new block when free list is empty', async () => {
    const b = await allocateBlock(fbf);
    assert.strictEqual(b, 1);
  });

  it('reuse a block from the free list', async () => {
    const b1 = await allocateBlock(fbf);
    await freeBlock(fbf, b1);

    const b2 = await allocateBlock(fbf);
    assert.strictEqual(b2, b1);
  });

  it('throws if free-list head block is not Free', async () => {
    const b = await allocateBlock(fbf);

    const buf = Buffer.alloc(fbf._getBlockSize());
    buf.writeUInt8(layout.BlockType.Data, 0);
    fbf._setDirtyBlock(b, buf);

    const header = fbf._getDirtyBlock(0)!;
    header.writeUInt32LE(b, layout.HEADER_FIRST_FREE_OFFSET);
    fbf._setDirtyBlock(0, header);

    await assert.rejects(() => allocateBlock(fbf));
  });

  it('allocateBlock rejects corrupted free-list head', async () => {
    const b = await allocateBlock(fbf);

    const buf = Buffer.alloc(fbf._getBlockSize());
    buf.writeUInt8(99, 0);
    fbf._setDirtyBlock(b, buf);

    const header = await getHeader(fbf);
    header.writeUInt32LE(b, layout.HEADER_FIRST_FREE_OFFSET);
    fbf._setDirtyBlock(0, header);

    await assert.rejects(() => allocateBlock(fbf));
  });

  it('allocateBlock rejects free-list head with invalid next pointer', async () => {
    const b = await allocateBlock(fbf);
    await freeBlock(fbf, b);

    const buf = fbf._getDirtyBlock(b)!;
    buf.writeUInt32LE(9999, layout.FREE_NEXT_OFFSET);
    fbf._setDirtyBlock(b, buf);

    await assert.rejects(() => allocateBlock(fbf));
  });

  it('allocateBlock returns freed blocks in reverse order', async () => {
    const b1 = await allocateBlock(fbf);
    const b2 = await allocateBlock(fbf);
    const b3 = await allocateBlock(fbf);

    await freeBlock(fbf, b1);
    await freeBlock(fbf, b2);
    await freeBlock(fbf, b3);

    const r1 = await allocateBlock(fbf);
    const r2 = await allocateBlock(fbf);
    const r3 = await allocateBlock(fbf);

    assert.deepStrictEqual([r1, r2, r3], [b3, b2, b1]);
  });

  it('allocateBlocksBelow skips high free-list blocks and reuses lower holes', async () => {
    const b1 = await allocateBlock(fbf);
    const b2 = await allocateBlock(fbf);
    const b3 = await allocateBlock(fbf);
    const b4 = await allocateBlock(fbf);
    await freeBlock(fbf, b2);
    await freeBlock(fbf, b4);

    const relocated = await allocateBlocksBelow(fbf, 3, 1);
    const normal = await allocateBlock(fbf);

    assert.deepStrictEqual(relocated, [b2]);
    assert.strictEqual(normal, b4);
    assert.strictEqual(await getFreeBlockCount(fbf), 0);
    assert.strictEqual(b1, 1);
    assert.strictEqual(b3, 3);
  });

  it('allocateBlocksBelow returns null without mutating when too few low holes exist', async () => {
    const low = await allocateBlock(fbf);
    const high = await allocateBlock(fbf);
    await freeBlock(fbf, low);
    await freeBlock(fbf, high);

    const relocated = await allocateBlocksBelow(fbf, 2, 2);
    const count = await getFreeBlockCount(fbf);

    assert.strictEqual(relocated, null);
    assert.strictEqual(count, 2);
  });

  // ---------------------------------------------------------
  // freeBlock()
  // ---------------------------------------------------------
  it('frees a Data block and pushes it into the free list', async () => {
    const b = await allocateBlock(fbf);

    await freeBlock(fbf, b);

    const header = await getHeader(fbf);
    const firstFree = header.readUInt32LE(layout.HEADER_FIRST_FREE_OFFSET);

    assert.strictEqual(firstFree, b);
  });

  it('rejects freeing block 0', async () => {
    await assert.rejects(() => freeBlock(fbf, 0));
  });

  it('rejects freeing non-Data blocks', async () => {
    const b = await allocateBlock(fbf);

    const buf = fbf._getDirtyBlock(b)!;
    buf.writeUInt8(layout.BlockType.Header, 0);
    fbf._setDirtyBlock(b, buf);

    await assert.rejects(() => freeBlock(fbf, b));
  });

  it('rejects double free', async () => {
    const b = await allocateBlock(fbf);
    await freeBlock(fbf, b);

    await assert.rejects(() => freeBlock(fbf, b));
  });

  it('freeBlock inserts freed blocks in LIFO order', async () => {
    const b1 = await allocateBlock(fbf);
    const b2 = await allocateBlock(fbf);

    await freeBlock(fbf, b1);
    await freeBlock(fbf, b2);

    const header = await getHeader(fbf);
    const head = header.readUInt32LE(layout.HEADER_FIRST_FREE_OFFSET);

    assert.strictEqual(head, b2);
  });

  it('freeBlock overwrites stale payload when marking block Free', async () => {
    const b = await allocateBlock(fbf);

    const buf = await fbf.readBlock(b);
    buf.fill(0xaa, 1);
    fbf._setDirtyBlock(b, buf);

    await freeBlock(fbf, b);

    const after = fbf._getDirtyBlock(b)!;
    const payload = after.subarray(1);
    assert(payload.every((v) => v === 0xaa || v === 0x00));
  });

  // ---------------------------------------------------------
  // getFreeBlockCount()
  // ---------------------------------------------------------
  it('counts free blocks correctly', async () => {
    const b1 = await allocateBlock(fbf);
    const b2 = await allocateBlock(fbf);

    await freeBlock(fbf, b1);
    await freeBlock(fbf, b2);

    const count = await getFreeBlockCount(fbf);
    assert.strictEqual(count, 2);
  });

  it('detects a cycle in the free list', async () => {
    const b = await allocateBlock(fbf);
    await freeBlock(fbf, b);

    const buf = fbf._getDirtyBlock(b)!;
    buf.writeUInt32LE(b, layout.FREE_NEXT_OFFSET);
    fbf._setDirtyBlock(b, buf);

    await assert.rejects(() => getFreeBlockCount(fbf));
  });

  it('detects out-of-range free-list pointers', async () => {
    const b = await allocateBlock(fbf);
    await freeBlock(fbf, b);

    const buf = fbf._getDirtyBlock(b)!;
    buf.writeUInt32LE(9999, layout.FREE_NEXT_OFFSET);
    fbf._setDirtyBlock(b, buf);

    await assert.rejects(() => getFreeBlockCount(fbf));
  });

  it('detects non-Free block type in free list', async () => {
    const b = await allocateBlock(fbf);
    await freeBlock(fbf, b);

    const buf = fbf._getDirtyBlock(b)!;
    buf.writeUInt8(layout.BlockType.Data, 0);
    fbf._setDirtyBlock(b, buf);

    await assert.rejects(() => getFreeBlockCount(fbf));
  });

  it('getFreeBlockCount returns same value after commit + reopen', async () => {
    const b1 = await allocateBlock(fbf);
    const b2 = await allocateBlock(fbf);

    await freeBlock(fbf, b1);
    await freeBlock(fbf, b2);

    const before = await getFreeBlockCount(fbf);

    await fbf.commit();
    await fbf.close();
    await fbf.open();

    const after = await getFreeBlockCount(fbf);
    assert.strictEqual(after, before);
  });

  it('rejects free blocks with garbage FREE_NEXT pointer', async () => {
    const b = await allocateBlock(fbf);
    await freeBlock(fbf, b);

    const buf = fbf._getDirtyBlock(b)!;
    buf.writeUInt32LE(0xffffffff, layout.FREE_NEXT_OFFSET);

    await assert.rejects(() => getFreeBlockCount(fbf));
  });

  it('counts multiple free blocks correctly', async () => {
    const blocks = [];
    for (let i = 0; i < 5; i++) {
      blocks.push(await allocateBlock(fbf));
    }
    for (const b of blocks) await freeBlock(fbf, b);

    const count = await getFreeBlockCount(fbf);
    assert.strictEqual(count, 5);
  });

  // ---------------------------------------------------------
  // Crash recovery
  // ---------------------------------------------------------
  it('free list disappears after crash', async () => {
    const atomic = fbf._getFile();

    const b = await allocateBlock(fbf);
    await freeBlock(fbf, b);

    crashRaw(fbf);

    fbf = new FreeBlockFile(atomic, fbf._getBlockSize());
    await fbf.open();

    const count = await getFreeBlockCount(fbf);
    assert.strictEqual(count, 0);
  });

  it('free list survives crash if committed', async () => {
    const atomic = fbf._getFile();

    const b = await allocateBlock(fbf);
    await freeBlock(fbf, b);
    await fbf.commit();

    crashRaw(fbf);

    fbf = new FreeBlockFile(atomic, fbf._getBlockSize());
    await fbf.open();

    const count = await getFreeBlockCount(fbf);
    assert.strictEqual(count, 1);
  });
});
