// atomicfile.mts
// WAL-based atomic wrapper around a data File.
//
// Protocol for atomicWritev():
//   1. Build a LogRecord (position + data + checksum)
//   2. writeAndSyncLog(): truncate log, write record in a single sector-sized write, fsync
//   3. Write data into the main file (+ fsync data)
//   4. Truncate the log (optional cleanup; presence of a log means "redo me" on crash)

import type { File } from '../core/file.mts';
import type { LogRecord } from '../atomic/logrecord.mts';
import { computeChecksum, deserializeLogRecord } from '../atomic/logrecord.mjs';
import { writeAndSyncLog } from '../atomic/logwriter.mjs';

export class AtomicFile implements File {
  private readonly dataFile: File;
  private readonly logFile: File; // shouldnt it be able to destroy the logFile ?
  private inFlight = false;

  constructor(dataFile: File, logFile: File) {
    // is a constructor needed ?
    this.dataFile = dataFile;
    this.logFile = logFile;
  }
  async create(): Promise<void> {
    await this.dataFile.create();
    await this.dataFile.truncate(0);
    await this.dataFile.sync();

    await this.logFile.create();
    await this.logFile.truncate(0);
    await this.logFile.sync();
  }
  async open(): Promise<void> {
    await this.dataFile.open();
    await this.logFile.open();
    await this.recover();
  }
  async close(): Promise<void> {
    await this.dataFile.close();
    await this.logFile.close();
  }

  // ---------------------------------------------------------------------------
  // File interface passthroughs
  // ---------------------------------------------------------------------------

  get sectorSize(): number {
    return this.dataFile.sectorSize;
  }

  async read(buffer: Buffer, options: { position: number }): Promise<void> {
    return this.dataFile.read(buffer, options);
  }

  async writev(buffers: Buffer[], position: number): Promise<void> {
    await this.dataFile.writev(buffers, position);
  }

  async truncate(length: number): Promise<void> {
    await this.dataFile.truncate(length);
  }

  async stat(): Promise<{ size: number }> {
    return this.dataFile.stat();
  }

  async sync(): Promise<void> {
    await this.dataFile.sync();
  }

  // ---------------------------------------------------------------------------
  // Public WAL entry point: atomic write
  // ---------------------------------------------------------------------------

  /**
   * Atomic write using a single-record redo log.
   *
   * 1) build LogRecord = (position, data, checksum) NO CHECKSUM i think ----------------------------------------------------------
   * 2) writeAndSyncLog(logFile, record)
   * 3) write data to dataFile + sync
   * 4) truncate logFile
   */
  async atomicWritev(buffers: Buffer[], position: number): Promise<boolean> {
    if (this.inFlight) {
      // Prevent nested atomic writes; keeps state machine simple.
      return false;
    }

    this.inFlight = true;

    try {
      // STEP 1: Build contiguous payload.
      const data = Buffer.concat(buffers);

      const record: LogRecord = {
        position,
        data,
        checksum: computeChecksum(data), // remove ????------------------------------------
        committed: false, // currently unused; presence of WAL implies "redo if crash"
      };

      // STEP 2: Write WAL record atomically and fsync.
      await writeAndSyncLog(this.logFile, record);

      //calculate checksum here ? ---------------------------------------------------------- jcrois pas wesh

      // STEP 3: Apply to main file and fsync.
      await this.dataFile.writev([data], position);
      await this.dataFile.sync();

      // STEP 4: Cleanup WAL (successful completion).
      await this.cleanupLog(); // we did not check if write suyccesful ???

      this.inFlight = false;
      return true;
    } catch {
      // Best-effort cleanup; cannot guarantee full rollback of dataFile.
      await this.bestEffortAbort();
      this.inFlight = false;
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // WAL helpers
  // ---------------------------------------------------------------------------

  /**
   * Deletes/truncates the log. After this, a crash will *not* trigger a redo.
   */
  private async cleanupLog(): Promise<void> {
    await this.logFile.truncate(0);
    await this.logFile.sync();
  }

  /**
   * Best-effort abort for failed atomicWritev().
   *
   * Minimal design: just truncate the log so that recover() sees nothing.
   * (We cannot undo partial writes to the data file.)
   */
  private async bestEffortAbort(): Promise<void> {
    await this.logFile.truncate(0);
    await this.logFile.sync();
  }

  // ---------------------------------------------------------------------------
  // Recovery (redo-only)
  // ---------------------------------------------------------------------------

  /**
   * Crash recovery:
   *   - If log is empty: nothing to do.
   *   - If log contains a valid record: redo that write and clear the log.
   *   - If log is corrupt/incomplete: drop it.
   *
   * Because writeAndSyncLog() writes a single sector-sized record atomically,
   * the WAL is either empty or contains exactly one valid record (modulo
   * corruption), which we can safely redo.
   */
  async recover(): Promise<void> {
    const { size } = await this.logFile.stat();
    if (size === 0) {
      return; // no WAL → nothing to redo
    }

    const walBuf = Buffer.alloc(size);
    await this.logFile.read(walBuf, { position: 0 });

    try {
      // deserializeLogRecord() also recomputes and checks the checksum.
      const record = deserializeLogRecord(walBuf);

      // Redo is idempotent: we simply re-apply the bytes at the same position.
      await this.dataFile.writev([record.data], record.position);
      await this.dataFile.sync();
    } catch {
      // Invalid / corrupted WAL: drop it. We can't safely redo.
    }

    // In all cases, clear WAL so we don't keep redoing the same record.
    await this.cleanupLog();
  }
}
