import assert from 'assert';
import { computeChecksum, serializeLogRecord, deserializeLogRecord } from '../atomic/logrecord.mjs';
import type { LogRecord } from '../atomic/logrecord.mts';
import { describe, it } from 'vitest';

describe('logrecord', () => {
  it('serializes and deserializes a valid record', () => {
    const data = Buffer.from('Hello SimpleDBMS!');
    const checksum = computeChecksum(data);
    const record: LogRecord = { position: 128, data, checksum };

    const serialized = serializeLogRecord(record);
    assert.strictEqual(serialized.length, 8 + 32 + data.length);

    const recovered = deserializeLogRecord(serialized);

    assert.strictEqual(recovered.position, 128);
    assert(recovered.data.equals(data));
    assert(recovered.checksum.equals(checksum));
  });

  it('rejects records with invalid checksum length during serialization', () => {
    const data = Buffer.from('abc');
    const badChecksum = Buffer.alloc(10); // fout

    const record: LogRecord = { position: 1, data, checksum: badChecksum };

    assert.throws(() => serializeLogRecord(record));
  });

  it('rejects buffers that are too small for header + checksum', () => {
    const tooSmall = Buffer.alloc(20); // minder dan 8 + 32
    assert.throws(() => deserializeLogRecord(tooSmall));
  });

  it('rejects truncated records (header OK, checksum OK, data ontbreekt)', () => {
    const data = Buffer.from('Test123');
    const checksum = computeChecksum(data);
    const record: LogRecord = { position: 10, data, checksum };

    const full = serializeLogRecord(record);

    // maak hem expres te kort (data ontbreekt gedeeltelijk)
    const truncated = full.subarray(0, full.length - 2);

    assert.throws(() => deserializeLogRecord(truncated));
  });

  it('rejects checksum mismatches', () => {
    const data = Buffer.from('Good data');
    const checksum = computeChecksum(data);
    const record: LogRecord = { position: 55, data, checksum };

    const serialized = serializeLogRecord(record);

    // corruptie simuleren
    serialized[serialized.length - 1] ^= 0xff;

    assert.throws(() => deserializeLogRecord(serialized));
  });
});
