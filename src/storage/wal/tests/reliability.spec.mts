import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RealFile } from '../../file.mjs';
import { AtomicFile, encodeWalPayload } from '../atomicfile.mjs';
import { computeChecksum } from '../logrecord.mjs';
import { writeAndSyncLog } from '../logwriter.mjs';
import { SimpleDbms } from '../../../database/simpledbms.mjs';
import { DatabaseService } from '../../../webclient/server/service.mjs';

class FaultFile extends RealFile {
  writeFailure: Error | undefined;
  syncFailure: Error | undefined;
  truncateFailure: Error | undefined;
  readFailure: Error | undefined;
  failWriteAt: number | undefined;
  failSyncAt: number | undefined;
  writes = 0;
  syncs = 0;

  override async writev(buffers: Buffer[], position: number): Promise<void> {
    this.writes++;
    if (this.writeFailure || this.writes === this.failWriteAt)
      throw this.writeFailure ?? new Error('injected later write failure');
    await super.writev(buffers, position);
  }

  override async sync(): Promise<void> {
    this.syncs++;
    if (this.syncFailure || this.syncs === this.failSyncAt)
      throw this.syncFailure ?? new Error('injected cleanup sync failure');
    await super.sync();
  }

  override async truncate(length: number): Promise<void> {
    if (this.truncateFailure) throw this.truncateFailure;
    await super.truncate(length);
  }

  override async read(buffer: Buffer, options: { position: number }): Promise<void> {
    if (this.readFailure) throw this.readFailure;
    await super.read(buffer, options);
  }
}

async function withFiles(task: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'siftwell-wal-reliability-'));
  const withinTemp = relative(resolve(tmpdir()), resolve(directory));
  if (withinTemp.startsWith('..') || resolve(directory) === resolve(tmpdir())) {
    throw new Error('Unsafe temporary directory');
  }
  try {
    await task(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function seedPendingLog(directory: string): Promise<Buffer> {
  const initial = new AtomicFile(new RealFile(join(directory, 'data')), new RealFile(join(directory, 'wal')));
  await initial.create();
  await initial.atomicWrite(new Map([[0, Buffer.alloc(512, 1)]]));
  await initial.close();
  const log = new RealFile(join(directory, 'wal'));
  await log.open();
  try {
    const payload = encodeWalPayload(new Map([[0, Buffer.alloc(512, 2)]]));
    await writeAndSyncLog(log, { position: 0, data: payload, checksum: computeChecksum(payload) });
  } finally {
    await log.close();
  }
  return readFile(join(directory, 'wal'));
}

describe('WAL reliability with real files and injected failures', () => {
  it('replays the complete write set after a later data write fails', async () => {
    await withFiles(async (directory) => {
      const data = new FaultFile(join(directory, 'data'));
      const atomic = new AtomicFile(data, new RealFile(join(directory, 'wal')));
      await atomic.create();
      const updates = new Map([
        [0, Buffer.alloc(512, 2)],
        [512, Buffer.alloc(512, 3)],
        [1024, Buffer.alloc(512, 4)],
      ]);
      data.failWriteAt = 2;
      try {
        await expect(atomic.atomicWrite(updates)).rejects.toThrow('later write failure');
        expect(await readFile(join(directory, 'data'))).toEqual(Buffer.alloc(512, 2));
        const pending = await readFile(join(directory, 'wal'));
        await expect(atomic.atomicWrite(new Map([[0, Buffer.alloc(512, 9)]]))).rejects.toThrow(/recovery/i);
        expect(await readFile(join(directory, 'wal'))).toEqual(pending);
      } finally {
        await atomic.close();
      }
      const reopened = new AtomicFile(new RealFile(join(directory, 'data')), new RealFile(join(directory, 'wal')));
      try {
        await reopened.open();
        await reopened.recover();
        expect(await readFile(join(directory, 'data'))).toEqual(Buffer.concat([...updates.values()]));
        expect((await stat(join(directory, 'wal'))).size).toBe(0);
      } finally {
        await reopened.close();
      }
    });
  });

  it.each(['wal-sync', 'cleanup-sync'] as const)(
    'rejects a commit at %s and recovers using fresh handles',
    async (failure) => {
      await withFiles(async (directory) => {
        const log = new FaultFile(join(directory, 'wal'));
        const atomic = new AtomicFile(new RealFile(join(directory, 'data')), log);
        await atomic.create();
        log.failSyncAt = log.syncs + (failure === 'wal-sync' ? 1 : 2);
        try {
          await expect(atomic.atomicWrite(new Map([[0, Buffer.alloc(512, 7)]]))).rejects.toThrow(/sync failure/);
          expect(atomic.requiresRecovery).toBe(true);
          expect((await readFile(join(directory, 'data'))).length).toBe(failure === 'wal-sync' ? 0 : 512);
          expect((await stat(join(directory, 'wal'))).size === 0).toBe(failure === 'cleanup-sync');
          await expect(atomic.atomicWrite(new Map())).rejects.toThrow(/recovery/i);
        } finally {
          await atomic.close();
        }
        const reopened = new AtomicFile(new RealFile(join(directory, 'data')), new RealFile(join(directory, 'wal')));
        try {
          await reopened.open();
          expect(await readFile(join(directory, 'data'))).toEqual(Buffer.alloc(512, 7));
          expect((await stat(join(directory, 'wal'))).size).toBe(0);
        } finally {
          await reopened.close();
        }
      });
    },
  );

  it('retries an incomplete replay in place and refuses all reads, writes and empty commits until then', async () => {
    await withFiles(async (directory) => {
      const pending = await seedPendingLog(directory);
      const data = new FaultFile(join(directory, 'data'));
      data.writeFailure = new Error('temporary replay write failure');
      const atomic = new AtomicFile(data, new RealFile(join(directory, 'wal')));
      try {
        await expect(atomic.open()).rejects.toThrow('temporary replay write failure');
        expect(atomic.requiresRecovery).toBe(true);
        await expect(atomic.read(Buffer.alloc(512), { position: 0 })).rejects.toThrow(/recovery/i);
        await expect(atomic.writev([Buffer.alloc(512, 3)], 0)).rejects.toThrow(/recovery/i);
        await expect(atomic.truncate(0)).rejects.toThrow(/recovery/i);
        await expect(atomic.sync()).rejects.toThrow(/recovery/i);
        await expect(atomic.atomicWrite(new Map())).rejects.toThrow(/recovery/i);
        expect(await readFile(join(directory, 'wal'))).toEqual(pending);
        data.writeFailure = undefined;
        await atomic.open(); // An already acquired handle must not bypass failed recovery.
        expect(atomic.requiresRecovery).toBe(false);
        await atomic.recover();
        await atomic.read(Buffer.alloc(512), { position: 0 });
        expect(await atomic.atomicWrite(new Map([[0, Buffer.alloc(512, 3)]]))).toBe(true);
      } finally {
        await atomic.close();
      }
      expect(await readFile(join(directory, 'data'))).toEqual(Buffer.alloc(512, 3));
    });
  });

  it.each(['truncate', 'sync'] as const)(
    'does not acknowledge failed WAL cleanup at %s and permits retry',
    async (failure) => {
      await withFiles(async (directory) => {
        const pending = await seedPendingLog(directory);
        const log = new FaultFile(join(directory, 'wal'));
        if (failure === 'truncate') log.truncateFailure = new Error('cleanup truncate failed');
        else log.failSyncAt = 1;
        const atomic = new AtomicFile(new RealFile(join(directory, 'data')), log);
        try {
          await expect(atomic.open()).rejects.toThrow(/cleanup/);
          expect(atomic.requiresRecovery).toBe(true);
          expect(await readFile(join(directory, 'data'))).toEqual(Buffer.alloc(512, 2));
          if (failure === 'truncate') expect(await readFile(join(directory, 'wal'))).toEqual(pending);
          await expect(atomic.atomicWrite(new Map([[0, Buffer.alloc(512, 3)]]))).rejects.toThrow(/recovery/i);
          log.truncateFailure = undefined;
          await atomic.recover();
          expect(atomic.requiresRecovery).toBe(false);
          expect((await stat(join(directory, 'wal'))).size).toBe(0);
        } finally {
          await atomic.close();
        }
      });
    },
  );

  it('preserves WAL when reading it fails, and retries with fresh file handles', async () => {
    await withFiles(async (directory) => {
      const pending = await seedPendingLog(directory);
      const log = new FaultFile(join(directory, 'wal'));
      log.readFailure = new Error('temporary WAL read failure');
      const atomic = new AtomicFile(new RealFile(join(directory, 'data')), log);
      try {
        await expect(atomic.open()).rejects.toThrow('temporary WAL read failure');
        expect(await readFile(join(directory, 'wal'))).toEqual(pending);
      } finally {
        await atomic.close();
      }
      const reopened = new AtomicFile(new RealFile(join(directory, 'data')), new RealFile(join(directory, 'wal')));
      await reopened.open();
      await reopened.close();
      expect(await readFile(join(directory, 'data'))).toEqual(Buffer.alloc(512, 2));
    });
  });

  it.each(['truncated', 'checksum', 'payload'] as const)(
    'preserves %s WAL and rejects every reopen without changing data',
    async (kind) => {
      await withFiles(async (directory) => {
        const pending = await seedPendingLog(directory);
        let malformed = Buffer.from(pending);
        if (kind === 'truncated') malformed = malformed.subarray(0, 48);
        else if (kind === 'checksum') malformed[8] ^= 1;
        else {
          malformed.writeUInt32BE(999, 40); // Invalid payload count with an otherwise valid framing/checksum.
          computeChecksum(malformed.subarray(40, 40 + malformed.readUInt32BE(4))).copy(malformed, 8);
        }
        await writeFile(join(directory, 'wal'), malformed);
        for (let retry = 0; retry < 2; retry++) {
          const atomic = new AtomicFile(new RealFile(join(directory, 'data')), new RealFile(join(directory, 'wal')));
          try {
            await expect(atomic.open()).rejects.toThrow(/WAL is invalid or incomplete/);
            await expect(atomic.atomicWrite(new Map([[0, Buffer.alloc(512, 3)]]))).rejects.toThrow(/recovery/i);
          } finally {
            await atomic.close();
          }
          expect(await readFile(join(directory, 'wal'))).toEqual(malformed);
          expect(await readFile(join(directory, 'data'))).toEqual(Buffer.alloc(512, 1));
        }
      });
    },
  );

  it('does not replace a pending WAL discovered before the next commit', async () => {
    await withFiles(async (directory) => {
      await seedPendingLog(directory);
      const atomic = new AtomicFile(new RealFile(join(directory, 'data')), new RealFile(join(directory, 'wal')));
      await atomic.open();
      const payload = encodeWalPayload(new Map([[0, Buffer.alloc(512, 4)]]));
      const log = new RealFile(join(directory, 'wal'));
      await log.open();
      await writeAndSyncLog(log, { position: 0, data: payload, checksum: computeChecksum(payload) });
      await log.close();
      const pending = await readFile(join(directory, 'wal'));
      try {
        await expect(atomic.atomicWrite(new Map([[0, Buffer.alloc(512, 3)]]))).rejects.toThrow(/recovery/i);
        expect(await readFile(join(directory, 'wal'))).toEqual(pending);
        await atomic.recover();
      } finally {
        await atomic.close();
      }
      expect(await readFile(join(directory, 'data'))).toEqual(Buffer.alloc(512, 4));
    });
  });

  it('blocks backend and service mutations after failed commit and recovers the original write set on reopen', async () => {
    await withFiles(async (directory) => {
      const data = new FaultFile(join(directory, 'data'));
      const database = await SimpleDbms.create(data, new RealFile(join(directory, 'wal')));
      await database.insertDocumentObject('docs', { id: 1, score: 1 });
      await database.commit();
      const service = new DatabaseService();
      (service as unknown as { dbms: SimpleDbms }).dbms = database;
      data.writeFailure = new Error('commit data write failed');
      try {
        await expect(service.insertDocument('docs', { id: 2, score: 2 })).rejects.toThrow('commit data write failed');
        const pending = await readFile(join(directory, 'wal'));
        expect(pending.length).toBeGreaterThan(0);
        await expect(service.insertDocument('docs', { id: 3, score: 3 })).rejects.toThrow(/recovery/i);
        await expect(service.query('SELECT * FROM docs')).rejects.toThrow(/recovery/i);
        await expect(database.commit()).rejects.toThrow(/recovery/i);
        expect(() => database.setFieldCompressionDefaults('docs', {})).toThrow(/recovery/i);
        expect(await readFile(join(directory, 'wal'))).toEqual(pending);
      } finally {
        await database.close();
      }
      const reopened = await SimpleDbms.open(
        new RealFile(join(directory, 'data')),
        new RealFile(join(directory, 'wal')),
      );
      try {
        expect(await reopened.getDocumentObjectById('docs', 1)).toEqual({ id: 1, score: 1 });
        expect(await reopened.getDocumentObjectById('docs', 2)).toEqual({ id: 2, score: 2 });
        await expect(reopened.getDocumentById('docs', 3)).rejects.toThrow('Document not found');
        const indexed: string[] = [];
        for await (const row of reopened.cursorEqual('docs', 'score', 2)) indexed.push(row);
        expect(indexed.map((raw) => (JSON.parse(raw) as { id: number }).id)).toEqual([2]);
      } finally {
        await reopened.close();
      }
    });
  });

  it.each(['write', 'sync'] as const)('preserves valid WAL after replay %s failure across reopen', async (failure) => {
    await withFiles(async (directory) => {
      const pending = await seedPendingLog(directory);
      const data = new FaultFile(join(directory, 'data'));
      const injected = new Error(`injected replay ${failure} failure`);
      if (failure === 'write') data.writeFailure = injected;
      else data.syncFailure = injected;
      const failing = new AtomicFile(data, new RealFile(join(directory, 'wal')));
      try {
        await expect(failing.open()).rejects.toThrow(injected.message);
        expect(await readFile(join(directory, 'wal'))).toEqual(pending);
        await expect(failing.atomicWrite(new Map([[0, Buffer.alloc(512, 3)]]))).rejects.toThrow(/recovery/i);
        expect(await readFile(join(directory, 'wal'))).toEqual(pending);
      } finally {
        await failing.close();
      }
      const recovered = new AtomicFile(new RealFile(join(directory, 'data')), new RealFile(join(directory, 'wal')));
      await recovered.open();
      await recovered.close();
      expect(await readFile(join(directory, 'data'))).toEqual(Buffer.alloc(512, 2));
      expect((await stat(join(directory, 'wal'))).size).toBe(0);
      await recovered.open();
      await recovered.close();
      expect(await readFile(join(directory, 'data'))).toEqual(Buffer.alloc(512, 2));
    });
  });
});
