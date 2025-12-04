// @author Alexandre-Gatien Bienfet
// @date 2025-11-17


import type { File } from '../core/file.mts';
import type { LogRecord } from './logrecord.mts';
import { serializeLogRecord } from './logrecord.mjs';


/**
 * Write a log record atomically to disk.
 *
 * Invariant: the WAL file is either empty or contains exactly one record,
 * aligned to whole sectors. We enforce:
 *   - we pad the write to a whole number of sectors and write it at offset 0
 */
export async function writeAndSyncLog(logFile: File, record: LogRecord): Promise<void> {
  const serialized = serializeLogRecord(record);
  const sectorSize = logFile.sectorSize;


  if (sectorSize <= 0) {
    throw new Error('Invalid sector size on log file');
  }


  const paddedLength = Math.max(sectorSize, Math.ceil(serialized.length / sectorSize) * sectorSize);
  const padded = Buffer.alloc(paddedLength);
  serialized.copy(padded, 0);


  await logFile.truncate(0);
  await logFile.writev([padded], 0);
  await logFile.sync();
}
