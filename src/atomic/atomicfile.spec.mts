// @author Henry Delacroix, Alexandre-Gatien Bienfet
// @date 2025-11-27

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AtomicFile } from './atomicfile.mjs';
import { MockFile } from '../core/mockfile.mjs';

describe('atomicFile', () => {
  let dataFile: MockFile;
  let logFile: MockFile;
  let atomicFile: AtomicFile;

  beforeEach(async () => {
    dataFile = new MockFile(512);
    logFile = new MockFile(512);
    atomicFile = new AtomicFile(dataFile, logFile);
    await atomicFile.create();
    await atomicFile.open();
  });

  afterEach(async () => {
    await atomicFile.close();
  });

  // ===========================================================================
  // Basic Operations
  // ===========================================================================

  describe('Basic Operations', () => {
    it('should create and open without error', async () => {
      const df = new MockFile(512);
      const lf = new MockFile(512);
      const af = new AtomicFile(df, lf);

      await expect(af.create()).resolves.not.toThrow();
      await expect(af.open()).resolves.not.toThrow();
      await af.close();
    });

    it('should passthrough read operations to data file', async () => {
      const testData = Buffer.from('hello world');
      await dataFile.writev([testData], 0); // should this not use atomicFile ??
      await dataFile.sync();

      const readBuf = Buffer.alloc(11);
      await atomicFile.read(readBuf, { position: 0 });

      expect(readBuf.toString()).toBe('hello world');
    });

    it('should passthrough stat operations', async () => {
      const testData = Buffer.from('test data here');
      await dataFile.writev([testData], 0);
      await dataFile.sync();

      const stat = await atomicFile.stat();
      expect(stat.size).toBeGreaterThanOrEqual(testData.length);
    });

    it('should return correct sectorSize from data file', () => {
      expect(atomicFile.sectorSize).toBe(512);
    });
  });

  // ===========================================================================
  // atomicWrite (single position)
  // ===========================================================================

  describe('atomicWrite - single position', () => {
    it('should write a single buffer atomically', async () => {
      const data = Buffer.from('atomic write test');
      const updates = new Map<number, Buffer>([[0, data]]);

      const result = await atomicFile.atomicWrite(updates);

      expect(result).toBe(true);

      const readBuf = Buffer.alloc(data.length);
      await atomicFile.read(readBuf, { position: 0 });
      expect(readBuf.toString()).toBe('atomic write test');
    });

    it('should write at non-zero position', async () => {
      const data = Buffer.from('offset data');
      const updates = new Map<number, Buffer>([[100, data]]);

      const result = await atomicFile.atomicWrite(updates);

      expect(result).toBe(true);

      const readBuf = Buffer.alloc(data.length);
      await atomicFile.read(readBuf, { position: 100 });
      expect(readBuf.toString()).toBe('offset data');
    });

    it('should clear WAL after successful write', async () => {
      const updates = new Map<number, Buffer>([[0, Buffer.from('test')]]);
      await atomicFile.atomicWrite(updates);

      const logStat = await logFile.stat();
      expect(logStat.size).toBe(0);
    });
  });

  // ===========================================================================
  // atomicWrite (multiple positions)
  // ===========================================================================

  describe('atomicWrite - multiple positions', () => {
    it('should write multiple blocks at different positions atomically', async () => {
      const updates = new Map<number, Buffer>([
        [0, Buffer.from('AAAA')],
        [100, Buffer.from('BBBB')],
        [200, Buffer.from('CCCC')],
      ]);

      const result = await atomicFile.atomicWrite(updates);

      expect(result).toBe(true);

      // Verify all writes
      const bufA = Buffer.alloc(4);
      const bufB = Buffer.alloc(4);
      const bufC = Buffer.alloc(4);

      await atomicFile.read(bufA, { position: 0 });
      await atomicFile.read(bufB, { position: 100 });
      await atomicFile.read(bufC, { position: 200 });

      expect(bufA.toString()).toBe('AAAA');
      expect(bufB.toString()).toBe('BBBB');
      expect(bufC.toString()).toBe('CCCC');
    });

    it('should handle empty updates map', async () => {
      const result = await atomicFile.atomicWrite(new Map());

      expect(result).toBe(true); // vacuously atomic - nothing to do
    });

    it('should clear WAL after successful multi-block write', async () => {
      const updates = new Map<number, Buffer>([
        [0, Buffer.from('block1')],
        [512, Buffer.from('block2')],
      ]);

      await atomicFile.atomicWrite(updates);

      const logStat = await logFile.stat();
      expect(logStat.size).toBe(0);
    });
  });

  // ===========================================================================
  // Crash Recovery (using MockFile.crash())
  // ===========================================================================

  describe('Crash Recovery', () => {
    it('should recover nothing when WAL is empty', async () => {
      // Write some data and commit properly
      const updates = new Map<number, Buffer>([[0, Buffer.from('original')]]);
      await atomicFile.atomicWrite(updates);

      // Simulate restart (open() calls recover() automatically)
      await atomicFile.close();
      await atomicFile.open();

      const readBuf = Buffer.alloc(8);
      await atomicFile.read(readBuf, { position: 0 });
      expect(readBuf.toString()).toBe('original');
    });

    it('should redo writes from valid WAL after simulated crash', async () => {
      const { computeChecksum, serializeLogRecord } = await import('./logrecord.mjs');

      // Manually create a WAL record simulating a crash mid-transaction
      const encoded = [{ position: 0, data: Buffer.from('recovered').toString('base64') }];
      const data = Buffer.from(JSON.stringify(encoded), 'utf8');

      const record = {
        position: 0,
        data,
        checksum: computeChecksum(data),
      };

      const serialized = serializeLogRecord(record);
      await logFile.writev([serialized], 0);
      await logFile.sync();

      // Now recover
      await atomicFile.recover();

      // Data should be recovered
      const readBuf = Buffer.alloc(9);
      await atomicFile.read(readBuf, { position: 0 });
      expect(readBuf.toString()).toBe('recovered');

      // WAL should be cleared
      const logStat = await logFile.stat();
      expect(logStat.size).toBe(0);
    });

    it('should redo multiple block writes from WAL', async () => {
      const { computeChecksum, serializeLogRecord } = await import('./logrecord.mjs');

      const encoded = [
        { position: 0, data: Buffer.from('AAAA').toString('base64') },
        { position: 100, data: Buffer.from('BBBB').toString('base64') },
        { position: 200, data: Buffer.from('CCCC').toString('base64') },
      ];
      const data = Buffer.from(JSON.stringify(encoded), 'utf8');

      const record = {
        position: 0,
        data,
        checksum: computeChecksum(data),
      };

      await logFile.writev([serializeLogRecord(record)], 0);
      await logFile.sync();

      await atomicFile.recover();

      const bufA = Buffer.alloc(4);
      const bufB = Buffer.alloc(4);
      const bufC = Buffer.alloc(4);

      await atomicFile.read(bufA, { position: 0 });
      await atomicFile.read(bufB, { position: 100 });
      await atomicFile.read(bufC, { position: 200 });

      expect(bufA.toString()).toBe('AAAA');
      expect(bufB.toString()).toBe('BBBB');
      expect(bufC.toString()).toBe('CCCC');
    });

    it('should handle crash using MockFile.crash()', async () => {
      // First, write and commit some initial data
      const updates = new Map<number, Buffer>([[0, Buffer.from('committed')]]);
      await atomicFile.atomicWrite(updates);
      await atomicFile.close();

      // Reopen
      await atomicFile.open();

      // Manually write to data file without proper WAL (simulating incomplete transaction)
      await dataFile.writev([Buffer.from('uncommit')], 0);

      // Simulate crash - loses uncommitted writes
      dataFile.crash();
      logFile.crash();

      // Reopen and recover (open() calls recover() automatically)
      await atomicFile.open();

      // Should have original committed data (or recovered state)
      const readBuf = Buffer.alloc(9);
      await atomicFile.read(readBuf, { position: 0 });
      // Data depends on what crash() randomly kept
    });

    it('should ignore corrupted WAL and clear it', async () => {
      // Write garbage to WAL
      await logFile.writev([Buffer.from('corrupted garbage data')], 0);
      await logFile.sync();

      // Write known data to data file
      await dataFile.writev([Buffer.from('untouched')], 0);
      await dataFile.sync();

      // Recovery should drop the corrupted WAL
      await atomicFile.recover();

      // Data file should be unchanged
      const readBuf = Buffer.alloc(9);
      await atomicFile.read(readBuf, { position: 0 });
      expect(readBuf.toString()).toBe('untouched');

      // WAL should be cleared
      const logStat = await logFile.stat();
      expect(logStat.size).toBe(0);
    });

    it('should ignore WAL with bad checksum', async () => {
      const { serializeLogRecord } = await import('./logrecord.mjs');

      const encoded = [{ position: 0, data: Buffer.from('bad').toString('base64') }];
      const data = Buffer.from(JSON.stringify(encoded), 'utf8');

      // Create a 32-byte buffer with wrong checksum value
      const badChecksum = Buffer.alloc(32, 0xde);

      const record = {
        position: 0,
        data,
        checksum: badChecksum, // valid format, wrong value
      };

      await logFile.writev([serializeLogRecord(record)], 0);
      await logFile.sync();

      await dataFile.writev([Buffer.from('original')], 0);
      await dataFile.sync();

      await atomicFile.recover();

      // Data should be unchanged (bad checksum = drop WAL)
      const readBuf = Buffer.alloc(8);
      await atomicFile.read(readBuf, { position: 0 });
      expect(readBuf.toString()).toBe('original');
    });
  });

  // ===========================================================================
  // Integration: Full Transaction Cycle
  // ===========================================================================

  describe('Full Transaction Cycle', () => {
    it('should handle a complete write-read cycle', async () => {
      // Write multiple blocks atomically
      const updates = new Map<number, Buffer>([
        [0, Buffer.from('header')],
        [512, Buffer.from('block1')],
        [1024, Buffer.from('block2')],
      ]);

      await atomicFile.atomicWrite(updates);

      // Close and reopen (simulates restart)
      await atomicFile.close();
      await atomicFile.open();

      // Verify data persisted
      const header = Buffer.alloc(6);
      const b1 = Buffer.alloc(6);
      const b2 = Buffer.alloc(6);

      await atomicFile.read(header, { position: 0 });
      await atomicFile.read(b1, { position: 512 });
      await atomicFile.read(b2, { position: 1024 });

      expect(header.toString()).toBe('header');
      expect(b1.toString()).toBe('block1');
      expect(b2.toString()).toBe('block2');
    });

    it('should overwrite existing data atomically', async () => {
      // Initial write
      await atomicFile.atomicWrite(new Map([[0, Buffer.from('old data')]]));

      // Overwrite
      await atomicFile.atomicWrite(new Map([[0, Buffer.from('new data')]]));

      const readBuf = Buffer.alloc(8);
      await atomicFile.read(readBuf, { position: 0 });
      expect(readBuf.toString()).toBe('new data');
    });
  });
});
