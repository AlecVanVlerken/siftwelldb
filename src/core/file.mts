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
  writev(buffers: Buffer[], position: number): Promise<void>;
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
    await this.fileHandle.writev(buffers, position);
  }

  public async read(buffer: Buffer, options: { position: number }) {
    assert(this.fileHandle !== null);
    await this.fileHandle.read(buffer, 0, buffer.length, options.position);
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
