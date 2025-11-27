// @author Alexandre-Gatien Bienfet
// @date 2025-11-17

import type { File } from '../core/file.mts';
import type { LogRecord } from './logrecord.mts';
import { serializeLogRecord } from './logrecord.mjs';

/**
 * Write a log record atomically to disk.
 *
 * Invariant: the WAL file is either empty or contains exactly one
 * sector-sized record. We enforce:
 *   - serialized LogRecord must fit in one sector
 *   - we pad the write to a full sector and write it at offset 0
 */
export async function writeAndSyncLog(logFile: File, record: LogRecord): Promise<void> {
  const serialized = serializeLogRecord(record);
  const sectorSize = logFile.sectorSize;

  if (sectorSize <= 0) {
    throw new Error('Invalid sector size on log file');
  }

  // Enforce "one-sector WAL" design: caller must split larger batches.
  if (serialized.length > sectorSize) {
    throw new Error(
      `LogRecord of ${serialized.length} bytes exceeds sector size ` +
        `${sectorSize} bytes; split the atomic update into smaller batches.`,
    );
  }

  // Pad to a full sector so the filesystem can treat this as a single
  // sector-aligned, sector-sized write.
  const padded = Buffer.alloc(sectorSize);
  serialized.copy(padded, 0);

  await logFile.truncate(0);
  await logFile.writev([padded], 0);
  await logFile.sync();
}
