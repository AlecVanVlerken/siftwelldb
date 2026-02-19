//@author: Thomas Dumon with usage of Claude sonnet 4.6
//@date: 2026-02-18

import type { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { VectorSerializer } from './vectorSerializer.mjs';

export interface VectorPointer {
  pageId: number;
  slotId: number;
}

/**
 * VectorHeapFile
 * ---------------
 * Persistent heap-file storage for fixed-dimension float32 vectors.
 * Built on top of FreeBlockFile.
 *
 * Lifecycle :
 *   const fbf = new FreeBlockFile(atomicFile, blockSize);
 *   await fbf.create();           // new file — or —
 *   await fbf.open();             // existing file
 *   const heap = new VectorHeapFile(fbf, dimension);
 *   ...use heap.insert / get / delete / update / scan...
 *   await fbf.commit();           // persist all dirty blocks atomically
 *   await fbf.close();
 *
 * Page layout (within usable area = bytes [1, blockSize-1] of a raw block;
 * byte 0 is the block-type byte owned by FreeBlockFile):
 *
 *   Offset 0–1  : usedCount   (uint16 LE) — number of occupied slots
 *   Offset 2 … 2+bitmapBytes-1 : slot bitmap (1 bit per slot, 1=occupied)
 *   Offset 2+bitmapBytes … : vector data  (slotsPerPage × vectorByteSize bytes)
 */
export class VectorHeapFile {
  /** Number of float32 values per vector slot. */
  readonly dimension: number;
  /** Bytes per vector (dimension × 4). */
  private readonly vectorByteSize: number;
  /** Byte size of the per-page slot bitmap. */
  private readonly bitmapBytes: number;
  /** Maximum vector slots that fit in one block. */
  readonly slotsPerPage: number;
  /** Byte offset (in usable area) where vector data starts. */
  private readonly dataOffset: number;

  /** In-memory hint: the last block where we found/created free space. */
  private insertHint: number = 0;

  constructor(
    private readonly file: FreeBlockFile,
    dimension: number,
  ) {
    this.dimension = dimension;
    this.vectorByteSize = VectorSerializer.byteSize(dimension);
    const blockSize = file._getBlockSize();
    // usable area = blockSize − 1 (byte 0 is block-type, owned by FreeBlockFile)
    // page header = 2 bytes usedCount + bitmapBytes
    // n * vectorByteSize + ceil(n/8) ≤ blockSize − 3
    // n ≤ (blockSize − 3) × 8 / (vectorByteSize × 8 + 1)
    this.slotsPerPage = Math.floor(((blockSize - 3) * 8) / (this.vectorByteSize * 8 + 1));
    if (this.slotsPerPage < 1) {
      throw new Error(
        `Block size ${blockSize} is too small for dimension ${dimension} ` +
          `(vectorByteSize=${this.vectorByteSize}). Increase the block size.`,
      );
    }
    this.bitmapBytes = Math.ceil(this.slotsPerPage / 8);
    this.dataOffset = 2 + this.bitmapBytes; // usedCount(2) + bitmap
  }

  // LOW-LEVEL PAGE HELPERS

  /**
   * Read usable area of a page (bytes [1..blockSize-1] of the raw block).
   * FreeBlockFile.readBlock returns the full blockSize buffer; our data is at offset 1.
   */
  private async readPage(pageId: number): Promise<Buffer> {
    const raw = await this.file.readBlock(pageId);
    return raw.subarray(1); // view into the raw buffer, offset 1
  }

  /**
   * Like readPage, but returns null if the block is not a Data block (e.g. freed).
   * Used in scan/insert loops to safely skip freed pages.
   */
  private async readPageIfData(pageId: number): Promise<Buffer | null> {
    const raw = await this.file.readBlock(pageId);
    if (raw.readUInt8(0) !== 0x02) return null; // 0x02 = BlockType.Data
    return raw.subarray(1);
  }

  /**
   * Write usable area back to the block.
   * We pass a buffer of (blockSize-1) bytes to FreeBlockFile.writeBlock.
   */
  private async writePage(pageId: number, usable: Buffer): Promise<void> {
    await this.file.writeBlock(pageId, usable);
  }

  /** Create a fresh, empty usable-area buffer. */
  private newPageBuffer(): Buffer {
    const blockSize = this.file._getBlockSize();
    return Buffer.alloc(blockSize - 1); // zeros → usedCount=0, bitmap all 0
  }

  private getUsedCount(usable: Buffer): number {
    return usable.readUInt16LE(0);
  }

  private setUsedCount(usable: Buffer, count: number): void {
    usable.writeUInt16LE(count, 0);
  }

  private isBitSet(usable: Buffer, slotId: number): boolean {
    const byte = usable.readUInt8(2 + Math.floor(slotId / 8));
    return (byte & (1 << slotId % 8)) !== 0;
  }

  private setBit(usable: Buffer, slotId: number): void {
    const byteIdx = 2 + Math.floor(slotId / 8);
    usable.writeUInt8(usable.readUInt8(byteIdx) | (1 << slotId % 8), byteIdx);
  }

  private clearBit(usable: Buffer, slotId: number): void {
    const byteIdx = 2 + Math.floor(slotId / 8);
    usable.writeUInt8(usable.readUInt8(byteIdx) & ~(1 << slotId % 8), byteIdx);
  }

  private vectorOffset(slotId: number): number {
    return this.dataOffset + slotId * this.vectorByteSize;
  }

  // FINDING A FREE SLOT

  /**
   * Find the first free slot in an existing page, or return -1 if full.
   */
  private findFreeSlot(usable: Buffer): number {
    if (this.getUsedCount(usable) >= this.slotsPerPage) return -1;
    for (let s = 0; s < this.slotsPerPage; s++) {
      if (!this.isBitSet(usable, s)) return s;
    }
    return -1;
  }

  /**
   * Allocate a new page, initialise it, and return (pageId, usable buffer).
   */
  private async allocatePage(): Promise<{ pageId: number; usable: Buffer }> {
    const pageId = await this.file.allocateBlock();
    const usable = this.newPageBuffer();
    await this.writePage(pageId, usable);
    return { pageId, usable };
  }

  // PUBLIC API

  /**
   * Insert `vector` and return a persistent pointer to its location.
   * Call `file.commit()` to flush to disk.
   */
  async insert(vector: Float32Array): Promise<VectorPointer> {
    if (vector.length !== this.dimension) {
      throw new Error(`Vector dimension mismatch: expected ${this.dimension}, got ${vector.length}`);
    }

    // Try the cached hint page first.
    if (this.insertHint > 0) {
      const usable = await this.readPage(this.insertHint);
      const slotId = this.findFreeSlot(usable);
      if (slotId >= 0) {
        return this.writeToSlot(this.insertHint, usable, slotId, vector);
      }
    }

    // Scan all existing data pages (blocks 1 … cachedBlockCount−1) for a free slot.
    const blockCount = Math.max(this.file._getCachedBlockCount(), this.file._getHighestDirtyBlock() + 1);
    for (let pageId = 1; pageId < blockCount; pageId++) {
      if (pageId === this.insertHint) continue; // already tried above
      const usable = await this.readPageIfData(pageId);
      if (usable === null) continue; // freed or non-Data block
      const slotId = this.findFreeSlot(usable);
      if (slotId >= 0) {
        this.insertHint = pageId;
        return this.writeToSlot(pageId, usable, slotId, vector);
      }
    }

    // All pages are full (or no pages yet): allocate a new page.
    const { pageId, usable } = await this.allocatePage();
    this.insertHint = pageId;
    return this.writeToSlot(pageId, usable, 0, vector);
  }

  private async writeToSlot(
    pageId: number,
    usable: Buffer,
    slotId: number,
    vector: Float32Array,
  ): Promise<VectorPointer> {
    VectorSerializer.serialize(vector, usable, this.vectorOffset(slotId));
    this.setBit(usable, slotId);
    this.setUsedCount(usable, this.getUsedCount(usable) + 1);
    await this.writePage(pageId, usable);
    return { pageId, slotId };
  }

  /**
   * Retrieve the vector stored at `ptr`.
   */
  async get(ptr: VectorPointer): Promise<Float32Array> {
    const usable = await this.readPage(ptr.pageId);
    if (!this.isBitSet(usable, ptr.slotId)) {
      throw new Error(`Slot (pageId=${ptr.pageId}, slotId=${ptr.slotId}) is not occupied.`);
    }
    return VectorSerializer.deserialize(usable, this.vectorOffset(ptr.slotId), this.dimension);
  }

  /**
   * Free the slot at `ptr`.
   * If the page becomes completely empty, the underlying block is freed.
   */
  async delete(ptr: VectorPointer): Promise<void> {
    const usable = await this.readPage(ptr.pageId);
    if (!this.isBitSet(usable, ptr.slotId)) return; // already free — idempotent
    this.clearBit(usable, ptr.slotId);
    const newCount = this.getUsedCount(usable) - 1;
    this.setUsedCount(usable, newCount);
    if (newCount === 0) {
      // Page is empty — return it to the free list.
      await this.file.freeBlock(ptr.pageId);
      if (this.insertHint === ptr.pageId) this.insertHint = 0;
    } else {
      await this.writePage(ptr.pageId, usable);
    }
  }

  /**
   * Overwrite the vector at `ptr` with `vector` (in-place, same pointer).
   */
  async update(ptr: VectorPointer, vector: Float32Array): Promise<void> {
    if (vector.length !== this.dimension) {
      throw new Error(`Vector dimension mismatch: expected ${this.dimension}, got ${vector.length}`);
    }
    const usable = await this.readPage(ptr.pageId);
    if (!this.isBitSet(usable, ptr.slotId)) {
      throw new Error(`Slot (pageId=${ptr.pageId}, slotId=${ptr.slotId}) is not occupied.`);
    }
    VectorSerializer.serialize(vector, usable, this.vectorOffset(ptr.slotId));
    await this.writePage(ptr.pageId, usable);
  }

  /**
   * Async generator that yields every stored vector together with its pointer.
   * Skips freed slots transparently.
   */
  async *scan(): AsyncGenerator<{ ptr: VectorPointer; vector: Float32Array }> {
    const blockCount = Math.max(this.file._getCachedBlockCount(), this.file._getHighestDirtyBlock() + 1);
    for (let pageId = 1; pageId < blockCount; pageId++) {
      const usable = await this.readPageIfData(pageId).catch(() => null);
      if (usable === null) continue; // freed or inaccessible block
      if (this.getUsedCount(usable) === 0) continue;
      for (let slotId = 0; slotId < this.slotsPerPage; slotId++) {
        if (this.isBitSet(usable, slotId)) {
          const vector = VectorSerializer.deserialize(usable, this.vectorOffset(slotId), this.dimension);
          yield { ptr: { pageId, slotId }, vector };
        }
      }
    }
  }

  /**
   * Atomically flush all dirty vector blocks to disk via the WAL.
   * Must be called BEFORE the graph storage commit to preserve the
   * "data before index" crash-consistency invariant.
   */
  async commit(): Promise<void> {
    await this.file.commit();
  }

  /** Close the underlying file. Safe to call after commit(). */
  async close(): Promise<void> {
    await this.file.close();
  }
}
