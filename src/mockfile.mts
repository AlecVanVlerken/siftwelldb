import assert from 'node:assert/strict';
import * as fsPromises from 'node:fs/promises';
import random from 'random';

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

export class MockFile implements File {
  public readonly sectorSize: number;
  private size: number;
  private sectors: Buffer[] = [];
  // Invariant: for each `[key, value]` in `newSectors`, and for each buffer in `value`, buffer.length === sectorSize
  private newSectors: Map<number, Buffer[]> = new Map();

  public constructor(sectorSize: number) {
    this.sectorSize = sectorSize;
    this.size = 0;
  }

  public async create() {
    return Promise.resolve();
  }

  public async open() {
    return Promise.resolve();
  }

  public async close() {
    if (this.newSectors.size !== 0) throw new Error("Closed the file without sync'ing first.");
    return Promise.resolve();
  }

  public async sync() {
    for (const [address, writes] of this.newSectors.entries()) {
      this.sectors[address] = writes.at(-1)!;
    }
    this.newSectors.clear();
    return Promise.resolve();
  }

  private read_sector(sectorOrdinal: number): Buffer {
    const i = sectorOrdinal;
    assert(0 <= i && i < this.sectors.length);
    const newSector_i = this.newSectors.get(i);
    return newSector_i ? newSector_i.at(-1)! : this.sectors[i];
  }

  private write_sector(offsetInSector: number, buffer: Buffer, sectorOrdinal: number) {
    assert(buffer.length <= this.sectorSize - offsetInSector);
    if (buffer.length !== this.sectorSize) {
      const sector = Buffer.from(this.read_sector(sectorOrdinal));
      buffer.copy(sector, offsetInSector);
      buffer = sector;
    } else buffer = Buffer.from(buffer);
    if (!this.newSectors.has(sectorOrdinal)) this.newSectors.set(sectorOrdinal, []);
    this.newSectors.get(sectorOrdinal)!.push(buffer);
  }

  public async writev(buffers: Buffer[], position: number) {
    let buffer = Buffer.concat(buffers);
    if (position + buffer.length > this.size) await this.truncate(position + buffer.length);
    let sectorOrdinal = Math.floor(position / this.sectorSize);
    let offsetInSector = position - sectorOrdinal * this.sectorSize;
    while (buffer.length > this.sectorSize - offsetInSector) {
      this.write_sector(offsetInSector, buffer.subarray(0, this.sectorSize - offsetInSector), sectorOrdinal);
      buffer = buffer.subarray(this.sectorSize - offsetInSector);
      sectorOrdinal++;
      offsetInSector = 0;
    }
    if (buffer.length > 0) this.write_sector(offsetInSector, buffer, sectorOrdinal);
    return Promise.resolve();
  }

  public async read(buffer: Buffer, options: { position: number }) {
    assert(0 <= options.position);
    assert(options.position + buffer.length <= this.sectors.length * this.sectorSize);
    let sectorOrdinal = Math.floor(options.position / this.sectorSize);
    let offsetInSector = options.position - sectorOrdinal * this.sectorSize;
    while (buffer.length > this.sectorSize - offsetInSector) {
      const sector = this.read_sector(sectorOrdinal);
      sector.copy(buffer, 0, offsetInSector, this.sectorSize);
      buffer = buffer.subarray(this.sectorSize - offsetInSector);
      sectorOrdinal++;
      offsetInSector = 0;
    }
    const sector = this.read_sector(sectorOrdinal);
    sector.copy(buffer, 0, offsetInSector, offsetInSector + buffer.length);
    return Promise.resolve();
  }

  public async truncate(length: number) {
    const sectorCount = Math.ceil(length / this.sectorSize);
    if (sectorCount < this.sectors.length) {
      this.sectors.length = sectorCount;
      for (const [sectorOrdinal, _writes] of this.newSectors.entries()) {
        if (sectorOrdinal >= sectorCount) this.newSectors.delete(sectorOrdinal);
      }
    } else if (sectorCount > this.sectors.length) {
      for (let sectorOrdinal = this.sectors.length; sectorOrdinal < sectorCount; sectorOrdinal++)
        this.sectors.push(Buffer.alloc(this.sectorSize));
    }
    this.size = length;
    return Promise.resolve();
  }

  public async stat() {
    return Promise.resolve({ size: this.size });
  }

  /**
   * Performs some randomly chosen subset of the pending writes; the others are lost.
   */
  public crash() {
    for (const [sectorOrdinal, writes] of this.newSectors) {
      const nbWritesToSave = random.uniformInt(0, writes.length)();
      if (nbWritesToSave > 0) this.sectors[sectorOrdinal] = writes[nbWritesToSave - 1];
    }
    this.newSectors.clear();
  }
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
