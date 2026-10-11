import assert from 'node:assert/strict';
import * as fsPromises from 'node:fs/promises';

export interface File {
  /**
   * The maximum N such that writes of size N at offsets that are multiples of N are atomic.
   */
  readonly sectorSize: number;
  create(): Promise<void>;
  open(): Promise<void>;
  close(): Promise<void>;
  sync(): Promise<void>;
  /** Writes every byte at the given position, or rejects if the write cannot complete. */
  writev(buffers: Buffer[], position: number): Promise<void>;
  /** Fills the entire buffer, or rejects on an I/O failure or unexpected EOF. Empty reads are allowed. */
  read(buffer: Buffer, options: { position: number }): Promise<void>;
  truncate(length: number): Promise<void>;
  stat(): Promise<{ size: number }>;
}

export class RealFile implements File {
  public readonly sectorSize = 512;
  public readonly filePath: string;
  private fileHandle: fsPromises.FileHandle | null;

  public constructor(filePath: string) {
    this.filePath = filePath;
    this.fileHandle = null;
  }

  public async create() {
    assert(this.fileHandle === null);
    this.fileHandle = await fsPromises.open(this.filePath, 'w+');
  }

  public async open() {
    assert(this.fileHandle === null);
    this.fileHandle = await fsPromises.open(this.filePath, 'r+');
  }

  public async close() {
    assert(this.fileHandle !== null);
    await this.fileHandle.close();
    this.fileHandle = null;
  }

  public async sync() {
    assert(this.fileHandle !== null);
    await this.fileHandle.sync();
  }

  public async writev(buffers: Buffer[], position: number) {
    assert(this.fileHandle !== null);
    // Keep views into the caller's buffers, without changing their contents or array.
    let pending = buffers.filter((buffer) => buffer.length > 0);
    let remaining = pending.reduce((size, buffer) => size + buffer.length, 0);
    let currentPosition = position;

    while (remaining > 0) {
      const { bytesWritten } = await this.fileHandle.writev(pending, currentPosition);
      if (bytesWritten === 0) {
        throw new Error(
          `Write made no progress for ${this.filePath} at position ${currentPosition} (${remaining} bytes remain)`,
        );
      }
      if (!Number.isInteger(bytesWritten) || bytesWritten < 0 || bytesWritten > remaining) {
        throw new Error(`Invalid write byte count ${bytesWritten} for ${this.filePath}`);
      }
      currentPosition += bytesWritten;
      remaining -= bytesWritten;

      let consumed = bytesWritten;
      let index = 0;
      while (index < pending.length && consumed >= pending[index].length) {
        consumed -= pending[index].length;
        index++;
      }
      pending = pending.slice(index);
      if (consumed > 0) pending[0] = pending[0].subarray(consumed);
    }
  }

  public async read(buffer: Buffer, options: { position: number }) {
    assert(this.fileHandle !== null);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await this.fileHandle.read(
        buffer,
        offset,
        buffer.length - offset,
        options.position + offset,
      );
      if (bytesRead === 0) {
        throw new Error(
          `Unexpected EOF reading ${this.filePath} at position ${options.position}: read ${offset} of ${buffer.length} bytes`,
        );
      }
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - offset) {
        throw new Error(`Invalid read byte count ${bytesRead} for ${this.filePath}`);
      }
      offset += bytesRead;
    }
  }

  public async truncate(length: number) {
    assert(this.fileHandle !== null);
    await this.fileHandle.truncate(length);
  }

  public async stat(): Promise<{ size: number }> {
    assert(this.fileHandle !== null);
    return await this.fileHandle.stat();
  }
}
