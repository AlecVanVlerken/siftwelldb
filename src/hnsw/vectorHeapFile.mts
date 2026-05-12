//@author: Thomas Dumon with usage of Claude sonnet 4.6
//@date: 2026-02-18

import type { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { VectorSerializer } from './vectorSerializer.mjs';

/**
 * Magic byte written at usable[0] (= raw byte 1) of every VectorHeapFile page.
 * Allows VectorHeapFile.scan() to skip pages owned by other subsystems when
 * operating inside a shared FreeBlockFile.
 */
const HNSW_VECTOR_PAGE_MAGIC = 0xa5;

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
 * Lifecycle (sharedFbf is the FreeBlockFile already open by DbmsBack):
 *   const heap = new VectorHeapFile(sharedFbf, dimension);
 *   ...use heap.insert / get / delete / update / scan...
 *   await heap.commit();   // delegates to sharedFbf.commit() — one atomic WAL flush
 *   await heap.close();    // no-op in shared-FBF design; DbmsBack owns the file
 *
 * Page layout (within usable area = bytes [1, blockSize-1] of a raw block;
 * byte 0 is the block-type byte owned by FreeBlockFile):
 *
 *   Offset 0    : page magic (HNSW_VECTOR_PAGE_MAGIC = 0xa5)
 *   Offset 1–2  : usedCount   (uint16 LE) — number of occupied slots
 *   Offset 3 … 2+bitmapBytes : slot bitmap (1 bit per slot, 1=occupied)
 *   Offset 3+bitmapBytes … : vector data  (slotsPerPage × vectorByteSize bytes)
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
    // page header = 1 byte magic + 2 bytes usedCount + bitmapBytes
    // n * vectorByteSize + ceil(n/8) ≤ blockSize − 4
    // n ≤ (blockSize − 4) × 8 / (vectorByteSize × 8 + 1)
    this.slotsPerPage = Math.floor(((blockSize - 4) * 8) / (this.vectorByteSize * 8 + 1));
    if (this.slotsPerPage < 1) {
      throw new Error(
        `Block size ${blockSize} is too small for dimension ${dimension} ` +
          `(vectorByteSize=${this.vectorByteSize}). Increase the block size.`,
      );
    }
    this.bitmapBytes = Math.ceil(this.slotsPerPage / 8);
    // magic(1) + usedCount(2) + bitmap
    this.dataOffset = 3 + this.bitmapBytes;
  }

  // LOW-LEVEL PAGE HELPERS

  /** Page-level read/write cache: keyed by pageId, stores the usable-area Buffer.
   * When the underlying block is in the FBF dirty cache the stored Buffer is a
   * zero-copy subarray, so vector writes are reflected in-place without Buffer copies.
   */
  private readonly _pageCache = new Map<number, Buffer>();

  /**
   * Read usable area of a page (bytes [1..blockSize-1] of the raw block).
   * Checks the FBF dirty cache first to avoid an extra Buffer.from() copy.
   */
  private async readPage(pageId: number): Promise<Buffer> {
    const inCache = this._pageCache.get(pageId);
    if (inCache !== undefined) return inCache;
    const dirty = this.file._getDirtyBlock(pageId);
    if (dirty !== undefined) {
      const usable = dirty.subarray(1);
      this._pageCache.set(pageId, usable);
      return usable;
    }
    const raw = await this.file.readBlock(pageId);
    const usable = raw.subarray(1);
    this._pageCache.set(pageId, usable);
    return usable;
  }

  /**
   * Like readPage, but returns null if the block is not a VectorHeapFile page.
   * Checks both the FBF block type (0x02 = Data) and the HNSW vector page magic
   * so that foreign pages (B+ tree nodes, RecordStore blocks, HNSW graph pages)
   * are transparently skipped during scan/insert loops in a shared FBF.
   */
  private async readPageIfData(pageId: number): Promise<Buffer | null> {
    const raw = await this.file.readBlock(pageId);
    if (raw.readUInt8(0) !== 0x02) return null; // 0x02 = BlockType.Data
    if (raw.readUInt8(1) !== HNSW_VECTOR_PAGE_MAGIC) return null; // not a vector page
    return raw.subarray(1);
  }

  /**
   * Write usable area back to the block.
   * If the usable buffer is already a zero-copy subarray of the FBF dirty block,
   * the write has already happened in-place and we skip the redundant copy.
   */
  private async writePage(pageId: number, usable: Buffer): Promise<void> {
    this._pageCache.set(pageId, usable);
    const dirty = this.file._getDirtyBlock(pageId);
    if (dirty !== undefined && dirty.buffer === usable.buffer && dirty.byteOffset === usable.byteOffset - 1) {
      return; // already dirty in-place, no copy needed
    }
    await this.file.writeBlock(pageId, usable);
    // After writeBlock a new dirty entry was created; update cache to its subarray
    // so the NEXT write to this page is also zero-copy.
    const newDirty = this.file._getDirtyBlock(pageId);
    if (newDirty !== undefined) {
      this._pageCache.set(pageId, newDirty.subarray(1));
    }
  }

  /** Create a fresh, empty usable-area buffer with the page magic byte set. */
  private newPageBuffer(): Buffer {
    const blockSize = this.file._getBlockSize();
    const buf = Buffer.alloc(blockSize - 1);
    // Mark this as a VectorHeapFile page so scan() can identify it in a
    // shared FBF where multiple subsystems coexist.
    buf.writeUInt8(HNSW_VECTOR_PAGE_MAGIC, 0);
    return buf;
  }

  // usedCount lives at usable[1..2] (usable[0] is the page magic byte)
  private getUsedCount(usable: Buffer): number {
    return usable.readUInt16LE(1);
  }

  private setUsedCount(usable: Buffer, count: number): void {
    usable.writeUInt16LE(count, 1);
  }

  // Bitmap starts at usable[3] (magic[0] + usedCount[1..2])
  private isBitSet(usable: Buffer, slotId: number): boolean {
    const byte = usable.readUInt8(3 + Math.floor(slotId / 8));
    return (byte & (1 << slotId % 8)) !== 0;
  }

  private setBit(usable: Buffer, slotId: number): void {
    const byteIdx = 3 + Math.floor(slotId / 8);
    usable.writeUInt8(usable.readUInt8(byteIdx) | (1 << slotId % 8), byteIdx);
  }

  private clearBit(usable: Buffer, slotId: number): void {
    const byteIdx = 3 + Math.floor(slotId / 8);
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
  private async allocatePage(
    options: { maxBlockExclusive?: number } = {},
  ): Promise<{ pageId: number; usable: Buffer }> {
    const pageId =
      options.maxBlockExclusive === undefined
        ? await this.file.allocateBlock()
        : await this.allocatePageBelow(options.maxBlockExclusive);
    const usable = this.newPageBuffer();
    await this.writePage(pageId, usable);
    return { pageId, usable };
  }

  // PUBLIC API

  /**
   * Insert `vector` and return a persistent pointer to its location.
   * Call `index.commit()` (or `heap.commit()`) to flush to disk.
   */
  async insert(vector: Float32Array, options: { maxBlockExclusive?: number } = {}): Promise<VectorPointer> {
    if (vector.length !== this.dimension) {
      throw new Error(`Vector dimension mismatch: expected ${this.dimension}, got ${vector.length}`);
    }

    // Try the cached hint page first — O(1) fast path.
    if (
      this.insertHint > 0 &&
      (options.maxBlockExclusive === undefined || this.insertHint < options.maxBlockExclusive)
    ) {
      const usable = await this.readPage(this.insertHint);
      const slotId = this.findFreeSlot(usable);
      if (slotId >= 0) {
        return this.writeToSlot(this.insertHint, usable, slotId, vector);
      }
    }

    // Hint page is full — allocate a new page directly (O(1)).
    // Skipping the previous O(N) scan of all existing data pages.
    // Freed slots from deletes are reclaimed lazily when the hint page
    // itself has space (after a delete frees a slot on the hint page).
    const { pageId, usable } = await this.allocatePage(options);
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
      this._pageCache.delete(ptr.pageId);
      await this.file.freeBlock(ptr.pageId);
      if (this.insertHint === ptr.pageId) this.insertHint = 0;
    } else {
      await this.writePage(ptr.pageId, usable);
    }
  }

  /**
   * Move one vector to a fresh slot and free the old slot.
   *
   * This targeted primitive is used by incremental compaction. It preserves
   * the vector value while changing only its physical VectorPointer.
   */
  async relocate(ptr: VectorPointer, options: { maxBlockExclusive?: number } = {}): Promise<VectorPointer> {
    const vector = await this.get(ptr);
    const newPtr = await this.insert(vector, options);
    await this.delete(ptr);
    return newPtr;
  }

  private async allocatePageBelow(maxBlockExclusive: number): Promise<number> {
    const pageId = await this.file.allocateBlockBelow(maxBlockExclusive);
    if (pageId === null) {
      throw new Error(`No free HNSW vector relocation block below ${maxBlockExclusive.toString()}`);
    }
    return pageId;
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
   * Flush all dirty vector blocks to disk via the shared WAL.
   * Both VectorHeapFile and HNSWGraphStorage delegate to the same
   * FreeBlockFile instance, so the actual on-disk commit is one atomic
   * operation.  Must be called BEFORE graphStorage.commit() to preserve
   * the "data before index" in-memory write ordering invariant.
   */
  async commit(): Promise<void> {
    await this.file.commit();
  }

  /**
   * No-op in the shared-FBF design — the underlying FreeBlockFile is owned
   * and closed by DbmsBack.  Kept for symmetry with HNSWGraphStorage.
   */
  async close(): Promise<void> {
    await this.file.close();
  }
}
