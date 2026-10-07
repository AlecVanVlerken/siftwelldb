// @author: Alec Van Vlerken, Arthur Cukier
// @date: 2025-12-03

import assert from 'assert';
import { describe, it, beforeEach } from 'vitest';

import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { AtomicFile } from '../../wal/atomicfile.mjs';
import { FreeBlockFile } from '../freeblockfile.mjs';

import {
  readBlock,
  writeBlock,
  offsetOf,
  getBlockCount,
  validateBlockNumber,
  getBlockType,
  setBlockType,
} from '../io.mjs';

import * as layout from '../layout.mjs';

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
describe('io.mjs', () => {
  let fbf: FreeBlockFile;

  beforeEach(async () => {
    fbf = await makeFBF();
  });

  // ---------------------------------------------------------
  // offsetOf()
  // ---------------------------------------------------------
  it('computes correct block offsets', () => {
    assert.strictEqual(offsetOf(fbf, 0), 0);
    assert.strictEqual(offsetOf(fbf, 1), fbf._getBlockSize());
    assert.strictEqual(offsetOf(fbf, 2), fbf._getBlockSize() * 2);
  });

  it('rejects negative block numbers in offsetOf()', () => {
    assert.throws(() => offsetOf(fbf, -1));
  });

  it('offsetOf rejects blockNum larger than maximum safe block', () => {
    const bs = fbf._getBlockSize();
    const maxBlock = Math.floor(Number.MAX_SAFE_INTEGER / bs);

    offsetOf(fbf, maxBlock);

    assert.throws(() => offsetOf(fbf, maxBlock + 1));
  });

  // ---------------------------------------------------------
  // getBlockType() / setBlockType()
  // ---------------------------------------------------------
  it('writes and reads block type', () => {
    const buf = Buffer.alloc(fbf._getBlockSize());
    setBlockType(buf, layout.BlockType.Data);
    const t = getBlockType(buf);
    assert.strictEqual(t, layout.BlockType.Data);
  });

  it('rejects invalid block types', () => {
    const buf = Buffer.alloc(fbf._getBlockSize());
    assert.throws(() => setBlockType(buf, 99 as layout.BlockType));
  });

  it('setBlockType and getBlockType round-trip for all valid types', () => {
    const buf = Buffer.alloc(fbf._getBlockSize());

    for (const type of [layout.BlockType.Header, layout.BlockType.Data, layout.BlockType.Free]) {
      setBlockType(buf, type);
      assert.strictEqual(getBlockType(buf), type);
    }
  });

  // ---------------------------------------------------------
  // readBlock()
  // ---------------------------------------------------------
  it('reads a Data block correctly', async () => {
    const b = await fbf.allocateBlock();

    const buf = await readBlock(fbf, b);
    setBlockType(buf, layout.BlockType.Data);
    buf.writeUInt8(0xaa, 1);
    fbf._setDirtyBlock(b, buf);

    const read = await readBlock(fbf, b);
    assert.strictEqual(read.readUInt8(1), 0xaa);
  });

  it('rejects direct read of header block', async () => {
    await assert.rejects(() => readBlock(fbf, 0));
  });

  it('returns cached dirty block copy', async () => {
    const b = await fbf.allocateBlock();

    const buf = await readBlock(fbf, b);
    buf.writeUInt8(0xbb, 5);

    fbf._setDirtyBlock(b, buf);

    const read2 = await readBlock(fbf, b);
    assert.strictEqual(read2.readUInt8(5), 0xbb);
  });

  it('readBlock returns a fresh copy, not the same reference', async () => {
    const b = await fbf.allocateBlock();
    const data = Buffer.from('hello');
    await writeBlock(fbf, b, data);

    const a = await readBlock(fbf, b);
    const c = await readBlock(fbf, b);

    a[0] = a[0] ^ 0xff;

    assert.notStrictEqual(a[0], c[0], 'readBlock must return a fresh copy');
  });

  it('rejects reading out-of-range blocks', async () => {
    await assert.rejects(() => readBlock(fbf, 99));
  });

  // ---------------------------------------------------------
  // writeBlock()
  // ---------------------------------------------------------
  it('writes a Data block into dirty cache', async () => {
    const b = await fbf.allocateBlock();

    const base = await readBlock(fbf, b);
    setBlockType(base, layout.BlockType.Data);
    fbf._setDirtyBlock(b, base);

    const payload = Buffer.from('hello');
    await writeBlock(fbf, b, payload);

    const stored = fbf._getDirtyBlock(b)!;
    assert.strictEqual(stored.subarray(1, 6).toString(), 'hello');
  });

  it('rejects writing block 0 (header)', async () => {
    const payload = Buffer.from('x');
    await assert.rejects(() => writeBlock(fbf, 0, payload));
  });

  it('rejects writing oversized block', async () => {
    const b = await fbf.allocateBlock();
    const tooBig = Buffer.alloc(fbf._getBlockSize());
    await assert.rejects(() => writeBlock(fbf, b, tooBig));
  });

  it('rejects write to non-Data blocks', async () => {
    const b = await fbf.allocateBlock();

    const buf = await readBlock(fbf, b);
    setBlockType(buf, layout.BlockType.Free);
    fbf._setDirtyBlock(b, buf);

    await assert.rejects(() => writeBlock(fbf, b, Buffer.from('x')));
  });

  it('writeBlock loads from disk when not dirty', async () => {
    const b = await fbf.allocateBlock();

    const buf = await readBlock(fbf, b);
    setBlockType(buf, layout.BlockType.Data);
    fbf._setDirtyBlock(b, buf);
    await fbf.commit();

    assert.strictEqual(fbf._getDirtyBlock(b), undefined);

    const update = Buffer.from('abc');
    await writeBlock(fbf, b, update);

    const after = fbf._getDirtyBlock(b);
    assert(after instanceof Buffer);
    assert.strictEqual(after.readUInt8(0), layout.BlockType.Data);
    assert(after.subarray(1, 4).equals(update));
  });

  it('writeBlock preserves block type when loading from disk', async () => {
    const b = await fbf.allocateBlock();

    const buf = await readBlock(fbf, b);
    setBlockType(buf, layout.BlockType.Data);
    fbf._setDirtyBlock(b, buf);
    await fbf.commit();

    assert.strictEqual(fbf._getDirtyBlock(b), undefined);

    await writeBlock(fbf, b, Buffer.from('xyz'));

    const stored = fbf._getDirtyBlock(b)!;
    assert.strictEqual(stored.readUInt8(0), layout.BlockType.Data);
  });

  // ---------------------------------------------------------
  // getBlockCount()
  // ---------------------------------------------------------
  it('computes block count correctly', async () => {
    const initial = getBlockCount(fbf);
    assert.strictEqual(initial, 1);

    await fbf.allocateBlock();
    const after = getBlockCount(fbf);
    assert.strictEqual(after, 2);
  });

  it('detects corrupted file size', async () => {
    const atomic = fbf._getFile();
    const raw = atomic['dataFile'] as MockFile;

    await raw.writev([Buffer.from([0])], 99);

    raw.crash();

    fbf = new FreeBlockFile(atomic, fbf._getBlockSize());
    // Corruption is now detected during open() instead of getBlockCount()
    await assert.rejects(() => fbf.open());
  });

  it('getBlockCount includes dirty blocks even after commit and reopen', async () => {
    const b = await fbf.allocateBlock();
    const update = Buffer.from('hi');
    await writeBlock(fbf, b, update);

    const count1 = getBlockCount(fbf);
    assert.strictEqual(count1, 2);

    await fbf.commit();
    await fbf.close();
    await fbf.open();

    const count2 = getBlockCount(fbf);
    assert.strictEqual(count2, 2, 'block count must persist after commit');
  });

  // ---------------------------------------------------------
  // validateBlockNumber()
  // ---------------------------------------------------------
  it('accepts valid block numbers', async () => {
    await fbf.allocateBlock();
    validateBlockNumber(fbf, 1);
  });

  it('rejects out-of-range block numbers', () => {
    assert.throws(() => validateBlockNumber(fbf, 99));
  });

  it('newly written dirty blocks extend logical size', async () => {
    await fbf.allocateBlock();
    await fbf.allocateBlock();

    const buf = Buffer.alloc(fbf._getBlockSize());
    setBlockType(buf, layout.BlockType.Data);
    fbf._setDirtyBlock(5, buf);

    const count = getBlockCount(fbf);
    assert.strictEqual(count, 6);
  });

  it('validateBlockNumber accepts highest valid block number', async () => {
    const b = await fbf.allocateBlock();
    const count = getBlockCount(fbf);
    assert.strictEqual(b, count - 1);
    validateBlockNumber(fbf, b); // should not throw
  });

  it('validateBlockNumber rejects blockNum == blockCount', async () => {
    const b = await fbf.allocateBlock();
    const count = getBlockCount(fbf);
    assert.strictEqual(b, count - 1);
    assert.throws(() => validateBlockNumber(fbf, count));
  });

  // ---------------------------------------------------------
  // crash tests
  // ---------------------------------------------------------
  it('recovers dirty-block extension after crash', async () => {
    const atomic = fbf._getFile();

    const buf = Buffer.alloc(fbf._getBlockSize());
    setBlockType(buf, layout.BlockType.Data);
    fbf._setDirtyBlock(3, buf);

    crashRaw(fbf);

    fbf = new FreeBlockFile(atomic, fbf._getBlockSize());
    await fbf.open();

    const count = getBlockCount(fbf);
    assert.strictEqual(count, 1);
  });
});
