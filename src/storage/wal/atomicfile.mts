// @author Henry Delacroix, Alexandre Bienfet
// @date 2025-12-2

import type { File } from '../file.mjs';
import { fileIdentities, type FileIdentity } from '../fileidentity.mjs';
import type { LogRecord } from './logrecord.mjs';
import { computeChecksum, deserializeLogRecord } from './logrecord.mjs';
import { writeAndSyncLog } from './logwriter.mjs';

type EncodedUpdate = {
  position: number;
  data: Buffer;
};

export class RecoveryRequiredError extends Error {
  constructor(cause?: unknown) {
    super('Database recovery is incomplete; recover or close and reopen before continuing.', { cause });
    this.name = 'RecoveryRequiredError';
  }
}

export class WalCorruptionError extends Error {
  constructor(cause: unknown) {
    super('WAL is invalid or incomplete; recovery was refused and the log was preserved.', { cause });
    this.name = 'WalCorruptionError';
  }
}

// WAL payload encoding (binary, compact):
// [count: u32][entry...]
// entry = [position: u64][length: u32][data bytes...]
function encodeWalPayload(updates: Map<number, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32BE(updates.size, 0);
  parts.push(countBuf);

  for (const [position, buf] of updates) {
    if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(position + buf.length)) {
      throw new Error('WAL positions must be nonnegative safe integers');
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
    const encodedPosition = payload.readBigUInt64BE(offset);
    if (encodedPosition > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe WAL position');
    const position = Number(encodedPosition);
    const length = payload.readUInt32BE(offset + 8);
    offset += 12;

    if (offset + length > payload.length) {
      throw new Error('Incomplete WAL entry payload');
    }
    if (!Number.isSafeInteger(position + length)) throw new Error('Unsafe WAL write extent');

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
  private dataIsOpen = false;
  private logIsOpen = false;
  private recoveryRequired = false;
  private recoveryCause: unknown;

  constructor(dataFile: File, logFile: File) {
    this.dataFile = dataFile;
    this.logFile = logFile;
  }

  async create(): Promise<void> {
    this.assertHealthy();
    if (this.dataIsOpen || this.logIsOpen) throw new Error('File already open');
    try {
      await this.dataFile.create();
      this.dataIsOpen = true;
      await this.dataFile.truncate(0);
      await this.dataFile.sync();
      await this.logFile.create();
      this.logIsOpen = true;
      await this.logFile.truncate(0);
      await this.logFile.sync();
    } catch (error) {
      this.recoveryRequired = true;
      this.recoveryCause = error;
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async open(): Promise<void> {
    if (this.dataIsOpen && this.logIsOpen) {
      if (this.recoveryRequired) await this.recover();
      return;
    }
    try {
      if (!this.dataIsOpen) {
        await this.dataFile.open();
        this.dataIsOpen = true;
      }
      if (!this.logIsOpen) {
        await this.logFile.open();
        this.logIsOpen = true;
      }
    } catch (error) {
      this.recoveryRequired = true;
      this.recoveryCause = error;
      await this.close().catch(() => undefined);
      throw error;
    }
    // Redo any in-progress atomic write from a previous crash.
    await this.recover();
  }

  async close(): Promise<void> {
    if (this.inFlight) throw new Error('Cannot close during a WAL operation');
    const results = await Promise.allSettled([
      this.dataIsOpen
        ? this.dataFile.close().then(() => {
            this.dataIsOpen = false;
          })
        : Promise.resolve(),
      this.logIsOpen
        ? this.logFile.close().then(() => {
            this.logIsOpen = false;
          })
        : Promise.resolve(),
    ]);
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason as unknown);
    if (errors.length) throw new AggregateError(errors, 'Failed to close database files');
  }

  get requiresRecovery(): boolean {
    return this.recoveryRequired;
  }

  assertHealthy(): void {
    if (this.recoveryRequired) throw new RecoveryRequiredError(this.recoveryCause);
  }

  get sectorSize(): number {
    return this.dataFile.sectorSize;
  }

  async getStorageIdentities(): Promise<readonly FileIdentity[]> {
    return [...(await fileIdentities(this.dataFile)), ...(await fileIdentities(this.logFile))];
  }

  async read(buffer: Buffer, options: { position: number }): Promise<void> {
    this.assertHealthy();
    return this.dataFile.read(buffer, options);
  }

  async writev(buffers: Buffer[], position: number): Promise<void> {
    this.assertHealthy();
    // Non-atomic write-through; use atomicWrite() for WAL-protected writes.
    await this.dataFile.writev(buffers, position);
  }

  async truncate(length: number): Promise<void> {
    this.assertHealthy();
    await this.dataFile.truncate(length);
  }

  async stat(): Promise<{ size: number }> {
    return this.dataFile.stat();
  }

  async sync(): Promise<void> {
    this.assertHealthy();
    await this.dataFile.sync();
  }

  // ----------------------------
  // Public WAL entry point: atomic write
  // ----------------------------

  /**
   * Atomic write over one or more block positions using a single redo log record.
   *
   * @param updates - Map of position -> data (Buffer) to write at each position
   * @returns true after durable completion, false for a nested call.
   * @throws I/O errors; failed WAL operations require recovery before reuse.
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
    this.assertHealthy();

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

      // Never replace a pending log, including one discovered outside this instance.
      // From the first I/O attempt, a failure leaves the session blocked until recovery.
      this.recoveryRequired = true;
      if ((await this.logFile.stat()).size !== 0) throw new RecoveryRequiredError();

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
      this.recoveryRequired = false;
      this.recoveryCause = undefined;
      return true;
    } catch (error) {
      // If something fails after writeAndSyncLog(), we leave the WAL intact
      // so recover() can finish the write (redo-only protocol).
      if (this.recoveryRequired) this.recoveryCause = error;
      throw error;
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
   *   - If log is corrupt/incomplete: preserve it and fail explicitly.
   *
   * writeAndSyncLog() writes a single record padded to whole sectors, then fsyncs.
   * On recovery the WAL is either empty or contains exactly one record (or
   * detectable corruption), which we can safely redo.
   */
  async recover(): Promise<void> {
    if (this.inFlight) throw new Error('A WAL operation is already in progress');
    this.inFlight = true;
    this.recoveryRequired = true;
    try {
      const { size } = await this.logFile.stat();
      if (size !== 0) {
        const walBuf = Buffer.alloc(size);
        await this.logFile.read(walBuf, { position: 0 });
        let encoded: EncodedUpdate[];
        try {
          // Only framing/checksum/payload errors are classified as malformed WAL.
          const record = deserializeLogRecord(walBuf);
          encoded = decodeWalPayload(record.data);
        } catch (error) {
          throw new WalCorruptionError(error);
        }
        // Redo is idempotent. A replay or sync error must retain the valid log.
        for (const update of encoded) {
          await this.dataFile.writev([update.data], update.position);
        }
        await this.dataFile.sync();
        await this.cleanupLog();
      } else {
        // Complete a cleanup whose truncate succeeded but whose sync failed.
        await this.logFile.sync();
      }
      this.recoveryRequired = false;
      this.recoveryCause = undefined;
    } catch (error) {
      this.recoveryCause = error;
      throw error;
    } finally {
      this.inFlight = false;
    }
  }
}

// Exported for tests and debugging tools that need to craft/inspect WAL payloads.
export { encodeWalPayload, decodeWalPayload };
