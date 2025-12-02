import assert from 'assert';
import { describe, it, beforeEach } from 'vitest';

import { MockFile } from '../core/mockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { FreeBlockFile } from './freeblockfile.mjs';

import { getHeader, getClientArea, writeClientArea, getRootBlock, setRootBlock } from './header.mjs';

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
describe('header.mjs', () => {
  let fbf: FreeBlockFile;

  beforeEach(async () => {
    fbf = await makeFBF();
  });

  // ---------------------------------------------------------
  // getHeader()
  // ---------------------------------------------------------
  it('reads header and validates block type', async () => {
    const header = await getHeader(fbf);

    assert.strictEqual(header.readUInt8(layout.HEADER_TYPE_OFFSET), layout.BlockType.Header);
  });

  it('rejects corrupted header type', async () => {
    const h = await getHeader(fbf);
    h.writeUInt8(layout.BlockType.Data, layout.HEADER_TYPE_OFFSET);
    fbf._setDirtyBlock(0, h);

    await assert.rejects(() => getHeader(fbf));
  });

  it('caches header in dirtyBlocks', async () => {
    const h1 = await getHeader(fbf);
    const h2 = await getHeader(fbf);

    assert.strictEqual(h1, h2);
    assert.strictEqual(fbf._getDirtyBlock(0), h2);
  });

  it('rejects corrupted header after simulated crash', async () => {
    const atomic = fbf._getFile();

    const h = await getHeader(fbf);
    h.writeUInt8(layout.BlockType.Data, layout.HEADER_TYPE_OFFSET);
    fbf._setDirtyBlock(0, h);

    crashRaw(fbf);

    fbf = new FreeBlockFile(atomic, fbf._getBlockSize());
    await fbf.open();

    const header = await getHeader(fbf);
    assert.strictEqual(header.readUInt8(layout.HEADER_TYPE_OFFSET), layout.BlockType.Header);
  });

  // ---------------------------------------------------------
  // getClientArea()
  // ---------------------------------------------------------
  it('returns the client area slice of the header', async () => {
    const client = await getClientArea(fbf);

    assert(client instanceof Buffer);
    assert.strictEqual(client.length, fbf._getBlockSize() - layout.HEADER_CLIENT_AREA_OFFSET);
  });

  it('returns a copy of the client area, not a direct reference', async () => {
    const original = await getClientArea(fbf);

    original[0] = 0xaa;

    const reread = await getClientArea(fbf);
    assert.notStrictEqual(original[0], reread[0]);
  });

  // ---------------------------------------------------------
  // writeClientArea()
  // ---------------------------------------------------------
  it('writes and retrieves the client area', async () => {
    const data = Buffer.from('Hello client!');
    await writeClientArea(fbf, data);

    const readBack = await getClientArea(fbf);
    assert(readBack.subarray(0, data.length).equals(data));
  });

  it('rejects client area writes that exceed available space', async () => {
    const tooLarge = Buffer.alloc(fbf._getBlockSize() + 50);

    await assert.rejects(() => writeClientArea(fbf, tooLarge));
  });

  it('clears leftover bytes when writing a shorter client area', async () => {
    const full = Buffer.alloc(20, 0xff);
    await writeClientArea(fbf, full);

    const small = Buffer.from('hi');
    await writeClientArea(fbf, small);

    const readBack = await getClientArea(fbf);

    assert.strictEqual(readBack[0], small[0]);
    assert.strictEqual(readBack[1], small[1]);
    assert.strictEqual(readBack[2], 0x00);
  });

  // ---------------------------------------------------------
  // getRootBlock()
  // ---------------------------------------------------------
  it('returns the default root pointer (0)', async () => {
    const root = await getRootBlock(fbf);
    assert.strictEqual(root, 0);
  });

  it('persists root pointer across commit and reopen', async () => {
    const b = await fbf.allocateBlock();
    await setRootBlock(fbf, b);

    await fbf.commit();
    await fbf.close();

    await fbf.open();
    const root = await getRootBlock(fbf);

    assert.strictEqual(root, b);
  });

  // ---------------------------------------------------------
  // setRootBlock()
  // ---------------------------------------------------------
  it('updates the root block pointer', async () => {
    const b = await fbf.allocateBlock();

    await setRootBlock(fbf, b);

    const root = await getRootBlock(fbf);
    assert.strictEqual(root, b);
  });

  it('rejects invalid root block numbers', async () => {
    await assert.rejects(() => setRootBlock(fbf, 9999));
  });

  it('defers writing root pointer until commit', async () => {
    const b = await fbf.allocateBlock();
    await setRootBlock(fbf, b);

    const rawHeader = Buffer.alloc(fbf._getBlockSize());
    await fbf._getFile().read(rawHeader, { position: 0 });

    const onDisk = rawHeader.readUInt32LE(layout.HEADER_ROOT_OFFSET);
    assert.strictEqual(onDisk, 0, 'root should not be written before commit');
  });

  it('root pointer survives crash only if committed', async () => {
    const atomic = fbf._getFile();

    const b = await fbf.allocateBlock();
    await setRootBlock(fbf, b);

    crashRaw(fbf);

    fbf = new FreeBlockFile(atomic, fbf._getBlockSize());
    await fbf.open();

    const root = await getRootBlock(fbf);
    assert.strictEqual(root, 0);
  });

  it('rejects negative root block numbers', async () => {
    await assert.rejects(() => setRootBlock(fbf, -1));
  });

  // ---------------------------------------------------------
  // Header corruption checks
  // ---------------------------------------------------------
  it('rejects header with invalid firstFree pointer', async () => {
    const h = await getHeader(fbf);
    h.writeUInt32LE(9999, layout.HEADER_FIRST_FREE_OFFSET);
    fbf._setDirtyBlock(0, h);

    await assert.rejects(() => getHeader(fbf));
  });

  it('rejects header with invalid root pointer', async () => {
    const h = await getHeader(fbf);
    h.writeUInt32LE(12345, layout.HEADER_ROOT_OFFSET);
    fbf._setDirtyBlock(0, h);

    await assert.rejects(() => getHeader(fbf));
  });

  it('rejects header with non-numeric garbage in firstFree field', async () => {
    const h = await getHeader(fbf);

    h.writeUInt32LE(0xfffffff0, layout.HEADER_FIRST_FREE_OFFSET);
    fbf._setDirtyBlock(0, h);

    await assert.rejects(() => getHeader(fbf));
  });
});
