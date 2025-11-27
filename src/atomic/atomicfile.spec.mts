// @author Alexandre-Gatien Bienfet
// @date 2025-11-27

import { describe, test, expect } from 'vitest';
import { strict as assert } from 'node:assert';

import { AtomicFile } from './atomicfile.mjs';
import { AtomicFileOnSteroids } from './atomicfileonsteroids.mjs';
import { MockFile } from '../core/mockfile.mjs';
import { computeChecksum } from './logrecord.mjs';
import type { LogRecord } from './logrecord.mts';
import { writeAndSyncLog } from './logwriter.mjs';

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------

class FailingDataFile extends MockFile {
  private failOnce = true;

  override async writev(buffers: Buffer[], position: number): Promise<void> {
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error('simulated write failure');
    }
    return super.writev(buffers, position);
  }
}

class FailingLogFile extends MockFile {
  private failOnce = true;

  override async writev(buffers: Buffer[], position: number): Promise<void> {
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error('simulated WAL write failure');
    }
    return super.writev(buffers, position);
  }
}

// ---------------------------------------------------------
// AtomicFile tests
// ---------------------------------------------------------

describe('AtomicFile', () => {
  test('performs a successful atomicWritev and clears the WAL', async () => {
    const sectorSize = 512;
    const dataFile = new MockFile(sectorSize);
    const logFile = new MockFile(sectorSize);
    const atomic = new AtomicFile(dataFile, logFile);

    await atomic.create();
    await atomic.open();

    const position = 128;
    const payload = Buffer.from('hello atomic world');
    const ok = await atomic.atomicWritev([payload], position);

    expect(ok).toBe(true);

    const readBuf = Buffer.alloc(payload.length);
    await atomic.read(readBuf, { position });
    expect(readBuf.equals(payload)).toBe(true);

    const logStats = await logFile.stat();
    assert.strictEqual(logStats.size, 0);

    await atomic.close();
  });

  test('keeps WAL on data write failure and recover() replays the write', async () => {
    const sectorSize = 512;
    const dataFile = new FailingDataFile(sectorSize); // eerste data-write faalt
    const logFile = new MockFile(sectorSize);

    const atomic1 = new AtomicFile(dataFile, logFile);
    await atomic1.create();
    await atomic1.open();

    const position = 4096;
    const payload = Buffer.from('partial crash scenario');
    const ok1 = await atomic1.atomicWritev([payload], position);

    // Door de geforceerde fout moet dit mislukken.
    expect(ok1).toBe(false);

    // WAL moet nog data bevatten.
    const logStatsAfterFail = await logFile.stat();
    expect(logStatsAfterFail.size).toBeGreaterThan(0);

    await atomic1.close();

    // Tweede "proces" dat dezelfde files opent en recovery uitvoert.
    const atomic2 = new AtomicFile(dataFile, logFile);
    await atomic2.open(); // roept intern recover() aan

    const readBuf = Buffer.alloc(payload.length);
    await atomic2.read(readBuf, { position });
    expect(readBuf.equals(payload)).toBe(true);

    const logStatsAfterRecover = await logFile.stat();
    assert.strictEqual(logStatsAfterRecover.size, 0);

    await atomic2.close();
  });

  test('returns false and leaves WAL empty when WAL write fails', async () => {
    const sectorSize = 512;
    const dataFile = new MockFile(sectorSize);
    const logFile = new FailingLogFile(sectorSize); // eerste WAL-write faalt
    const atomic = new AtomicFile(dataFile, logFile);

    await atomic.create();
    await atomic.open();

    const position = 512;
    const payload = Buffer.from('wal write failure');
    const ok = await atomic.atomicWritev([payload], position);

    // writeAndSyncLog faalt → atomicWritev moet false geven
    expect(ok).toBe(false);

    // WAL mag geen half record bevatten (truncate(0) vóór writev).
    const logStats = await logFile.stat();
    assert.strictEqual(logStats.size, 0);

    // datafile mag niet aangepast zijn (geen data-write uitgevoerd).
    const dataStats = await dataFile.stat();
    assert.strictEqual(dataStats.size, 0);

    await atomic.close();
  });

  test('drops a corrupt WAL during recover() and leaves data unchanged', async () => {
    const sectorSize = 512;
    const dataFile = new MockFile(sectorSize);
    const logFile = new MockFile(sectorSize);

    // 1) "Oude" data in dataFile
    await dataFile.create();
    await dataFile.open();
    const pos = 128;
    const original = Buffer.from('original data');
    await dataFile.writev([original], pos);
    await dataFile.sync();
    await dataFile.close();

    // 2) Corrupt WAL (geen geldig LogRecord)
    await logFile.create();
    await logFile.open();
    const garbage = Buffer.from('not a valid log record');
    await logFile.writev([garbage], 0);
    await logFile.sync();
    await logFile.close();

    // 3) AtomicFile opent en doet recover()
    const atomic = new AtomicFile(dataFile, logFile);
    await atomic.open(); // recover() ziet corrupt WAL en dropt die

    // Data moet onveranderd zijn.
    const buf = Buffer.alloc(original.length);
    await atomic.read(buf, { position: pos });
    expect(buf.equals(original)).toBe(true);

    // WAL moet leeggemaakt zijn.
    const logStatsAfter = await logFile.stat();
    assert.strictEqual(logStatsAfter.size, 0);

    await atomic.close();
  });

  test('recovery is idempotent when WAL is present but data already applied', async () => {
    const sectorSize = 512;
    const dataFile = new MockFile(sectorSize);
    const logFile = new MockFile(sectorSize);

    // 1) Create/open onderliggende files
    await dataFile.create();
    await dataFile.open();
    await logFile.create();
    await logFile.open();

    const position = 2048;
    const newData = Buffer.from('new data already written');

    // 2) Schrijf een geldige WAL-record alsof atomicWritev net de log heeft geschreven
    const record: LogRecord = {
      position,
      data: newData,
      checksum: computeChecksum(newData),
    };
    await writeAndSyncLog(logFile, record);

    // 3) Simuleer dat de data al geschreven + gesynct is,
    //    maar cleanupLog nog niet gebeurd is (crash tussen stap 3 en 4).
    await dataFile.writev([newData], position);
    await dataFile.sync();

    await dataFile.close();
    await logFile.close();

    // 4) Nieuw proces met AtomicFile: open() doet recover()
    const atomic = new AtomicFile(dataFile, logFile);
    await atomic.open();

    // Data moet nog steeds correct zijn.
    const buf = Buffer.alloc(newData.length);
    await atomic.read(buf, { position });
    expect(buf.equals(newData)).toBe(true);

    // WAL moet nu verdwenen zijn (cleanup in recover()).
    const logStatsAfter = await logFile.stat();
    assert.strictEqual(logStatsAfter.size, 0);

    await atomic.close();
  });
});

// ---------------------------------------------------------
// AtomicFileOnSteroids tests
// ---------------------------------------------------------

describe('AtomicFileOnSteroids', () => {
  test('atomicWritev writes a single range atomically and clears the WAL', async () => {
    const sectorSize = 512;
    const dataFile = new MockFile(sectorSize);
    const logFile = new MockFile(sectorSize);
    const atomic = new AtomicFileOnSteroids(dataFile, logFile);

    await atomic.create();
    await atomic.open();

    const position = 256;
    const payload = Buffer.from('hello atomic steroids');
    const ok = await atomic.atomicWritev([payload], position);

    expect(ok).toBe(true);

    const readBuf = Buffer.alloc(payload.length);
    await atomic.read(readBuf, { position });
    expect(readBuf.equals(payload)).toBe(true);

    const logStats = await logFile.stat();
    assert.strictEqual(logStats.size, 0);

    await atomic.close();
  });

  test('atomicWriteMany updates multiple ranges atomically', async () => {
    const sectorSize = 512;
    const dataFile = new MockFile(sectorSize);
    const logFile = new MockFile(sectorSize);
    const atomic = new AtomicFileOnSteroids(dataFile, logFile);

    await atomic.create();
    await atomic.open();

    const p1 = 0;
    const p2 = 4096;

    const buf1 = Buffer.from('page one');
    const buf2 = Buffer.from('page two');

    const ok = await atomic.atomicWriteMany([
      { position: p1, buffers: [buf1] },
      { position: p2, buffers: [buf2] },
    ]);

    expect(ok).toBe(true);

    const r1 = Buffer.alloc(buf1.length);
    const r2 = Buffer.alloc(buf2.length);
    await atomic.read(r1, { position: p1 });
    await atomic.read(r2, { position: p2 });

    expect(r1.equals(buf1)).toBe(true);
    expect(r2.equals(buf2)).toBe(true);

    const logStats = await logFile.stat();
    assert.strictEqual(logStats.size, 0);

    await atomic.close();
  });

  test('keeps WAL on failure and recover() replays all ranges', async () => {
    const sectorSize = 512;
    const dataFile = new FailingDataFile(sectorSize);
    const logFile = new MockFile(sectorSize);

    const atomic1 = new AtomicFileOnSteroids(dataFile, logFile);
    await atomic1.create();
    await atomic1.open();

    const p1 = 1024;
    const p2 = 2048;
    const buf1 = Buffer.from('block one (should survive crash)');
    const buf2 = Buffer.from('block two (should survive crash)');

    const ok1 = await atomic1.atomicWriteMany([
      { position: p1, buffers: [buf1] },
      { position: p2, buffers: [buf2] },
    ]);

    expect(ok1).toBe(false);

    const logStatsAfterFail = await logFile.stat();
    expect(logStatsAfterFail.size).toBeGreaterThan(0);

    await atomic1.close();

    const atomic2 = new AtomicFileOnSteroids(dataFile, logFile);
    await atomic2.open(); // recover()

    const r1 = Buffer.alloc(buf1.length);
    const r2 = Buffer.alloc(buf2.length);
    await atomic2.read(r1, { position: p1 });
    await atomic2.read(r2, { position: p2 });

    expect(r1.equals(buf1)).toBe(true);
    expect(r2.equals(buf2)).toBe(true);

    const logStatsAfterRecover = await logFile.stat();
    assert.strictEqual(logStatsAfterRecover.size, 0);

    await atomic2.close();
  });

  test('drops a WAL with invalid JSON payload on recover()', async () => {
    const sectorSize = 512;
    const dataFile = new MockFile(sectorSize);
    const logFile = new MockFile(sectorSize);

    // 1) Oude data
    await dataFile.create();
    await dataFile.open();
    const pos = 0;
    const original = Buffer.from('old steroids data');
    await dataFile.writev([original], pos);
    await dataFile.sync();
    await dataFile.close();

    // 2) Geldige LogRecord-structuur, maar data = geen geldige JSON
    await logFile.create();
    await logFile.open();
    const badJson = Buffer.from('not json at all', 'utf8');
    const record: LogRecord = {
      position: 0,
      data: badJson,
      checksum: computeChecksum(badJson),
    };
    await writeAndSyncLog(logFile, record);
    await logFile.close();

    // 3) recover(): JSON.parse moet falen, WAL wordt gedropt, data blijft oud.
    const atomic = new AtomicFileOnSteroids(dataFile, logFile);
    await atomic.open();

    const buf = Buffer.alloc(original.length);
    await atomic.read(buf, { position: pos });
    expect(buf.equals(original)).toBe(true);

    const logStatsAfter = await logFile.stat();
    assert.strictEqual(logStatsAfter.size, 0);

    await atomic.close();
  });

  test('recovery is idempotent for multi-range WAL already applied', async () => {
    const sectorSize = 512;
    const dataFile = new MockFile(sectorSize);
    const logFile = new MockFile(sectorSize);

    await dataFile.create();
    await dataFile.open();
    await logFile.create();
    await logFile.open();

    const p1 = 0;
    const p2 = 4096;
    const buf1 = Buffer.from('redo-range-one');
    const buf2 = Buffer.from('redo-range-two');

    // 1) Bouw JSON payload zoals atomicWriteMany dat doet.
    const encoded = [
      { position: p1, data: Buffer.from(buf1).toString('base64') },
      { position: p2, data: Buffer.from(buf2).toString('base64') },
    ];
    const json = Buffer.from(JSON.stringify(encoded), 'utf8');

    const record: LogRecord = {
      position: 0,
      data: json,
      checksum: computeChecksum(json),
    };

    // 2) Schrijf WAL alsof atomicWriteMany net writeAndSyncLog gedaan heeft.
    await writeAndSyncLog(logFile, record);

    // 3) Simuleer dat de data-updates al zijn uitgevoerd en gesynct.
    await dataFile.writev([buf1], p1);
    await dataFile.writev([buf2], p2);
    await dataFile.sync();

    await dataFile.close();
    await logFile.close();

    // 4) Nieuw proces met AtomicFileOnSteroids: recover() redo't nog eens.
    const atomic = new AtomicFileOnSteroids(dataFile, logFile);
    await atomic.open();

    const r1 = Buffer.alloc(buf1.length);
    const r2 = Buffer.alloc(buf2.length);
    await atomic.read(r1, { position: p1 });
    await atomic.read(r2, { position: p2 });

    expect(r1.equals(buf1)).toBe(true);
    expect(r2.equals(buf2)).toBe(true);

    const logStatsAfter = await logFile.stat();
    assert.strictEqual(logStatsAfter.size, 0);

    await atomic.close();
  });
});
