// @author: Arthur Cukier. Alec Van Vlerken
// @date: 2025-12-03

/**
 * FreeBlockFile
 * ---------------------------
 * High-level block storage abstraction built on top of an AtomicFile.
 *
 * This class offers:
 *   - Fixed-size block storage
 *   - A header block containing:
 *        * free-list head pointer
 *        * root pointer for higher-level data structures (e.g., B+ trees)
 *        * user-defined client metadata
 *   - A linked free-list for fast block allocation / deallocation
 *   - Crash-safe commits via AtomicFile
 */

import { type AtomicFile } from '../atomic/atomicfile.mjs';

import { readBlock, writeBlock } from './io.mjs';
import { allocateBlock, allocateBlockBelow, allocateBlocksBelow, freeBlock, getFreeBlockCount } from './freelist.mjs';
import { getRootBlock, setRootBlock, getClientArea, writeClientArea } from './header.mjs';
import { commit } from './commit.mjs';
import * as layout from './layout.mjs';

export type TailTrimResult = {
  removedBlocks: number;
  newBlockCount: number;
};

export type FreeBlockFileStats = {
  blockSize: number;
  fileSizeBytes: number;
  totalBlocks: number;
  freeBlocks: number;
  usedBlocks: number;
  freeTailBlocks: number;
};

export class FreeBlockFile {
  private file: AtomicFile;
  private blockSize: number;

  private dirtyBlocks: Map<number, Buffer> = new Map();
  private highestDirtyBlock: number = -1;

  private isOpen = false;

  // Cached physical block count to avoid repeated stat() calls
  // Updated on open() and commit()
  private cachedPhysicalBlockCount: number = 0;

  /** Callbacks invoked (in registration order) immediately before every commit. */
  private _preCommitHooks: Array<() => Promise<void>> = [];

  /**
   * Creates a new FreeBlockFile instance controlling a block-structured file.
   *
   * This class manages a file divided into fixed-size blocks and maintains a
   * free-list for block allocation. Block 0 is reserved as a header block.
   *
   * @param {AtomicFileFile} file Low-level file abstraction used for physical disk access.
   * @param {number} blockSize Size (in bytes) of each block.
   * @throws {Error} If blockSize is not a positive integer.
   * @throws {Error} If blockSize is too small to store the header layout.
   *
   * @author Arthur Cukier, Alec Van Vlerken
   */
  constructor(file: AtomicFile, blockSize: number) {
    if (!Number.isInteger(blockSize) || blockSize <= 0) {
      throw new Error(`Invalid block size: ${blockSize}`);
    }
    if (blockSize <= layout.HEADER_CLIENT_AREA_OFFSET) {
      throw new Error(`Block size must be > ${layout.HEADER_CLIENT_AREA_OFFSET} to fit header`);
    }

    this.file = file;
    this.blockSize = blockSize;
  }

  /**
   * Creates a new underlying file and initializes its header.
   *
   * This method writes an empty header block containing the block type,
   * the initial free-list head (0), and the initial root pointer (0).
   * If the file was not already open, it is opened temporarily and
   * closed again after initialization.
   *
   * @returns {Promise<void>}
   *
   * @author Arthur Cukier
   */
  async create() {
    await this.file.create();
    this.isOpen = true;
    const header = Buffer.alloc(this.blockSize);
    header.writeUInt8(layout.BlockType.Header, layout.HEADER_TYPE_OFFSET);
    header.writeUInt32LE(0, layout.HEADER_FIRST_FREE_OFFSET);
    header.writeUInt32LE(0, layout.HEADER_ROOT_OFFSET);

    this._setDirtyBlock(0, header);
    await this.commit();
  }

  /**
   * Open an existing file and loads its header into memory.
   * The internal root and free-list pointers are reloaded from the header.
   *
   * @returns {Promise<void>} Opened file
   * @throws {Error} If the file is already open.
   * @throws {Error} If the file size is not a multiple of block size (corrupted file).
   *
   * @author Arthur Cukier
   */
  async open() {
    if (this.isOpen) throw new Error('File already open');
    await this.file.open();
    this.isOpen = true;
    // Initialize cached block count from file size
    const stats = await this.file.stat();
    if (stats.size % this.blockSize !== 0) {
      throw new Error(`Corrupt file: size ${stats.size} is not a multiple of block size ${this.blockSize}`);
    }
    this.cachedPhysicalBlockCount = Math.floor(stats.size / this.blockSize);
  }

  /**
   * Closes the underlying file.
   * If the file is already closed, this method does nothing.
   *
   * @returns {Promise<void>} Closed file
   *
   * @author Arthur Cukier
   */
  async close() {
    if (!this.isOpen) return;
    await this.file.close();
    this.isOpen = false;
  }

  /**
   * Reads the data in a block from disk or from the dirty cache with the given block number.
   *
   * @param {number} blockNumber - Block index (0-based).
   * @returns {Promise<Buffer>} A buffer of size blockSize.
   *
   * @throws {Error} If the file is not open.
   * @throws {Error} If the block number is invalid.
   * @throws {Error} If the header block (block 0) is read directly.
   *
   * @author Alec Van Vlerken
   */
  async readBlock(blockNumber: number): Promise<Buffer> {
    return await readBlock(this, blockNumber);
  }

  /**
   * Stages a full block for writing.
   *
   * The data is copied into an internal buffer and stored in the dirty cache.
   * The actual disk write occurs only after calling commit().
   *
   * @param {number} blockNumber - Block index (0-based).
   * @param {Buffer} data Data to write into the block.
   * @returns {Promise<void>}
   * @throws {Error} If the file is not open.
   * @throws {Error} If the data exceeds the block size - 1.
   * @throws {Error} If the header block (block 0) is written directly.
   * @throws {Error} If the block number is invalid.
   *
   * @author Alec Van Vlerken
   */
  async writeBlock(blockNumber: number, data: Buffer): Promise<void> {
    await writeBlock(this, blockNumber, data);
  }

  /**
   * Returns the client metadata area stored in the header block.
   *
   * The client area begins at byte HEADER_CLIENT_AREA_OFFSET.
   *
   * @returns {Promise<Buffer>} A copy of the client area.
   * @throws {Error} If the file is not open.
   *
   * @author Alec Van Vlerken
   */
  async getClientArea(): Promise<Buffer> {
    return await getClientArea(this);
  }

  /**
   * Writes data into the client metadata area of the header block.
   *
   * The header fields (block type, free list pointer, root pointer)
   * remain unchanged.
   *
   * The previous client area contents are fully cleared before writing the new data.
   *
   * @param {Buffer} buffer Client metadata to write.
   * @returns {Promise<void>}
   * @throws {Error} If the buffer exceeds available client area space.
   * @throws {Error} If the file is not open.
   *
   * @author Alec Van Vlerken
   */
  async writeClientArea(buffer: Buffer): Promise<void> {
    await writeClientArea(this, buffer);
  }

  /**
   * Commits all staged (dirty) block changes to disk atomically.
   *
   * This method ensures crash-safe persistence of all pending writes using
   * the AtomicFile mechanism. It gathers all modified blocks, writes them
   * to a temporary file, and atomically swaps it into place so that the
   * database file is always in a consistent state, even in the event of
   * a crash or power failure.
   *
   * Steps:
   *  1. Collect all dirty blocks into a write set.
   *  2. Pass them to the atomic file writer for atomic persistence.
   *  3. Flush all changes to disk.
   *  4. Clear the in-memory dirty block map.
   *
   * @returns {Promise<void>} A promise that resolves once all pending changes are durably and atomically written to disk.
   * @throws {Error} If the file is not open.
   *
   * @author Alec Van Vlerken
   */
  /**
   * Registers a callback that is awaited before every commit().
   * Use this to flush higher-level in-memory state (e.g. B+tree node cache)
   * into the dirty-block map before the WAL write starts.
   */
  addPreCommitHook(hook: () => Promise<void>): void {
    this._preCommitHooks.push(hook);
  }

  removePreCommitHook(hook: () => Promise<void>): void {
    const index = this._preCommitHooks.indexOf(hook);
    if (index >= 0) {
      this._preCommitHooks.splice(index, 1);
    }
  }

  async commit(): Promise<void> {
    for (const hook of this._preCommitHooks) {
      await hook();
    }
    await commit(this);
  }

  /**
   * Returns the current root block pointer stored in the header.
   *
   * @returns {Promise<number>} Root block number.
   * @throws {Error} If the file is not open.
   *
   * @author Arthur Cukier, Alec Van Vlerken
   */
  async getRootBlock(): Promise<number> {
    return await getRootBlock(this);
  }

  /**
   * Updates the root block pointer in the header.
   *
   * The change is staged in memory and persisted only after commit().
   *
   * @param {number} blockNum - New root block number.
   * @returns {Promise<void>}
   *
   * @throws {Error} If the file is not open.
   * @throws {Error} If the block number is invalid.
   *
   * @author Arthur Cukier, Alec Van Vlerken
   */
  async setRootBlock(blockNum: number): Promise<void> {
    await setRootBlock(this, blockNum);
  }

  /**
   * Traverses the free list and counts the number of free blocks.
   *
   * Includes consistency checks for:
   *  - Out-of-range pointers
   *  - Invalid block types
   *  - Self-referential cycles
   *
   * @returns {Promise<number>} Number of free blocks.
   * @throws {Error} If the file is not open.
   * @throws {Error} If the free list is corrupted.
   *
   * @author Arthur Cukier, Alec Van Vlerken
   */
  async getFreeBlockCount(): Promise<number> {
    return await getFreeBlockCount(this);
  }

  /**
   * Allocates a data block.
   *
   * If the free list is non-empty, the first free block is removed
   * from the free list and reused.
   * If the free list is empty, a new block is appended to the file.
   *
   * The allocated block is marked as BlockType.Data and staged
   * in the dirty cache. Disk modification happens only after a commit().
   *
   * @returns {Promise<number>} Allocated block number.
   * @throws {Error} If the file is not open.
   * @throws {Error} If the free list is corrupted.
   *
   * @author Arthur Cukier, Alec Van Vlerken
   */
  async allocateBlock(): Promise<number> {
    return await allocateBlock(this);
  }

  async allocateBlockBelow(maxBlockExclusive: number): Promise<number | null> {
    return await allocateBlockBelow(this, maxBlockExclusive);
  }

  async allocateBlocksBelow(maxBlockExclusive: number, count: number): Promise<number[] | null> {
    return await allocateBlocksBelow(this, maxBlockExclusive, count);
  }

  /**
   * Frees a data block by prepending it to the free list.
   *
   * The block is marked as BlockType.Free and its next pointer
   * is set to the previous free list head. Changes are staged in memory
   * and persisted only after commit().
   *
   * @param {number} blockNumber Block to be released.
   * @returns {Promise<void>}
   *
   * @throws {Error} If the file is not open.
   * @throws {Error} If blockNumber is 0.
   * @throws {Error} If the block number is invalid.
   * @throws {Error} If a double-free is detected.
   * @throws {Error} If the block to be freed is not a data block.
   *
   * @author Arthur Cukier, Alec Van Vlerken
   */
  async freeBlock(blockNumber: number): Promise<void> {
    await freeBlock(this, blockNumber);
  }

  async getStats(): Promise<FreeBlockFileStats> {
    this._ensureOpen();
    const totalBlocks = Math.max(this.cachedPhysicalBlockCount, this.highestDirtyBlock + 1);
    const header = await this.readHeaderBlock();
    const freeBlocks = await this.countFreeListBlocks(totalBlocks, header);
    const freeTailBlocks = await this.countFreeTailBlocks(totalBlocks);

    return {
      blockSize: this.blockSize,
      fileSizeBytes: totalBlocks * this.blockSize,
      totalBlocks,
      freeBlocks,
      usedBlocks: totalBlocks - freeBlocks,
      freeTailBlocks,
    };
  }

  /**
   * Physically trim a suffix that consists only of free blocks.
   *
   * Tail trimming is intentionally only allowed when the dirty-block cache is
   * clean. Commit pending changes first, then call this method; it will update
   * the free-list to exclude removed blocks, commit that metadata update, and
   * then truncate the underlying file.
   */
  async trimFreeTail(): Promise<TailTrimResult> {
    this._ensureOpen();
    if (this.dirtyBlocks.size !== 0) {
      throw new Error('Cannot trim free tail while dirty blocks are pending; commit first.');
    }

    const stats = await this.file.stat();
    if (stats.size % this.blockSize !== 0) {
      throw new Error(`Corrupt file: size ${stats.size} is not a multiple of block size ${this.blockSize}`);
    }
    const blockCount = Math.floor(stats.size / this.blockSize);
    this.cachedPhysicalBlockCount = blockCount;

    if (blockCount <= 1) {
      return { removedBlocks: 0, newBlockCount: blockCount };
    }

    let newBlockCount = blockCount;
    for (let blockNumber = blockCount - 1; blockNumber > 0; blockNumber--) {
      const block = await this.readBlock(blockNumber);
      const type = block.readUInt8(layout.FREE_TYPE_OFFSET) as layout.BlockType;
      if (type !== layout.BlockType.Free) {
        break;
      }
      newBlockCount = blockNumber;
    }

    const removedBlocks = blockCount - newBlockCount;
    if (removedBlocks === 0) {
      return { removedBlocks: 0, newBlockCount: blockCount };
    }

    const header = await this.readHeaderBlock();
    const root = header.readUInt32LE(layout.HEADER_ROOT_OFFSET);
    if (root >= newBlockCount) {
      throw new Error(`Corrupt header: root=${root} would be trimmed`);
    }

    const keptFreeBlocks = await this.collectFreeListBlocksBelow(newBlockCount, blockCount, header);
    this.rewriteFreeList(keptFreeBlocks, header);

    await commit(this);
    await this.file.truncate(newBlockCount * this.blockSize);
    await this.file.sync();
    this.cachedPhysicalBlockCount = newBlockCount;

    return { removedBlocks, newBlockCount };
  }

  // -------- Internal helpers (not for external use) --------

  _getDirtyBlock(block: number) {
    return this.dirtyBlocks.get(block);
  }

  _setDirtyBlock(block: number, buf: Buffer) {
    this.dirtyBlocks.set(block, buf);
    if (block > this.highestDirtyBlock) {
      this.highestDirtyBlock = block;
    }
  }

  _getDirtyBlocks() {
    return this.dirtyBlocks;
  }

  _dirtyBlockKeys() {
    return this.dirtyBlocks.keys();
  }

  _getHighestDirtyBlock() {
    return this.highestDirtyBlock;
  }

  _clearDirty() {
    // Update cached block count if we wrote beyond the previous physical size
    if (this.highestDirtyBlock >= this.cachedPhysicalBlockCount) {
      this.cachedPhysicalBlockCount = this.highestDirtyBlock + 1;
    }
    this.dirtyBlocks.clear();
    this.highestDirtyBlock = -1;
  }

  _getFile() {
    return this.file;
  }

  _getBlockSize() {
    return this.blockSize;
  }

  _ensureOpen(): void {
    if (!this.isOpen) throw new Error('File not open');
  }

  private async readHeaderBlock(): Promise<Buffer> {
    const header = Buffer.alloc(this.blockSize);
    await this.file.read(header, { position: 0 });
    const type = header.readUInt8(layout.HEADER_TYPE_OFFSET) as layout.BlockType;
    if (type !== layout.BlockType.Header) {
      throw new Error(`Corrupt header: expected ${layout.BlockType.Header}, got ${type}`);
    }
    return header;
  }

  private async countFreeTailBlocks(totalBlocks: number): Promise<number> {
    let count = 0;

    for (let blockNumber = totalBlocks - 1; blockNumber > 0; blockNumber--) {
      const block = await this.readBlock(blockNumber);
      const type = block.readUInt8(layout.FREE_TYPE_OFFSET) as layout.BlockType;
      if (type !== layout.BlockType.Free) {
        break;
      }
      count++;
    }

    return count;
  }

  private async countFreeListBlocks(blockCount: number, header: Buffer): Promise<number> {
    let count = 0;
    let current = header.readUInt32LE(layout.HEADER_FIRST_FREE_OFFSET);
    let steps = 0;

    while (current !== 0) {
      if (steps++ >= blockCount) {
        throw new Error('Corrupt free list: cycle detected');
      }
      if (current >= blockCount) {
        throw new Error(`Corrupt free list: free block ${current.toString()} >= block count ${blockCount}`);
      }

      const block = await this.readBlock(current);
      const type = block.readUInt8(layout.FREE_TYPE_OFFSET) as layout.BlockType;
      if (type !== layout.BlockType.Free) {
        throw new Error(`Corrupt free list: block ${current.toString()} has type ${type}, expected Free`);
      }

      count++;
      const next = block.readUInt32LE(layout.FREE_NEXT_OFFSET);
      if (next === current) {
        throw new Error(`Corrupt free list: self-referential free block at ${current.toString()}`);
      }
      current = next;
    }

    return count;
  }

  private async collectFreeListBlocksBelow(
    newBlockCount: number,
    oldBlockCount: number,
    header: Buffer,
  ): Promise<number[]> {
    const keptFreeBlocks: number[] = [];
    let current = header.readUInt32LE(layout.HEADER_FIRST_FREE_OFFSET);
    let steps = 0;

    while (current !== 0) {
      if (steps++ >= oldBlockCount) {
        throw new Error('Corrupt free list: cycle detected');
      }
      if (current >= oldBlockCount) {
        throw new Error(`Corrupt free list: free block ${current.toString()} >= block count ${oldBlockCount}`);
      }

      const block = await this.readBlock(current);
      const type = block.readUInt8(layout.FREE_TYPE_OFFSET) as layout.BlockType;
      if (type !== layout.BlockType.Free) {
        throw new Error(`Corrupt free list: block ${current.toString()} has type ${type}, expected Free`);
      }

      const next = block.readUInt32LE(layout.FREE_NEXT_OFFSET);
      if (next === current) {
        throw new Error(`Corrupt free list: self-referential free block at ${current.toString()}`);
      }
      if (current < newBlockCount) {
        keptFreeBlocks.push(current);
        this._setDirtyBlock(current, block);
      }
      current = next;
    }

    return keptFreeBlocks;
  }

  private rewriteFreeList(keptFreeBlocks: number[], header: Buffer): void {
    header.writeUInt32LE(keptFreeBlocks[0] ?? 0, layout.HEADER_FIRST_FREE_OFFSET);
    this._setDirtyBlock(0, header);

    for (let i = 0; i < keptFreeBlocks.length; i++) {
      const blockNumber = keptFreeBlocks[i];
      const block = this.dirtyBlocks.get(blockNumber);
      if (!block) {
        throw new Error(`Missing free block ${blockNumber.toString()} while rebuilding free list`);
      }
      block.writeUInt32LE(keptFreeBlocks[i + 1] ?? 0, layout.FREE_NEXT_OFFSET);
      this._setDirtyBlock(blockNumber, block);
    }
  }

  /**
   * Get the cached physical block count.
   * This avoids repeated stat() calls for better performance.
   */
  _getCachedBlockCount(): number {
    return this.cachedPhysicalBlockCount;
  }
}
