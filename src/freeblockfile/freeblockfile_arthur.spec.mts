import { describe, it, expect, beforeEach } from 'vitest';
import { FreeBlockFile } from './freeblockfile.mjs';
import { MockFile } from '../core/mockfile.mjs';

const BLOCK_SIZE = 512;

describe('FreeBlockFile – full test coverage', () => {
  let mock: MockFile;
  let fbf: FreeBlockFile;

  beforeEach(async () => {
    mock = new MockFile(BLOCK_SIZE);
    await mock.create();
    fbf = new FreeBlockFile(mock, BLOCK_SIZE);
    await fbf.create();
    await fbf.open();
  });

  // read/write and commit methoden

  it('writes and reads a block via cache and commit', async () => {
    const data = Buffer.from('hello');
    await fbf.writeBlock(1, data);

    const pre = await fbf.readBlock(1);
    expect(pre.subarray(0, 5).toString()).toBe('hello');

    await fbf.commit();

    const post = await fbf.readBlock(1);
    expect(post.subarray(0, 5).toString()).toBe('hello');
  });

  it('commit with no dirty blocks does nothing', async () => {
    await expect(fbf.commit()).resolves.not.toThrow();
  });

  it('throws if writing data larger than a block', async () => {
    const tooBig = Buffer.alloc(BLOCK_SIZE + 1);
    await expect(fbf.writeBlock(1, tooBig)).rejects.toThrow();
  });

  // getter/setter of client area

  it('reads and writes client area', async () => {
    const meta = Buffer.from('META');
    await fbf.writeClientArea(meta);
    await fbf.commit();

    const buf = await fbf.getClientArea();
    expect(buf.subarray(0, 4).toString()).toBe('META');
  });

  it('writeClientArea throws if buffer too large', async () => {
    const tooBig = Buffer.alloc(BLOCK_SIZE + 1);
    await expect(fbf.writeClientArea(tooBig)).rejects.toThrow();
  });

  // getter / setter of BlockCount

  it('counts blocks correctly', async () => {
    let count = await fbf.getBlockCount();
    expect(count).toBe(1);

    await fbf.writeBlock(1, Buffer.alloc(1));
    await fbf.writeBlock(2, Buffer.alloc(1));
    await fbf.commit();

    count = await fbf.getBlockCount();
    expect(count).toBe(3);
  });

  it('getBlockCount throws when file not open', async () => {
    await fbf.close();
    await expect(fbf.getBlockCount()).rejects.toThrow();
  });

  // allocate/free manager

  it('throws when allocating with empty free list', async () => {
    await expect(fbf.allocateBlock()).rejects.toThrow();
  });

  it('frees and reuses a block correctly', async () => {
    await fbf.writeBlock(1, Buffer.alloc(1));
    await fbf.commit();

    await fbf.freeBlock(1);
    const freeCount = await fbf.getFreeBlockCount();
    expect(freeCount).toBe(1);

    const reused = await fbf.allocateBlock();
    expect(reused).toBe(1);
  });

  it('getFreeBlockCount throws when file not open', async () => {
    await fbf.close();
    await expect(fbf.getFreeBlockCount()).rejects.toThrow();
  });

  it('freeBlock throws when file not open', async () => {
    await fbf.close();
    await expect(fbf.freeBlock(1)).rejects.toThrow();
  });

  it('freeBlock throws when trying to free block 0', async () => {
    await expect(fbf.freeBlock(0)).rejects.toThrow();
  });

  it('allocateBlock throws when file not open', async () => {
    await fbf.close();
    await expect(fbf.allocateBlock()).rejects.toThrow();
  });

  // first free block

  it('gets and sets first free block correctly', async () => {
    await fbf.setFirstFreeBlock(7);
    const free = await fbf.getFirstFreeBlock();
    expect(free).toBe(7);
  });

  it('getFirstFreeBlock throws if file not open', async () => {
    await fbf.close();
    await expect(fbf.getFirstFreeBlock()).rejects.toThrow();
  });

  it('setFirstFreeBlock throws if file not open', async () => {
    await fbf.close();
    await expect(fbf.setFirstFreeBlock(3)).rejects.toThrow();
  });

  // werking van root block

  it('gets and sets root block correctly', async () => {
    await fbf.setRootBlock(42);
    const root = await fbf.getRootBlock();
    expect(root).toBe(42);
  });

  it('getRootBlock throws if file not open', async () => {
    await fbf.close();
    await expect(fbf.getRootBlock()).rejects.toThrow();
  });

  it('setRootBlock throws if file not open', async () => {
    await fbf.close();
    await expect(fbf.setRootBlock(2)).rejects.toThrow();
  });

  // open/close

  it('throws when opening an already open file', async () => {
    await expect(fbf.open()).rejects.toThrow();
  });

  it('close can be called safely multiple times', async () => {
    await fbf.close();
    await expect(fbf.close()).resolves.not.toThrow();
  });

  // crash consistency

  it('loses uncommitted writes after crash', async () => {
    await fbf.writeBlock(1, Buffer.from('A'));

    mock.crash();

    const fbf2 = new FreeBlockFile(mock, BLOCK_SIZE);
    await fbf2.open();

    const buf = await fbf2.readBlock(1);
    expect(buf.subarray(0, 1).toString()).not.toBe('A');
  });

  it('keeps committed writes after crash', async () => {
    await fbf.writeBlock(1, Buffer.from('B'));
    await fbf.commit();

    mock.crash();

    const fbf2 = new FreeBlockFile(mock, BLOCK_SIZE);
    await fbf2.open();

    const buf = await fbf2.readBlock(1);
    expect(buf.subarray(0, 1).toString()).toBe('B');
  });

  // cache blocks

  it('returns cached block if present in dirty cache', async () => {
    await fbf.writeBlock(1, Buffer.from('C'));

    const buf = await fbf.readBlock(1);
    expect(buf.subarray(0, 1).toString()).toBe('C');
  });

  it('preserves data after reopening', async () => {
    await fbf.writeBlock(1, Buffer.from('persist'));
    await fbf.commit();
    await fbf.close();

    const reopened = new FreeBlockFile(mock, BLOCK_SIZE);
    await reopened.open();

    const buf = await reopened.readBlock(1);
    expect(buf.subarray(0, 7).toString()).toBe('persist');
  });
});
