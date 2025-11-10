import type { File } from '../core/file.mts';
import type { LogRecord } from './logrecord.mts';
import { serializeLogRecord } from './logrecord.mjs';

/**
 * Schrijft een logrecord atomisch naar schijf.
 * 1. Serieel omzetten
 * 2. Bestand leegmaken
 * 3. In één write-operatie wegschrijven
 * 4. Syncen naar schijf
 *
 * @param logFile - Bestand waarop het logrecord wordt opgeslagen.
 * @param record - LogRecord dat moet worden geschreven.
 */
export async function writeAndSyncLog(logFile: File, record: LogRecord): Promise<void> {
  const serialized = serializeLogRecord(record);

  await logFile.truncate(0);

  await logFile.writev([serialized], 0);

  await logFile.sync();
}
