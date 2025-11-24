// atomicfile.mts
// WAL-based atomic wrapper around a data File.
//
// Protocol for atomicWriteMany():
//   1. Build a LogRecord with a JSON payload describing all block updates
//   2. writeAndSyncLog(): truncate log, write record in a single sector-sized write, fsync
//   3. Write all blocks into the main file (+ fsync data)
//   4. Truncate the log (optional cleanup; presence of a log means "redo me" on crash)

import type { File } from '../core/file.mts';
import type { LogRecord } from '../atomic/logrecord.mts';
import { computeChecksum, deserializeLogRecord } from '../atomic/logrecord.mjs';
import { writeAndSyncLog } from '../atomic/logwriter.mjs';

type BlockUpdate = {
  position: number;
  buffers: Buffer[]; // multiple buffers for the same contiguous range
};

type EncodedUpdate = {
  position: number;
  data: string; // base64-encoded data // check this MOFO
};

export class AtomicFile implements File {
  private readonly dataFile: File;
  private readonly logFile: File;
  private inFlight = false;

  constructor(dataFile: File, logFile: File) {
    this.dataFile = dataFile;
    this.logFile = logFile;
  }

  // You probably want to create/open/close both underlying files.

  async create(): Promise<void> {
    await this.dataFile.create();
    await this.logFile.create();
  }

  async open(): Promise<void> {
    // ADD RECOVERY HERE ??????
    await this.dataFile.open();
    await this.logFile.open();
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
    // Non-atomic write-through; use atomicWritev/atomicWriteMany for WAL-protected writes.
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
  // Public WAL entry points: atomic writes
  // ---------------------------------------------------------------------------

  /**
   * Atomic write for a single contiguous range.
   *
   * This is a thin wrapper around atomicWriteMany().
   */
  async atomicWritev(buffers: Buffer[], position: number): Promise<boolean> {
    return this.atomicWriteMany([{ position, buffers }]);
  }

  /**
   * Atomic write over multiple block ranges using a single redo log record.
   *
   * 1) Build a JSON payload listing all (position, data) pairs.
   * 2) writeAndSyncLog(logFile, record) with checksum.
   * 3) Write all blocks to dataFile + sync.
   * 4) Truncate logFile.
   */
  async atomicWriteMany(updates: BlockUpdate[]): Promise<boolean> {
    if (this.inFlight) {
      // Prevent nested atomic writes; keeps state machine simple.
      return false;
    }

    if (updates.length === 0) {
      // Nothing to do; vacuously atomic.
      return true;
    }

    this.inFlight = true;

    try {
      // STEP 1: Build JSON payload with all updates.
      const encoded: EncodedUpdate[] = updates.map((u) => ({
        position: u.position,
        // concat all buffers for this position and encode as base64
        data: Buffer.concat(u.buffers).toString('base64'),
      }));

      const data = Buffer.from(JSON.stringify(encoded), 'utf8');

      const record: LogRecord = {
        // position field is no longer semantically relevant; everything is in `data`.
        position: 0,
        data,
        checksum: computeChecksum(data),
        committed: false, // presence of WAL implies "redo if crash"
      };

      // STEP 2: Write WAL record atomically and fsync.
      await writeAndSyncLog(this.logFile, record);

      // STEP 3: Apply all updates to the main file and fsync.
      for (const u of updates) {
        const payload = Buffer.concat(u.buffers);
        await this.dataFile.writev([payload], u.position);
      }
      await this.dataFile.sync();

      // STEP 4: Cleanup WAL (successful completion).
      await this.cleanupLog();

      return true;
    } catch (_err) {
      // Best-effort cleanup; cannot guarantee full rollback of dataFile,
      // but by truncating the WAL we avoid redo on the next recover().
      await this.bestEffortAbort();
      return false;
    } finally {
      this.inFlight = false;
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
   * Best-effort abort for failed atomic writes.
   *
   * Minimal design: just truncate the log so that recover() sees nothing.
   * (We cannot undo partial writes to the data file.)
   */
  private async bestEffortAbort(): Promise<void> {
    await this.logFile.truncate(0);
    await this.logFile.sync();
  }

  // ---------------------------------------------------------------------------
  // Recovery (redo-only, multi-block)
  // ---------------------------------------------------------------------------

  /**
   * Crash recovery:
   *   - If log is empty: nothing to do.
   *   - If log contains a valid record: parse JSON payload, redo all writes, clear the log.
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

      // Decode JSON payload describing all block updates.
      const encoded: EncodedUpdate[] = JSON.parse(record.data.toString('utf8'));

      // Redo is idempotent: we simply re-apply all bytes at their positions.
      for (const u of encoded) {
        const buf = Buffer.from(u.data, 'base64');
        await this.dataFile.writev([buf], u.position);
      }
      await this.dataFile.sync();
    } catch (_err) {
      // Invalid / corrupted WAL: drop it. We can't safely redo.
    }

    // In all cases, clear WAL so we don't keep redoing the same record.
    await this.cleanupLog();
  }
}
