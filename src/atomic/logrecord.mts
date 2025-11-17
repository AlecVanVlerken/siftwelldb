// @author Alexandre-Gatien Bienfet
// @date 2025-11-17

/**
 * @interface LogRecord
 * A log record that can be stored atomically on disk.
 * - position: the logical position of the data in the data file
 * - data: the actual binary content
 * - checksum: the SHA-256 hash of the data for integrity verification
 */
export interface LogRecord {
  position: number;
  data: Buffer;
  checksum: Buffer;
}

import { createHash } from 'crypto';

/**
 * Compute the SHA-256 checksum of a buffer.
 * @param data - The data for which the hash is calculated.
 * @returns A buffer containing the 32-byte SHA-256 hash.
 */
export function computeChecksum(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/**
 * Convert a LogRecord into a binary format that can be written directly to disk.
 * @param record - The log record to be serialized.
 * @returns A buffer containing the complete binary representation.
 */
export function serializeLogRecord(record: LogRecord): Buffer {
  if (record.checksum.length !== 32) {
    throw new Error('Invalid checksum');
  }
  const header = Buffer.alloc(8);
  header.writeUInt32BE(record.position, 0);
  header.writeUInt32BE(record.data.length, 4);
  return Buffer.concat([header, record.checksum, record.data]);
}

/**
 * Convert a buffer back into a LogRecord.
 * @param buf - The buffer containing a serialized log record.
 * @returns The deserialized LogRecord.
 */
export function deserializeLogRecord(buf: Buffer): LogRecord {
  if (buf.length < 8 + 32) {
    throw new Error('Buffer too small');
  }

  const position = buf.readUInt32BE(0);
  const length = buf.readUInt32BE(4);

  const expectedTotal = 8 + 32 + length;
  if (buf.length < expectedTotal) {
    throw new Error('Incomplete log record');
  }

  const checksum = buf.subarray(8, 8 + 32);
  const data = buf.subarray(8 + 32, 8 + 32 + length);

  const actual = computeChecksum(data);
  if (!actual.equals(checksum)) {
    throw new Error('Checksum mismatch');
  }

  return { position, data, checksum };
}
