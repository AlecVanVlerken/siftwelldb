// @author Alexandre-Gatien Bienfet
// @date 2025-11-17

import { describe, test, expect } from 'vitest';
import { strict as assert } from 'node:assert';
import { computeChecksum, serializeLogRecord } from '../logrecord.mjs';
import { writeAndSyncLog } from '../logwriter.mjs';
import type { LogRecord } from '../logrecord.mjs';
import { MockFile } from '../../../../tests/helpers/mockfile.mjs';

describe('writeAndSyncLog', () => {
  test('writes a valid record atomically with padding to full sectors', async () => {
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
    const paddedLength = Math.max(sectorSize, Math.ceil(expected.length / sectorSize) * sectorSize);
    const stats = await mockFile.stat();

    // Expect padding to full sector multiple
    assert.strictEqual(stats.size, paddedLength);

    const buffer = Buffer.alloc(paddedLength);
    await mockFile.read(buffer, { position: 0 });

    const prefix = buffer.subarray(0, expected.length);
    expect(prefix.equals(expected)).toBe(true);

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

    const stats = await mockFile.stat();
    expect(stats.size).toBe(sectorSize);

    const buf = Buffer.alloc(sectorSize);
    await mockFile.read(buf, { position: 0 });
    expect(buf.subarray(0, sectorSize).equals(serializeLogRecord(record))).toBe(true);
    expect(buf.subarray(sectorSize).length).toBe(0);

    await mockFile.close();
  });

  test('pads a record larger than one sector to multiple sectors', async () => {
    const sectorSize = 128; // small sector size
    const mockFile = new MockFile(sectorSize);

    const data = Buffer.alloc(200); // larger than sector size
    const checksum = computeChecksum(data);
    const record: LogRecord = { position: 1, data, checksum };

    await mockFile.create();
    await mockFile.open();

    await expect(writeAndSyncLog(mockFile, record)).resolves.not.toThrow();
    const expected = serializeLogRecord(record);
    const paddedLength = Math.max(sectorSize, Math.ceil(expected.length / sectorSize) * sectorSize);
    const stats = await mockFile.stat();
    expect(stats.size).toBe(paddedLength);

    const buf = Buffer.alloc(paddedLength);
    await mockFile.read(buf, { position: 0 });

    const prefix = buf.subarray(0, expected.length);
    expect(prefix.equals(expected)).toBe(true);

    const padding = buf.subarray(expected.length);
    expect(padding.every((b) => b === 0)).toBe(true);

    await mockFile.close();
  });
});
