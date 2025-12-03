// @author: Alec Van Vlerken, Arthur Cukier
// @date: 2025-12-03

import assert from 'assert';
import { describe, it } from 'vitest';

import { MockFile } from '../core/mockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { FreeBlockFile } from './freeblockfile.mjs';
import * as layout from './layout.mjs';
import { getHeader } from './header.mjs';

//
// Test setup helpers
//
function makeFBF(blockSize = 64) {
  const raw = new MockFile(blockSize);
  const log = new MockFile(4096);
  const af = new AtomicFile(raw, log);
  const fbf = new FreeBlockFile(af, blockSize);
  return fbf;
}

function crashRaw(fbf: FreeBlockFile) {
  const raw = fbf._getFile()['dataFile'] as MockFile;
  raw.crash();
}

describe('FreeBlockFile', () => {
  // ---------------------------------------------------------
  // constructor
  // ---------------------------------------------------------
  it('rejects invalid block sizes', () => {
    assert.throws(() => new FreeBlockFile({} as AtomicFile, -5));
    assert.throws(() => new FreeBlockFile({} as AtomicFile, 0));
    assert.throws(() => new FreeBlockFile({} as AtomicFile, 1.5));
  });

  it('rejects block size too small for header', () => {
    const tooSmall = layout.HEADER_CLIENT_AREA_OFFSET;
    assert.throws(() => new FreeBlockFile({} as AtomicFile, tooSmall));
  });

  // ---------------------------------------------------------
  // open / close
  // ---------------------------------------------------------
  it('open() throws if already open', async () => {
    const fbf = makeFBF();
    await fbf.create();
    await fbf.open();
    await assert.rejects(() => fbf.open());
  });

  it('close() after close()', async () => {
    const fbf = makeFBF();
    await fbf.create();
    await fbf.open();
    await fbf.close();
    await fbf.close();
  });

  it('operations throw when not open', async () => {
    const fbf = makeFBF();
    await assert.rejects(fbf.readBlock(1));
    await assert.rejects(fbf.allocateBlock());
  });

  // ---------------------------------------------------------
  // create()
  // ---------------------------------------------------------
  it('create() initializes a valid header and closes the file afterwards', async () => {
    const fbf = makeFBF();
    await fbf.create();

    await assert.rejects(() => fbf.readBlock(0));

    await fbf.open();
    const header = await getHeader(fbf);
    assert.strictEqual(header.readUInt8(0), layout.BlockType.Header);
  });

  // ---------------------------------------------------------
  // dirty block cache
  // ---------------------------------------------------------
  it('dirty block cache stores and retrieves references', async () => {
    const fbf = makeFBF();
    await fbf.create();
    await fbf.open();

    const buf = Buffer.alloc(32, 1);
    fbf._setDirtyBlock(5, buf);
    assert.strictEqual(fbf._getDirtyBlock(5), buf);
  });

  it('_clearDirty() removes all staged blocks', async () => {
    const fbf = makeFBF();
    await fbf.create();
    await fbf.open();

    fbf._setDirtyBlock(1, Buffer.alloc(1));
    fbf._setDirtyBlock(2, Buffer.alloc(1));
    assert.strictEqual(fbf._getDirtyBlocks().size, 2);

    fbf._clearDirty();
    assert.strictEqual(fbf._getDirtyBlocks().size, 0);
  });

  // ---------------------------------------------------------
  // integration-level workflow
  // ---------------------------------------------------------
  it('allocate → write → commit → read', async () => {
    const fbf = makeFBF();
    await fbf.create();
    await fbf.open();

    const b = await fbf.allocateBlock();
    const buf = Buffer.alloc(fbf._getBlockSize() - 1);
    buf.writeUInt8(0xaa, 5);
    await fbf.writeBlock(b, buf);

    await fbf.commit();

    const back = await fbf.readBlock(b);
    assert.strictEqual(back.readUInt8(6), 0xaa);
  });

  it('allocate → free → commit → allocate', async () => {
    const fbf = makeFBF();
    await fbf.create();
    await fbf.open();

    const b1 = await fbf.allocateBlock();
    await fbf.commit();

    await fbf.freeBlock(b1);
    await fbf.commit();

    const b2 = await fbf.allocateBlock();
    assert.strictEqual(b2, b1);
  });

  // ---------------------------------------------------------
  // crash integration
  // ---------------------------------------------------------
  it('committed data survives crash', async () => {
    const fbf = makeFBF();
    await fbf.create();
    await fbf.open();

    const b = await fbf.allocateBlock();
    const buf = Buffer.alloc(fbf._getBlockSize() - 1);
    buf.writeUInt8(0xdd, 2);
    await fbf.writeBlock(b, buf);
    await fbf.commit();

    crashRaw(fbf);

    const reopened = new FreeBlockFile(fbf._getFile(), fbf._getBlockSize());
    await reopened.open();

    const data = await reopened.readBlock(b);
    assert.strictEqual(data.readUInt8(3), 0xdd);
  });

  it('uncommitted data is lost after crash', async () => {
    const fbf = makeFBF();
    await fbf.create();
    await fbf.open();

    const b = await fbf.allocateBlock();
    const buf = Buffer.alloc(fbf._getBlockSize() - 1);
    buf.writeUInt8(0xee, 3);
    await fbf.writeBlock(b, buf);

    crashRaw(fbf);

    const reopened = new FreeBlockFile(fbf._getFile(), fbf._getBlockSize());
    await reopened.open();

    await assert.rejects(() => reopened.readBlock(b));
  });
});
