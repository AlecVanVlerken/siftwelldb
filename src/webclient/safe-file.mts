// author: Alexandre-Gatien Bienfet
// date: 2026-02-21
//
// SafeRealFile is a wrapper around RealFile that makes open() and create()
// idempotent. This is necessary because FreeBlockFile.create() internally
// calls AtomicFile.create() (which opens the underlying files) and then
// immediately calls FreeBlockFile.open() again — which would trigger RealFile's
// assertion "fileHandle === null". SafeRealFile tracks the open state itself
// and silently skips redundant open/create calls.

import * as fsPromises from 'node:fs/promises';
import { type File } from '../core/file.mjs';

export class SafeRealFile implements File {
  public readonly sectorSize = 512;
  public readonly filePath: string;
  private fileHandle: fsPromises.FileHandle | null = null;

  public constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Open with 'w+' (create or truncate). If already open, do nothing. */
  public async create(): Promise<void> {
    if (this.fileHandle !== null) return; // already open — skip
    this.fileHandle = await fsPromises.open(this.filePath, 'w+');
  }

  /** Open with 'r+' (must exist). If already open, do nothing. */
  public async open(): Promise<void> {
    if (this.fileHandle !== null) return; // already open — skip
    this.fileHandle = await fsPromises.open(this.filePath, 'r+');
  }

  public async close(): Promise<void> {
    if (this.fileHandle === null) return; // already closed — skip
    await this.fileHandle.close();
    this.fileHandle = null;
  }

  public async sync(): Promise<void> {
    if (this.fileHandle === null) throw new Error('File not open');
    await this.fileHandle.sync();
  }

  public async writev(buffers: Buffer[], position: number): Promise<void> {
    if (this.fileHandle === null) throw new Error('File not open');
    await this.fileHandle.writev(buffers, position);
  }

  public async read(buffer: Buffer, options: { position: number }): Promise<void> {
    if (this.fileHandle === null) throw new Error('File not open');
    await this.fileHandle.read(buffer, 0, buffer.length, options.position);
  }

  public async truncate(length: number): Promise<void> {
    if (this.fileHandle === null) throw new Error('File not open');
    await this.fileHandle.truncate(length);
  }

  public async stat(): Promise<{ size: number }> {
    if (this.fileHandle === null) throw new Error('File not open');
    return this.fileHandle.stat();
  }
}
