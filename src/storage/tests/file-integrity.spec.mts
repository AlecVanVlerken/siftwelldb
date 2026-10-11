import { type FileHandle, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RealFile } from '../file.mjs';
import { AtomicFile } from '../wal/atomicfile.mjs';
import { FreeBlockFile } from '../blocks/freeblockfile.mjs';

type Progress = number | Error;

/** A positional file handle that can return short transfers or fail between them. */
class ControlledHandle {
  public contents = Buffer.alloc(0);
  public writePlan: Progress[] = [];
  public readPlan: Progress[] = [];
  public writeCalls: { buffers: string[]; position: number }[] = [];
  public readCalls: { offset: number; length: number; position: number }[] = [];
  public syncError: Error | null = null;
  public closeError: Error | null = null;
  public syncCalls = 0;

  public async writev(buffers: Buffer[], position: number) {
    this.writeCalls.push({ buffers: buffers.map((buffer) => buffer.toString()), position });
    const next = this.writePlan.shift();
    if (next instanceof Error) throw next;
    const requested = Buffer.concat(buffers);
    const bytesWritten = Math.min(next ?? requested.length, requested.length);
    const size = Math.max(this.contents.length, position + bytesWritten);
    const contents = Buffer.alloc(size);
    this.contents.copy(contents);
    requested.copy(contents, position, 0, bytesWritten);
    this.contents = contents;
    return Promise.resolve({ bytesWritten, buffers });
  }

  public async read(buffer: Buffer, offset: number, length: number, position: number) {
    this.readCalls.push({ offset, length, position });
    const next = this.readPlan.shift();
    if (next instanceof Error) throw next;
    const bytesRead = Math.min(next ?? length, length, Math.max(0, this.contents.length - position));
    if (bytesRead > 0) this.contents.copy(buffer, offset, position, position + bytesRead);
    return Promise.resolve({ bytesRead, buffer });
  }

  public async sync() {
    this.syncCalls++;
    if (this.syncError) throw this.syncError;
    return Promise.resolve();
  }

  public async close() {
    if (this.closeError) throw this.closeError;
    return Promise.resolve();
  }

  public async truncate(length: number) {
    const contents = Buffer.alloc(length);
    this.contents.copy(contents);
    this.contents = contents;
    return Promise.resolve();
  }

  public async stat() {
    return Promise.resolve({ size: this.contents.length });
  }
}

function withHandle(handle: ControlledHandle): RealFile {
  const file = new RealFile('fault-injected.bin');
  (file as unknown as { fileHandle: ControlledHandle }).fileHandle = handle;
  // The injected handle is already open; production read/write methods still run unchanged.
  file.open = () => Promise.resolve();
  return file;
}

function openedHandle(file: RealFile): FileHandle {
  return (file as unknown as { fileHandle: FileHandle }).fileHandle;
}

async function inTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'siftwell-file-integrity-'));
  const withinRoot = relative(temporaryRoot, resolve(directory));
  if (withinRoot.startsWith('..') || resolve(directory) === temporaryRoot) {
    throw new Error('File integrity test directory is outside the temporary directory');
  }
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('RealFile complete positional I/O', () => {
  it('continues short vector writes within and across buffers without changing input buffers', async () => {
    const handle = new ControlledHandle();
    handle.writePlan = [2, 3, 1, 4];
    const file = withHandle(handle);
    const buffers = ['', 'abc', '', 'defg', 'hij', ''].map((part) => Buffer.from(part));
    const original = buffers.map((buffer) => Buffer.from(buffer));

    await file.writev(buffers, 5);

    expect(handle.contents).toEqual(Buffer.concat([Buffer.alloc(5), Buffer.from('abcdefghij')]));
    expect(handle.writeCalls).toEqual([
      { buffers: ['abc', 'defg', 'hij'], position: 5 },
      { buffers: ['c', 'defg', 'hij'], position: 7 },
      { buffers: ['fg', 'hij'], position: 10 },
      { buffers: ['g', 'hij'], position: 11 },
    ]);
    expect(buffers).toEqual(original);
  });

  it('retries a short single-buffer write at the remaining offset', async () => {
    const handle = new ControlledHandle();
    handle.writePlan = [1, 2, 2];
    await withHandle(handle).writev([Buffer.from('hello')], 20);
    expect(handle.contents.subarray(20)).toEqual(Buffer.from('hello'));
    expect(handle.writeCalls.map((call) => call.position)).toEqual([20, 21, 23]);
  });

  it.each([{ plan: [0] }, { plan: [2, 0] }])('rejects a zero-progress write with plan $plan', async ({ plan }) => {
    const handle = new ControlledHandle();
    handle.writePlan = [...plan];
    await expect(withHandle(handle).writev([Buffer.from('hello')], 0)).rejects.toThrow(/progress|zero|incomplete/i);
    expect(handle.writeCalls).toHaveLength(plan.length);
  });

  it('propagates a write error after partial progress without restarting the write', async () => {
    const failure = new Error('write device failure');
    const handle = new ControlledHandle();
    handle.writePlan = [2, failure];
    await expect(withHandle(handle).writev([Buffer.from('hello')], 0)).rejects.toBe(failure);
    expect(handle.contents).toEqual(Buffer.from('he'));
    expect(handle.writeCalls.map((call) => call.position)).toEqual([0, 2]);
  });

  it('does not call the handle for empty vector writes', async () => {
    const handle = new ControlledHandle();
    const file = withHandle(handle);
    await file.writev([], 0);
    await file.writev([Buffer.alloc(0), Buffer.alloc(0)], 0);
    expect(handle.writeCalls).toEqual([]);
  });

  it('fills the buffer over short reads while advancing buffer and file offsets', async () => {
    const handle = new ControlledHandle();
    handle.contents = Buffer.from('prefixpayloadsuffix');
    handle.readPlan = [2, 1, 4];
    const buffer = Buffer.alloc(7, 0xff);
    await withHandle(handle).read(buffer, { position: 6 });
    expect(buffer).toEqual(Buffer.from('payload'));
    expect(handle.readCalls).toEqual([
      { offset: 0, length: 7, position: 6 },
      { offset: 2, length: 5, position: 8 },
      { offset: 3, length: 4, position: 9 },
    ]);
  });

  it.each([{ plan: [0] }, { plan: [2, 0] }])('rejects a zero-progress read with plan $plan', async ({ plan }) => {
    const handle = new ControlledHandle();
    handle.contents = Buffer.from('hello');
    handle.readPlan = [...plan];
    await expect(withHandle(handle).read(Buffer.alloc(5, 0xff), { position: 0 })).rejects.toThrow(/EOF|end of file/i);
    expect(handle.readCalls).toHaveLength(plan.length);
  });

  it('rejects unexpected EOF instead of returning a partially filled buffer', async () => {
    const handle = new ControlledHandle();
    handle.contents = Buffer.from('hi');
    await expect(withHandle(handle).read(Buffer.alloc(5, 0xff), { position: 0 })).rejects.toThrow(/EOF|end of file/i);
    expect(handle.readCalls.map((call) => call.position)).toEqual([0, 2]);
  });

  it('propagates a read error after partial progress', async () => {
    const failure = new Error('read device failure');
    const handle = new ControlledHandle();
    handle.contents = Buffer.from('hello');
    handle.readPlan = [2, failure];
    await expect(withHandle(handle).read(Buffer.alloc(5), { position: 0 })).rejects.toBe(failure);
    expect(handle.readCalls.map((call) => call.position)).toEqual([0, 2]);
  });

  it('allows an empty read without accessing the handle', async () => {
    const handle = new ControlledHandle();
    await withHandle(handle).read(Buffer.alloc(0), { position: 100 });
    expect(handle.readCalls).toEqual([]);
  });

  it('propagates sync and close errors and keeps the handle available for retry', async () => {
    const handle = new ControlledHandle();
    const file = withHandle(handle);
    const syncFailure = new Error('sync failed');
    const closeFailure = new Error('close failed');
    handle.syncError = syncFailure;
    handle.closeError = closeFailure;
    await expect(file.sync()).rejects.toBe(syncFailure);
    await expect(file.close()).rejects.toBe(closeFailure);
    handle.syncError = null;
    handle.closeError = null;
    await file.sync();
    await file.close();
    expect(handle.syncCalls).toBe(2);
  });
});

describe('RealFile-backed AtomicFile transfer failures', () => {
  it('completes short WAL and data writes before reporting a successful commit', async () => {
    const dataHandle = new ControlledHandle();
    const logHandle = new ControlledHandle();
    dataHandle.writePlan = [2, 3];
    logHandle.writePlan = [2, 1, 7];
    const atomic = new AtomicFile(withHandle(dataHandle), withHandle(logHandle));
    await atomic.open();
    const updates = new Map([[11, Buffer.from('complete data')]]);

    expect(await atomic.atomicWrite(updates)).toBe(true);
    expect(dataHandle.contents.subarray(11)).toEqual(Buffer.from('complete data'));
    expect(dataHandle.writeCalls).toHaveLength(3);
    expect(logHandle.writeCalls).toHaveLength(4);
    expect(logHandle.contents).toHaveLength(0);
    expect(dataHandle.syncCalls).toBe(1);
  });

  it.each(['zero', 'error'] as const)('does not acknowledge an incomplete WAL write ending in %s', async (ending) => {
    const dataHandle = new ControlledHandle();
    const logHandle = new ControlledHandle();
    logHandle.writePlan = [2, ending === 'zero' ? 0 : new Error('WAL write failed')];
    const atomic = new AtomicFile(withHandle(dataHandle), withHandle(logHandle));
    await atomic.open();

    await expect(atomic.atomicWrite(new Map([[0, Buffer.from('new data')]]))).rejects.toThrow();
    expect(dataHandle.writeCalls).toEqual([]);
    expect(dataHandle.syncCalls).toBe(0);
    expect(logHandle.contents).toHaveLength(2);
    const incompleteWal = Buffer.from(logHandle.contents);
    await expect(atomic.recover()).rejects.toThrow(/invalid|incomplete/i);
    await expect(atomic.atomicWrite(new Map([[0, Buffer.from('other data')]]))).rejects.toThrow(/recovery/i);
    expect(logHandle.contents).toEqual(incompleteWal);
  });

  it.each(['zero', 'error'] as const)(
    'retains a complete WAL after an incomplete data write ending in %s',
    async (ending) => {
      const dataHandle = new ControlledHandle();
      const logHandle = new ControlledHandle();
      dataHandle.writePlan = [2, ending === 'zero' ? 0 : new Error('data write failed')];
      const atomic = new AtomicFile(withHandle(dataHandle), withHandle(logHandle));
      await atomic.open();
      const initialLogSyncs = logHandle.syncCalls;

      await expect(atomic.atomicWrite(new Map([[0, Buffer.from('new data')]]))).rejects.toThrow();
      expect(dataHandle.contents).toEqual(Buffer.from('ne'));
      expect(logHandle.contents.length).toBeGreaterThan(2);
      expect(logHandle.syncCalls).toBe(initialLogSyncs + 1);
      expect(dataHandle.syncCalls).toBe(0);
      const wal = Buffer.from(logHandle.contents);
      await expect(atomic.atomicWrite(new Map([[0, Buffer.from('other data')]]))).rejects.toThrow(/recovery/i);
      expect(logHandle.contents).toEqual(wal);

      await atomic.recover();
      expect(dataHandle.contents).toEqual(Buffer.from('new data'));
      expect(logHandle.contents).toHaveLength(0);
    },
  );
});

describe('RealFile persistence and truncated-block detection', () => {
  it('preserves positional vector writes, sparse offsets, and exact EOF reads across reopen', async () => {
    await inTemporaryDirectory(async (directory) => {
      const path = join(directory, 'data.bin');
      const writer = new RealFile(path);
      await writer.create();
      try {
        await writer.writev([Buffer.from('abc'), Buffer.alloc(0), Buffer.from('def')], 10);
        await writer.sync();
      } finally {
        await writer.close();
      }

      const reader = new RealFile(path);
      await reader.open();
      try {
        const buffer = Buffer.alloc(6, 0xff);
        await reader.read(buffer, { position: 10 });
        expect(buffer).toEqual(Buffer.from('abcdef'));
        expect(await reader.stat()).toMatchObject({ size: 16 });
        await expect(reader.read(Buffer.alloc(7), { position: 10 })).rejects.toThrow(/EOF|end of file/i);
        await expect(reader.read(Buffer.alloc(1), { position: 16 })).rejects.toThrow(/EOF|end of file/i);
        await reader.read(Buffer.alloc(0), { position: 16 });
      } finally {
        await reader.close();
      }
      expect(await readFile(path)).toEqual(Buffer.concat([Buffer.alloc(10), Buffer.from('abcdef')]));
    });
  });

  it('commits through a real WAL and reopens the complete data', async () => {
    await inTemporaryDirectory(async (directory) => {
      const dataPath = join(directory, 'data.bin');
      const walPath = join(directory, 'log.wal');
      const atomic = new AtomicFile(new RealFile(dataPath), new RealFile(walPath));
      await atomic.create();
      const payload = Buffer.alloc(8192, 0xa7);
      payload.write('persistent record');
      try {
        expect(await atomic.atomicWrite(new Map([[513, payload]]))).toBe(true);
      } finally {
        await atomic.close();
      }

      const reopened = new AtomicFile(new RealFile(dataPath), new RealFile(walPath));
      await reopened.open();
      try {
        const buffer = Buffer.alloc(payload.length);
        await reopened.read(buffer, { position: 513 });
        expect(buffer).toEqual(payload);
        expect((await stat(walPath)).size).toBe(0);
      } finally {
        await reopened.close();
      }
    });
  });

  it.each(['zero', 'error'] as const)(
    'recovers a real partial data write ending in %s after closing and reopening',
    async (ending) => {
      await inTemporaryDirectory(async (directory) => {
        const dataPath = join(directory, 'partial.bin');
        const walPath = join(directory, 'partial.wal');
        const dataFile = new RealFile(dataPath);
        const atomic = new AtomicFile(dataFile, new RealFile(walPath));
        await atomic.create();
        const handle = openedHandle(dataFile);
        const write = handle.writev.bind(handle);
        const payload = Buffer.from('complete recovered bytes');
        let calls = 0;
        const fault = vi.spyOn(handle, 'writev').mockImplementation((buffers, position) => {
          calls++;
          if (calls === 1) {
            const first = buffers[0];
            return write([Buffer.from(first.buffer, first.byteOffset, 2)], position);
          }
          if (ending === 'zero') return Promise.resolve({ bytesWritten: 0, buffers });
          return Promise.reject(new Error('real data transfer interrupted'));
        });
        try {
          await expect(atomic.atomicWrite(new Map([[0, payload]]))).rejects.toThrow();
          expect(calls).toBe(2);
          expect(await readFile(dataPath)).toEqual(payload.subarray(0, 2));
          expect((await stat(walPath)).size).toBeGreaterThan(0);
        } finally {
          fault.mockRestore();
          await atomic.close();
        }

        const reopened = new AtomicFile(new RealFile(dataPath), new RealFile(walPath));
        await reopened.open();
        try {
          const buffer = Buffer.alloc(payload.length);
          await reopened.read(buffer, { position: 0 });
          expect(buffer).toEqual(payload);
          expect((await stat(walPath)).size).toBe(0);
        } finally {
          await reopened.close();
        }
        expect(await readFile(dataPath)).toEqual(payload);
      });
    },
  );

  it('rejects a physically truncated FreeBlockFile header on reopen', async () => {
    await inTemporaryDirectory(async (directory) => {
      const dataPath = join(directory, 'blocks.bin');
      const walPath = join(directory, 'blocks.wal');
      const original = new FreeBlockFile(new AtomicFile(new RealFile(dataPath), new RealFile(walPath)), 512);
      await original.create();
      await original.close();
      const raw = new RealFile(dataPath);
      await raw.open();
      try {
        await raw.truncate(2);
        await raw.sync();
      } finally {
        await raw.close();
      }

      const reopened = new FreeBlockFile(new AtomicFile(new RealFile(dataPath), new RealFile(walPath)), 512);
      try {
        await expect(reopened.open()).rejects.toThrow();
        expect((await stat(dataPath)).size).toBe(2);
      } finally {
        await reopened.close();
      }
    });
  });
});
