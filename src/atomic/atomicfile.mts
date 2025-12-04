// atomicfile.mts
// WAL-based atomic wrapper around a data File with multi-range support.
//
// Protocol for atomicWrite():
//   1. Build a LogRecord with a compact binary payload describing all block updates
//   2. writeAndSyncLog(): truncate log, write record in a single
//      sector-sized write, fsync
//   3. Write all blocks into the main file (+ fsync data)
//   4. Truncate the log (optional cleanup; presence of a log means
//      "redo me" on crash)

import type { File } from '../core/file.mjs';
import type { LogRecord } from './logrecord.mjs';
import { computeChecksum, deserializeLogRecord } from './logrecord.mjs';
import { writeAndSyncLog } from './logwriter.mjs';

type EncodedUpdate = {
  position: number;
  data: Buffer;
};

// WAL payload encoding (binary, compact):
// [count: u32][entry...]
// entry = [position: u64][length: u32][data bytes...]
function encodeWalPayload(updates: Map<number, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32BE(updates.size, 0);
  parts.push(countBuf);

  for (const [position, buf] of updates) {
    if (position < 0) {
      throw new Error('Negative position not supported');
    }
    const header = Buffer.alloc(12);
    header.writeBigUInt64BE(BigInt(position), 0);
    header.writeUInt32BE(buf.length, 8);
    parts.push(header, buf);
  }

  return Buffer.concat(parts);
}

function decodeWalPayload(payload: Buffer): EncodedUpdate[] {
  if (payload.length < 4) {
    throw new Error('Payload too small for WAL header');
  }

  const count = payload.readUInt32BE(0);
  let offset = 4;
  const updates: EncodedUpdate[] = [];

  for (let i = 0; i < count; i++) {
    if (offset + 12 > payload.length) {
      throw new Error('Incomplete WAL entry header');
    }
    const position = Number(payload.readBigUInt64BE(offset));
    const length = payload.readUInt32BE(offset + 8);
    offset += 12;

    if (offset + length > payload.length) {
      throw new Error('Incomplete WAL entry payload');
    }

    const data = Buffer.from(payload.subarray(offset, offset + length));
    offset += length;

    updates.push({ position, data });
  }

  if (offset !== payload.length) {
    // Extra bytes would indicate corruption.
    throw new Error('Trailing bytes in WAL payload');
  }

  return updates;
}

export class AtomicFile implements File {
  private readonly dataFile: File;
  private readonly logFile: File;
  private inFlight = false;

  constructor(dataFile: File, logFile: File) {
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
    // Redo any in-progress atomic write from a previous crash.
    await this.recover();
  }

  async close(): Promise<void> {
    await this.dataFile.close();
    await this.logFile.close();
  }

  // ----------------------------
  // File interface passthroughs
  // ----------------------------

  get sectorSize(): number {
    return this.dataFile.sectorSize;
  }

  async read(buffer: Buffer, options: { position: number }): Promise<void> {
    return this.dataFile.read(buffer, options);
  }

  async writev(buffers: Buffer[], position: number): Promise<void> {
    // Non-atomic write-through; use atomicWrite() for WAL-protected writes.
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

  // ----------------------------
  // Public WAL entry point: atomic write
  // ----------------------------

  /**
   * Atomic write over one or more block positions using a single redo log record.
   *
   * @param updates - Map of position -> data (Buffer) to write at each position
   * @returns true if successful, false if failed or nested call
   *
   * The WAL record contains:
   *   - A compact binary payload: [count][(pos,len,data)...]
   *   - A SHA-256 checksum for integrity verification
   *
   * Protocol:
   *   1) Build a binary payload listing all (position, data) pairs.
   *   2) writeAndSyncLog(logFile, record) with checksum.
   *   3) Write all blocks to dataFile + sync.
   *   4) Truncate logFile (cleanup).
   */
  async atomicWrite(updates: Map<number, Buffer>): Promise<boolean> {
    if (this.inFlight) {
      // Prevent nested atomic writes; keeps state machine simple.
      return false;
    }

    if (updates.size === 0) {
      // Nothing to do; vacuously atomic.
      return true;
    }

    this.inFlight = true;

    try {
      // STEP 1: Build compact binary payload with all updates.
      const payload = encodeWalPayload(updates);

      // The LogRecord wraps the payload with a checksum for integrity.
      const record: LogRecord = {
        position: 0, // Not used; all positions are encoded in payload
        data: payload,
        checksum: computeChecksum(payload),
      };

      // STEP 2: Write WAL record atomically and fsync.
      await writeAndSyncLog(this.logFile, record);

      // From this point, the WAL must remain until data is fully written and synced.
      // On crash, recover() will redo all writes.

      // STEP 3: Apply all updates to the main file and fsync.
      for (const [position, buffer] of updates) {
        await this.dataFile.writev([buffer], position);
      }
      await this.dataFile.sync();

      // STEP 4: Cleanup WAL (successful completion).
      await this.cleanupLog();

      return true;
    } catch {
      // If something fails after writeAndSyncLog(), we leave the WAL intact
      // so recover() can finish the write (redo-only protocol).
      return false;
    } finally {
      this.inFlight = false;
    }
  }

  // ----------------------------
  // WAL helpers
  // ----------------------------

  /**
   * Deletes/truncates the log. After this, a crash will *not* trigger a redo.
   * Mag alleen na een volledig geslaagde data-write + sync.
   */
  private async cleanupLog(): Promise<void> {
    await this.logFile.truncate(0);
    await this.logFile.sync();
  }

  // ----------------------------
  // Recovery (redo-only, multi-block)
  // ----------------------------

  /**
   * Crash recovery:
   *   - If log is empty: nothing to do.
   *   - If log contains a valid record: parse the payload, redo all writes, clear the log.
   *   - If log is corrupt/incomplete: drop it.
   *
   * writeAndSyncLog() writes a single record padded to whole sectors, then fsyncs.
   * On recovery the WAL is either empty or contains exactly one record (or
   * detectable corruption), which we can safely redo.
   */
  async recover(): Promise<void> {
    const { size } = await this.logFile.stat();
    if (size === 0) {
      return; // no WAL -> nothing to redo
    }

    const walBuf = Buffer.alloc(size);
    await this.logFile.read(walBuf, { position: 0 });

    try {
      // deserializeLogRecord() also recomputes and checks the checksum.
      const record = deserializeLogRecord(walBuf);

      const encoded = decodeWalPayload(record.data);

      // Redo is idempotent: we simply re-apply all bytes at their positions.
      for (const u of encoded) {
        await this.dataFile.writev([u.data], u.position);
      }
      await this.dataFile.sync();
    } catch {
      // Invalid / corrupted WAL: drop it. We can't safely redo.
    }

    // In all cases, clear WAL so we don't keep redoing the same record.
    await this.cleanupLog();
  }
}

// Exported for tests and debugging tools that need to craft/inspect WAL payloads.
export { encodeWalPayload, decodeWalPayload };
