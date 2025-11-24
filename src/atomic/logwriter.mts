// @author Alexandre-Gatien Bienfet
// @date 2025-11-17

import type { File } from '../core/file.mts';
import type { LogRecord } from './logrecord.mts';
import { serializeLogRecord } from './logrecord.mjs';

/**
 * Write a log record atomically to disk.
 * 1. Serialize the record
 * 2. Truncate the file
 * 3. Write the record in a single write operation
 * 4. Sync the file to disk
 *
 * @param logFile - The file in which the log record will be stored.
 * @param record - The LogRecord to be written.
 */
export async function writeAndSyncLog(logFile: File, record: LogRecord): Promise<void> {
  const serialized = serializeLogRecord(record);

  if (serialized.length > logFile.sectorSize) {
    throw new Error(`LogRecord too large to be written atomically`);
  }

  await logFile.truncate(0);

  await logFile.writev([serialized], 0);

  await logFile.sync();
}
