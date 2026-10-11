//@author: Thomas Dumon with usage of Claude sonnet 4.6
//@date: 2026-02-18

import type { FreeBlockFile } from '../../storage/blocks/freeblockfile.mjs';
import { BlockType } from '../../storage/blocks/layout.mjs';
import { VectorSerializer } from './vectorSerializer.mjs';
import { HnswCompatibilityError } from './hnswGraphStorage.mjs';

/**
 * Magic byte written at usable[0] (= raw byte 1) of every VectorHeapFile page.
 * Allows VectorHeapFile.scan() to skip pages owned by other subsystems when
 * operating inside a shared FreeBlockFile.
 */
const LEGACY_VECTOR_PAGE_MAGIC = 0xa5;
const HNSW_VECTOR_PAGE_MAGIC = 0xa6;
const PAGE_HEADER_SIZE = 7;
const LEGACY_PAGE_HEADER_SIZE = 3;

/** Validate configuration before embeddings or document mutations begin. */
export function validateVectorDimension(dimension: number, blockSize: number): void {
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > 0xffffffff) {
    throw new HnswCompatibilityError('HNSW vector dimension must be a positive uint32 integer.');
  }
  const vectorByteSize = VectorSerializer.byteSize(dimension);
  // One vector needs the page header and at least one bitmap byte.
  if (vectorByteSize + PAGE_HEADER_SIZE + 1 > blockSize - 1) {
    throw new Error(
      `Block size ${blockSize} is too small for dimension ${dimension} ` +
        `(vectorByteSize=${vectorByteSize}). Increase the block size.`,
    );
  }
}

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
 *   Offset 0    : page magic (HNSW_VECTOR_PAGE_MAGIC = 0xa6)
 *   Offset 1–4  : vector dimension (uint32 LE)
 *   Offset 5–6  : usedCount (uint16 LE) — number of occupied slots
 *   Offset 7 … 6+bitmapBytes : slot bitmap (1 bit per slot, 1=occupied)
 *   Offset 7+bitmapBytes … : vector data (slotsPerPage × vectorByteSize bytes)
 *
 * Legacy 0xa5 pages keep their original layout. Pointer access requires an
 * independently persisted graph dimension; scans skip these untagged pages.
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
  private readonly legacySlotsPerPage: number;
  private readonly legacyDataOffset: number;
  private legacyDimensionVerified = false;

  /** In-memory hint: the last block where we found/created free space. */
  private insertHint: number = 0;

  constructor(
    private readonly file: FreeBlockFile,
    dimension: number,
  ) {
    validateVectorDimension(dimension, file._getBlockSize());
    this.dimension = dimension;
    this.vectorByteSize = VectorSerializer.byteSize(dimension);
    const blockSize = file._getBlockSize();
    // usable area = blockSize − 1 (byte 0 is block-type, owned by FreeBlockFile)
    // n * vectorByteSize + ceil(n/8) <= usable bytes minus page header.
    this.slotsPerPage = Math.floor(((blockSize - 1 - PAGE_HEADER_SIZE) * 8) / (this.vectorByteSize * 8 + 1));
    this.bitmapBytes = Math.ceil(this.slotsPerPage / 8);
    this.dataOffset = PAGE_HEADER_SIZE + this.bitmapBytes;
    this.legacySlotsPerPage = Math.floor(((blockSize - 4) * 8) / (this.vectorByteSize * 8 + 1));
    this.legacyDataOffset = LEGACY_PAGE_HEADER_SIZE + Math.ceil(this.legacySlotsPerPage / 8);
  }

  /** HNSWIndex.open calls this only after validating persisted graph metadata. */
  acceptPersistedDimension(storedDimension: number): void {
    if (storedDimension !== this.dimension) {
      throw new HnswCompatibilityError(
        `HNSW vector dimension mismatch: stored ${storedDimension}, configured ${this.dimension}.`,
      );
    }
    this.legacyDimensionVerified = true;
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
    if (inCache !== undefined) {
      this.validatePageDimension(inCache);
      return inCache;
    }
    const dirty = this.file._getDirtyBlock(pageId);
    if (dirty !== undefined) {
      const usable = dirty.subarray(1);
      this.validatePageDimension(usable);
      this._pageCache.set(pageId, usable);
      return usable;
    }
    const raw = await this.file.readBlock(pageId);
    const usable = raw.subarray(1);
    this.validatePageDimension(usable);
    this._pageCache.set(pageId, usable);
    return usable;
  }

  private validatePageDimension(usable: Buffer): void {
    if (usable[0] === LEGACY_VECTOR_PAGE_MAGIC) {
      if (!this.legacyDimensionVerified) {
        throw new HnswCompatibilityError('Legacy HNSW vector page has no independently persisted dimension.');
      }
      return;
    }
    if (usable[0] !== HNSW_VECTOR_PAGE_MAGIC) throw new HnswCompatibilityError('Not an HNSW vector page.');
    const storedDimension = usable.readUInt32LE(1);
    if (storedDimension !== this.dimension) {
      throw new HnswCompatibilityError(
        `HNSW vector page dimension mismatch: stored ${storedDimension}, configured ${this.dimension}.`,
      );
    }
  }

  private headerSize(usable: Buffer): number {
    return usable[0] === LEGACY_VECTOR_PAGE_MAGIC ? LEGACY_PAGE_HEADER_SIZE : PAGE_HEADER_SIZE;
  }

  private pageCapacity(usable: Buffer): number {
    return usable[0] === LEGACY_VECTOR_PAGE_MAGIC ? this.legacySlotsPerPage : this.slotsPerPage;
  }

  private validateSlot(usable: Buffer, slotId: number): void {
    if (!Number.isInteger(slotId) || slotId < 0 || slotId >= this.pageCapacity(usable)) {
      throw new HnswCompatibilityError(`Invalid HNSW vector slot ${slotId}.`);
    }
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
    if (raw.readUInt32LE(2) !== this.dimension) return null; // another dimension's heap
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
    buf.writeUInt32LE(this.dimension, 1);
    return buf;
  }

  // usedCount follows the magic and optional persisted dimension.
  private getUsedCount(usable: Buffer): number {
    return usable.readUInt16LE(this.headerSize(usable) - 2);
  }

  private setUsedCount(usable: Buffer, count: number): void {
    usable.writeUInt16LE(count, this.headerSize(usable) - 2);
  }

  // Bitmap follows the page header.
  private isBitSet(usable: Buffer, slotId: number): boolean {
    const byte = usable.readUInt8(this.headerSize(usable) + Math.floor(slotId / 8));
    return (byte & (1 << slotId % 8)) !== 0;
  }

  private setBit(usable: Buffer, slotId: number): void {
    const byteIdx = this.headerSize(usable) + Math.floor(slotId / 8);
    usable.writeUInt8(usable.readUInt8(byteIdx) | (1 << slotId % 8), byteIdx);
  }

  private clearBit(usable: Buffer, slotId: number): void {
    const byteIdx = this.headerSize(usable) + Math.floor(slotId / 8);
    usable.writeUInt8(usable.readUInt8(byteIdx) & ~(1 << slotId % 8), byteIdx);
  }

  private vectorOffset(usable: Buffer, slotId: number): number {
    const offset = usable[0] === LEGACY_VECTOR_PAGE_MAGIC ? this.legacyDataOffset : this.dataOffset;
    return offset + slotId * this.vectorByteSize;
  }

  // FINDING A FREE SLOT

  /**
   * Find the first free slot in an existing page, or return -1 if full.
   */
  private findFreeSlot(usable: Buffer): number {
    if (this.getUsedCount(usable) >= this.pageCapacity(usable)) return -1;
    for (let s = 0; s < this.pageCapacity(usable); s++) {
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
    VectorSerializer.serialize(vector, usable, this.vectorOffset(usable, slotId));
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
    this.validateSlot(usable, ptr.slotId);
    if (!this.isBitSet(usable, ptr.slotId)) {
      throw new Error(`Slot (pageId=${ptr.pageId}, slotId=${ptr.slotId}) is not occupied.`);
    }
    return VectorSerializer.deserialize(usable, this.vectorOffset(usable, ptr.slotId), this.dimension);
  }

  /**
   * Free the slot at `ptr`.
   * If the page becomes completely empty, the underlying block is freed.
   */
  async delete(ptr: VectorPointer): Promise<void> {
    // A page whose last slot was deleted is already on the free list.
    const raw = this.file._getDirtyBlock(ptr.pageId) ?? (await this.file.readBlock(ptr.pageId));
    const blockType = raw.readUInt8(0) as BlockType;
    if (blockType === BlockType.Free) return;
    const usable = await this.readPage(ptr.pageId);
    this.validateSlot(usable, ptr.slotId);
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
    this.validateSlot(usable, ptr.slotId);
    if (!this.isBitSet(usable, ptr.slotId)) {
      throw new Error(`Slot (pageId=${ptr.pageId}, slotId=${ptr.slotId}) is not occupied.`);
    }
    VectorSerializer.serialize(vector, usable, this.vectorOffset(usable, ptr.slotId));
    await this.writePage(ptr.pageId, usable);
  }

  /**
   * Async generator that yields every stored vector together with its pointer.
   * Skips freed slots transparently.
   */
  async *scan(): AsyncGenerator<{ ptr: VectorPointer; vector: Float32Array }> {
    const blockCount = Math.max(this.file._getCachedBlockCount(), this.file._getHighestDirtyBlock() + 1);
    for (let pageId = 1; pageId < blockCount; pageId++) {
      const usable = await this.readPageIfData(pageId);
      if (usable === null) continue; // freed block or another page type
      if (this.getUsedCount(usable) === 0) continue;
      for (let slotId = 0; slotId < this.slotsPerPage; slotId++) {
        if (this.isBitSet(usable, slotId)) {
          const vector = VectorSerializer.deserialize(usable, this.vectorOffset(usable, slotId), this.dimension);
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
