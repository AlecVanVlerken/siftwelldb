// @author: Alec Van Vlerken, Arthur Cukier
// @date: 2025-12-03

import assert from 'assert';
import { describe, it, beforeEach } from 'vitest';

import { MockFile } from '../core/mockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { FreeBlockFile } from './freeblockfile.mjs';

import { commit } from './commit.mjs';
import * as layout from './layout.mjs';

//
// Test setup helpers
//
async function makeFBF(blockSize = 64) {
  const raw = new MockFile(blockSize);
  const log = new MockFile(4096);
  const af = new AtomicFile(raw, log);
  const fbf = new FreeBlockFile(af, blockSize);

  await fbf.create();
  await fbf.open();
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
describe('commit.mjs', () => {
  let fbf: FreeBlockFile;

  beforeEach(async () => {
    fbf = await makeFBF();
  });

  // ---------------------------------------------------------
  // commit()
  // ---------------------------------------------------------
  it('commit does nothing when no dirty blocks exist', async () => {
    assert.strictEqual(fbf._getDirtyBlocks().size, 0);

    await commit(fbf);

    assert.strictEqual(fbf._getDirtyBlocks().size, 0);
  });

  it('commit writes dirty blocks to the underlying file', async () => {
    const b = await fbf.allocateBlock();
    const buf = Buffer.alloc(fbf._getBlockSize());
    buf.writeUInt8(layout.BlockType.Data, 0);
    buf.writeUInt8(0xaa, 1);

    fbf._setDirtyBlock(b, buf);

    await commit(fbf);

    const rawBuf = Buffer.alloc(fbf._getBlockSize());
    await fbf._getFile().read(rawBuf, { position: b * fbf._getBlockSize() });

    assert.strictEqual(rawBuf.readUInt8(1), 0xaa);
  });

  it('commit clears dirty-block cache after write', async () => {
    const b = await fbf.allocateBlock();
    const buf = Buffer.alloc(fbf._getBlockSize());
    buf.writeUInt8(layout.BlockType.Data, 0);
    fbf._setDirtyBlock(b, buf);

    await commit(fbf);

    assert.strictEqual(fbf._getDirtyBlocks().size, 0);
  });

  it('committed data persists across close/reopen', async () => {
    const b = await fbf.allocateBlock();
    const buf = Buffer.alloc(fbf._getBlockSize());
    buf.writeUInt8(layout.BlockType.Data, 0);
    buf.writeUInt8(0xdd, 2);
    fbf._setDirtyBlock(b, buf);

    await commit(fbf);
    await fbf.close();
    await fbf.open();

    const readBuf = await fbf.readBlock(b);
    assert.strictEqual(readBuf.readUInt8(2), 0xdd);
  });

  it('uncommitted dirty blocks are lost after crash', async () => {
    const atomic = fbf._getFile();
    const b = await fbf.allocateBlock(); // b = 1

    const buf = Buffer.alloc(fbf._getBlockSize());
    buf.writeUInt8(layout.BlockType.Data, 0);
    buf.writeUInt8(0xee, 3);
    fbf._setDirtyBlock(b, buf); // NOT committed

    crashRaw(fbf);

    fbf = new FreeBlockFile(atomic, fbf._getBlockSize());
    await fbf.open();

    await assert.rejects(() => fbf.readBlock(b));
  });

  it('commit throws when atomicWrite() returns false', async () => {
    const atomic = fbf._getFile();
    const original = atomic.atomicWrite.bind(atomic);
    atomic.atomicWrite = () => Promise.resolve(false);

    const b = await fbf.allocateBlock();
    const buf = Buffer.alloc(fbf._getBlockSize());
    buf.writeUInt8(layout.BlockType.Data, 0);
    fbf._setDirtyBlock(b, buf);

    await assert.rejects(() => commit(fbf));

    atomic.atomicWrite = original;
  });

  it('commit rejects when file is closed', async () => {
    const b = await fbf.allocateBlock();
    const buf = Buffer.alloc(fbf._getBlockSize());
    buf.writeUInt8(layout.BlockType.Data, 0);
    fbf._setDirtyBlock(b, buf);

    await fbf.close();

    await assert.rejects(() => commit(fbf));
  });

  it('commit does not mutate dirty block buffers during write', async () => {
    const b = await fbf.allocateBlock();
    const buf = Buffer.alloc(fbf._getBlockSize());
    buf.writeUInt8(layout.BlockType.Data, 0);
    buf.writeUInt8(0x33, 10);
    fbf._setDirtyBlock(b, buf);

    const snapshot = Buffer.from(buf);

    await commit(fbf);

    assert(snapshot.equals(buf));
  });

  it('does not clear dirty blocks when atomicWrite fails', async () => {
    const atomic = fbf._getFile();

    const original = atomic.atomicWrite.bind(atomic);
    atomic.atomicWrite = () => Promise.resolve(false);

    const b = 1;
    const buf = Buffer.alloc(fbf._getBlockSize());
    buf.writeUInt8(layout.BlockType.Data, 0);
    fbf._setDirtyBlock(b, buf);

    await assert.rejects(() => commit(fbf));

    assert.strictEqual(fbf._getDirtyBlocks().size, 1);

    atomic.atomicWrite = original;
  });
});
