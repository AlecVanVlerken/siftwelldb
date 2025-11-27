// @author Alexandre-Gatien Bienfet
// @date 2025-11-17

import { describe, test, expect } from 'vitest';
import { strict as assert } from 'node:assert';
import { computeChecksum, serializeLogRecord } from './logrecord.mjs';
import { writeAndSyncLog } from './logwriter.mjs';
import type { LogRecord } from './logrecord.mts';
import { MockFile } from '../core/mockfile.mjs';

describe('writeAndSyncLog', () => {
  test('writes a valid record atomically', async () => {
    const sectorSize = 512;
    const mockFile = new MockFile(sectorSize);

    const data = Buffer.from('Atomic file test!');
    const checksum = computeChecksum(data);
    const record: LogRecord = { position: 128, data, checksum };

    await mockFile.create();
    await mockFile.open();
    await writeAndSyncLog(mockFile, record);
    await mockFile.close();

    const expected = serializeLogRecord(record);
    const stats = await mockFile.stat();

    // 1) we verwachten precies één sector
    assert.strictEqual(stats.size, sectorSize);

    const buffer = Buffer.alloc(sectorSize);
    await mockFile.read(buffer, { position: 0 });

    // 2) inhoud van de record zelf moet kloppen
    const prefix = buffer.subarray(0, expected.length);
    expect(prefix.equals(expected)).toBe(true);

    // 3) optioneel: controleer padding
    const padding = buffer.subarray(expected.length);
    expect(padding.every((b) => b === 0)).toBe(true);
  });

  test('accepts a record that fits exactly in one sector', async () => {
    const sectorSize = 256;
    const mockFile = new MockFile(sectorSize);

    // record = header (8) + checksum (32) + data (216) = 256 bytes
    const data = Buffer.alloc(sectorSize - 40, 0xaa);
    const checksum = computeChecksum(data);
    const record: LogRecord = { position: 1, data, checksum };

    await mockFile.create();
    await mockFile.open();
    await expect(writeAndSyncLog(mockFile, record)).resolves.not.toThrow();
    await mockFile.close();
  });

  test('rejects a record larger than the sector size', async () => {
    const mockFile = new MockFile(128); // small sector size

    const data = Buffer.alloc(200); // larger than sector size
    const checksum = computeChecksum(data);
    const record: LogRecord = { position: 1, data, checksum };

    await mockFile.create();
    await mockFile.open();

    await expect(writeAndSyncLog(mockFile, record)).rejects.toThrow();

    await mockFile.close();
  });
});
