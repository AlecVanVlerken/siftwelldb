/**
 * @interface LogRecord
 * Een logrecord dat atomisch op schijf kan worden opgeslagen.
 * - position: logische positie van de data in het databestand
 * - data: de eigenlijke binaire inhoud
 * - checksum: SHA-256 hash van de data voor integriteitscontrole
 */
export interface LogRecord {
  position: number;
  data: Buffer;
  checksum: Buffer;
}

import { createHash } from 'crypto';

/**
 * Bereken de SHA-256 checksum van een buffer.
 * @param data - De data waarvoor de hash berekend wordt.
 * @returns Buffer met de 32-byte SHA-256 hash.
 */
export function computeChecksum(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/**
 * Zet een LogRecord om naar een binair formaat dat direct kan worden weggeschreven.
 * @param record - Het logrecord dat moet worden geserialiseerd.
 * @returns Buffer met de volledige binaire representatie.
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
 * Zet een buffer terug om in een LogRecord.
 * @param buf - De buffer die een geserialiseerd logrecord bevat.
 * @returns Het gedeserialiseerde LogRecord.
 */
export function deserializeLogRecord(buf: Buffer): LogRecord {
  if (buf.length < 8 + 32) {
    throw new Error('Buffer too small to contain a log record header');
  }

  const position = buf.readUInt32BE(0);
  const length = buf.readUInt32BE(4);

  const expectedTotal = 8 + 32 + length;
  if (buf.length < expectedTotal) {
    throw new Error('Incomplete log record: buffer is truncated');
  }

  const checksum = buf.subarray(8, 8 + 32);
  const data = buf.subarray(8 + 32, 8 + 32 + length);

  const actual = computeChecksum(data);
  if (!actual.equals(checksum)) {
    throw new Error('Checksum mismatch');
  }

  return { position, data, checksum };
}
