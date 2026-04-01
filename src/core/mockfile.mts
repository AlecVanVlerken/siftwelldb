import assert from 'node:assert/strict';
import random from 'random';
import { type File } from './file.mjs';

export class MockFile implements File {
  public readonly sectorSize: number;
  private size: number;
  private sectors: Buffer[] = [];
  // Invariant: for each `[key, value]` in `newSectors`, and for each buffer in `value`, buffer.length === sectorSize
  private newSectors: Map<number, Buffer[]> = new Map();
  // Pool of freed sector buffers to avoid re-allocating on log truncate/grow cycles
  private sectorPool: Buffer[] = [];

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
    let buffer = buffers.length === 1 ? buffers[0] : Buffer.concat(buffers);
    if (position + buffer.length > this.size) await this.truncate(position + buffer.length);
    let sectorOrdinal = Math.floor(position / this.sectorSize);
    let offsetInSector = position - sectorOrdinal * this.sectorSize;

    // Fast path: sector-aligned write spanning full sectors only.
    // One Buffer.from copy for the entire data, then free subarray per sector.
    if (offsetInSector === 0 && buffer.length >= this.sectorSize && buffer.length % this.sectorSize === 0) {
      const copy = Buffer.from(buffer);
      const count = buffer.length / this.sectorSize;
      for (let i = 0; i < count; i++) {
        const so = sectorOrdinal + i;
        let list = this.newSectors.get(so);
        if (!list) { list = []; this.newSectors.set(so, list); }
        list.push(copy.subarray(i * this.sectorSize, (i + 1) * this.sectorSize));
      }
      return Promise.resolve();
    }

    // Slow path: partial sectors or unaligned writes.
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
      // Return freed sectors to pool for reuse
      for (let i = sectorCount; i < this.sectors.length; i++) {
        this.sectorPool.push(this.sectors[i]);
      }
      this.sectors.length = sectorCount;
      for (const [sectorOrdinal, _writes] of this.newSectors.entries()) {
        if (sectorOrdinal >= sectorCount) this.newSectors.delete(sectorOrdinal);
      }
    } else if (sectorCount > this.sectors.length) {
      const needed = sectorCount - this.sectors.length;
      const poolCount = Math.min(needed, this.sectorPool.length);
      // Reuse pooled sectors first (zero-fill for clean reads)
      for (let i = 0; i < poolCount; i++) {
        const buf = this.sectorPool.pop()!;
        buf.fill(0);
        this.sectors.push(buf);
      }
      // Bulk-allocate any remaining sectors (1 alloc instead of N)
      const remaining = needed - poolCount;
      if (remaining > 0) {
        const bulk = Buffer.alloc(remaining * this.sectorSize);
        for (let i = 0; i < remaining; i++) {
          this.sectors.push(bulk.subarray(i * this.sectorSize, (i + 1) * this.sectorSize));
        }
      }
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
