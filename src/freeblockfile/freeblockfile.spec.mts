import { describe, it, expect, beforeEach } from 'vitest';
import { FreeBlockFile } from './freeblockfile.mjs';
import { MockFile } from '../core/mockfile.mjs';

const BLOCK_SIZE = 512;

describe('FreeBlockFile', () => {
  let mock: MockFile;
  let fbf: FreeBlockFile;

  beforeEach(async () => {
    mock = new MockFile(BLOCK_SIZE);
    await mock.create();
    fbf = new FreeBlockFile(mock, BLOCK_SIZE);
    await fbf.create();
  });

  it('writes and reads a block via cache and commit', async () => {
    const blockNum = 1;
    const data = Buffer.from('hello');

    await fbf.writeBlock(blockNum, data);

    const pre = await fbf.readBlock(blockNum);
    expect(pre.subarray(0, data.length).toString()).toBe('hello');

    await fbf.commit();
    const post = await fbf.readBlock(blockNum);
    expect(post.subarray(0, data.length).toString()).toBe('hello');
  });

  it('throws if writing data larger than a block', async () => {
    const tooBig = Buffer.alloc(BLOCK_SIZE + 1);
    await expect(fbf.writeBlock(1, tooBig)).rejects.toThrow();
  });

  it('commit flushes dirty blocks into MockFile', async () => {
    const blockNum = 1;
    const data = Buffer.from('X');

    await fbf.writeBlock(blockNum, data);

    const pre = await fbf.readBlock(blockNum);
    expect(pre.subarray(0, data.length).toString()).toBe('X');

    const rawBefore = Buffer.alloc(1);
    await mock.read(rawBefore, { position: blockNum * BLOCK_SIZE });
    expect(rawBefore.toString()).not.toBe('X');

    await fbf.commit();

    const rawAfter = Buffer.alloc(1);
    await mock.read(rawAfter, { position: blockNum * BLOCK_SIZE });
    expect(rawAfter.toString()).toBe('X');
  });

  it('reads and writes client area', async () => {
    const meta = Buffer.from('META');
    await fbf.writeClientArea(meta);
    await fbf.commit();

    const buf = await fbf.getClientArea();
    expect(buf.subarray(0, meta.length).toString()).toBe('META');
  });

  it('allocates a new block when file only has client area', async () => {
    const block = await fbf.allocateBlock();
    expect(block).toBe(1);

    const count = await fbf.getBlockCount();
    expect(count).toBe(2);
  });

  it('allocates multiple blocks and grows file size', async () => {
    const b1 = await fbf.allocateBlock();
    const b2 = await fbf.allocateBlock();

    expect(b1).toBe(1);
    expect(b2).toBe(2);

    const count = await fbf.getBlockCount();
    expect(count).toBe(3);
  });

  it('frees and reuses blocks', async () => {
    await fbf.allocateBlock();
    const b2 = await fbf.allocateBlock();

    await fbf.freeBlock(b2);

    const freeCount = await fbf.getFreeBlockCount();
    expect(freeCount).toBe(1);

    const b3 = await fbf.allocateBlock();
    expect(b3).toBe(b2);

    const freeCountAfter = await fbf.getFreeBlockCount();
    expect(freeCountAfter).toBe(0);
  });

  it('loses uncommitted writes after "crash"', async () => {
    const blockNum = 1;
    const data = Buffer.from('A');

    const fbf1 = fbf;

    await fbf1.writeBlock(blockNum, data);

    mock.crash();

    const fbf2 = new FreeBlockFile(mock, BLOCK_SIZE);
    await fbf2.open();

    const buf = await fbf2.readBlock(blockNum);

    expect(buf.subarray(0, 1).toString()).not.toBe('A');
  });

  it('keeps committed writes after "crash"', async () => {
    const blockNum = 1;
    const data = Buffer.from('B');

    await fbf.writeBlock(blockNum, data);
    await fbf.commit();

    mock.crash();

    const fbf2 = new FreeBlockFile(mock, BLOCK_SIZE);
    await fbf2.open();

    const buf = await fbf2.readBlock(blockNum);
    expect(buf.subarray(0, data.length).toString()).toBe('B');
  });

  it('counts blocks correctly', async () => {
    let count = await fbf.getBlockCount();
    expect(count).toBe(1);

    await fbf.allocateBlock();
    await fbf.allocateBlock();

    count = await fbf.getBlockCount();
    expect(count).toBe(3);
  });

  it('counts free blocks correctly', async () => {
    await fbf.allocateBlock();
    const b2 = await fbf.allocateBlock();
    const b3 = await fbf.allocateBlock();

    await fbf.freeBlock(b2);
    await fbf.freeBlock(b3);

    const freeCount = await fbf.getFreeBlockCount();
    expect(freeCount).toBe(2);

    const reused = await fbf.allocateBlock();
    expect([b2, b3]).toContain(reused);

    const freeCountAfter = await fbf.getFreeBlockCount();
    expect(freeCountAfter).toBe(1);
  });

  it('can reopen an existing file and preserve data', async () => {
    const blockNum = 1;
    const data = Buffer.from('persist');

    await fbf.writeBlock(blockNum, data);
    await fbf.commit();
    await fbf.close();

    const reopened = new FreeBlockFile(mock, BLOCK_SIZE);
    await reopened.open();

    const buf = await reopened.readBlock(blockNum);
    expect(buf.subarray(0, data.length).toString()).toBe('persist');
  });
});
