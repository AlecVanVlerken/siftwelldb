<<<<<<< HEAD
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
import { allocateBlock, freeBlock, getFreeBlockCount } from './freelist.mjs';
import { getRootBlock, setRootBlock, getClientArea, writeClientArea } from './header.mjs';
import { commit } from './commit.mjs';
import * as layout from './layout.mjs';

export class FreeBlockFile {
  private file: AtomicFile;
  private blockSize: number;

  private dirtyBlocks: Map<number, Buffer> = new Map();

  private isOpen = false;

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

=======
import { type File } from '../core/file.mjs';
import { type AtomicFile } from 'wait implementation';

export class FreeBlockFile {
  private file: File;
  private blockSize: number;
  private dirtyBlocks: Map<number, Buffer> = new Map();
  private atomicFile: new AtomicFile;
  private rootBlock = 0;
  private firstfreeBlock = 0;
  private isOpen = false;

  constructor(file: File, blockSize: number) {
>>>>>>> ade49aa (Use constructor File and dirtyBlocks)
    this.file = file;
    this.blockSize = blockSize;
  }

  /**
   * Create a new file and initialize header (block 0).
   * The header block is written with both the root block and first free
   * block pointers set to 0. This marks the file as newly initialized.
   * @returns {Promise<void>}
   * @author Arthur Cukier
   */
  async create(){
    await this.file.create();
  }

  /**
   * Open an existing file and loads its header into memory.
   * @returns {Promise<void>}
   * @throws {Error} If the file is already open.
   * @author Arthur Cukier
   */
  async open() {
    if (this.isOpen) throw new Error('File already open');
    await this.file.open();
    this.isOpen = true;
  }

  /**
   * Closes the file.
   * @returns {Promise<void>}
   * @author Arthur Cukier
   */
  async close() {
    if (!this.isOpen) return;
    await this.file.close();
    this.isOpen = false;
  }

  /**
   * Opens the underlying file and loads the header into memory on demand.
   *
   * @returns {Promise<void>} Created file with initialized header with the file in a closed state
   * @throws {Error} If the file is already open.
   *
   * @author Arthur Cukier
   */
  async create() {
    await this.file.create();

    const wasOpen = this.isOpen;
    if (!wasOpen) {
      await this.file.open();
      this.isOpen = true;
    }

    const header = Buffer.alloc(this.blockSize);
    header.writeUInt8(layout.BlockType.Header, layout.HEADER_TYPE_OFFSET);
    header.writeUInt32LE(0, layout.HEADER_FIRST_FREE_OFFSET);
    header.writeUInt32LE(0, layout.HEADER_ROOT_OFFSET);

    this.dirtyBlocks.set(0, header);
    await this.commit();

    if (!wasOpen) {
      await this.file.close();
      this.isOpen = false;
    }
  }

  /**
   * Open an existing file and loads its header into memory.
   * The internal root and free-list pointers are reloaded from the header.
   *
   * @returns {Promise<void>} Opened file
   * @throws {Error} If the file is already open.
   *
   * @author Arthur Cukier
   */
  async open() {
    if (this.isOpen) throw new Error('File already open');
    await this.file.open();
    this.isOpen = true;
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
<<<<<<< HEAD
    return await readBlock(this, blockNumber);
=======
    const cached = this.dirtyBlocks.get(blockNumber);
    if (cached !== undefined) {
      return cached;
    }

    const offset = blockNumber * this.blockSize;
    const buffer = Buffer.alloc(this.blockSize);
    await this.file.read(buffer, { position: offset });
    return buffer;
>>>>>>> ade49aa (Use constructor File and dirtyBlocks)
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
<<<<<<< HEAD
    await writeBlock(this, blockNumber, data);
  }

  /**
   * Returns the client metadata area stored in the header block.
   *
   * The client area begins at byte HEADER_CLIENT_AREA_OFFSET.
   *
   * @returns {Promise<Buffer>} A copy of the client area.
   * @throws {Error} If the file is not open.
=======
    if (data.length > this.blockSize) {
      throw new Error(`Block too large (${data.length})`);
    }

    const buffer = Buffer.alloc(this.blockSize);
    data.copy(buffer);
    this.dirtyBlocks.set(blockNumber, buffer);
    await Promise.resolve();
  }

  /**
   * Reads the client area from block 0.
   *
   * The client area is a reserved block (block 0) that contains database metadata,
   * such as the version, free list head, and root block pointers for collections.
   *
   * @returns {Promise<Buffer>} A buffer containing the client area (block 0) data.
>>>>>>> ade49aa (Use constructor File and dirtyBlocks)
   *
   * @author Alec Van Vlerken
   */
  async getClientArea(): Promise<Buffer> {
<<<<<<< HEAD
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
=======
    return this.readBlock(0);
  }

  /**
   * Writes to the client area in block 0.
   *
   * The client area stores metadata about the database. This function overwrites
   * the entire block 0 with the provided buffer, which must be <= blockSize.
   *
   * @param {Buffer} buffer - A buffer containing the metadata to write.
   * @returns {Promise<void>} A promise that resolves when the client area has been successfully written.
   *
   * @throws {Error} If the buffer exceeds the block size.
   *
   * @author Alec Van Vlerken
   */

  async writeClientArea(buffer: Buffer): Promise<void> {
    return this.writeBlock(0, buffer);
>>>>>>> ade49aa (Use constructor File and dirtyBlocks)
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
<<<<<<< HEAD
   * @returns {Promise<void>} A promise that resolves once all pending changes are durably and atomically written to disk.
   * @throws {Error} If the file is not open.
=======
   * @returns {Promise<void>} A promise that resolves once all pending changes
   * are durably and atomically written to disk.
>>>>>>> ade49aa (Use constructor File and dirtyBlocks)
   *
   * @author Alec Van Vlerken
   */
  async commit(): Promise<void> {
<<<<<<< HEAD
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

  // -------- Internal helpers (not for external use) --------

  _getDirtyBlock(block: number) {
    return this.dirtyBlocks.get(block);
  }

  _setDirtyBlock(block: number, buf: Buffer) {
    this.dirtyBlocks.set(block, buf);
  }

  _getDirtyBlocks() {
    return this.dirtyBlocks;
  }

  _dirtyBlockKeys() {
    return this.dirtyBlocks.keys();
  }

  _clearDirty() {
    this.dirtyBlocks.clear();
  }

  _getFile() {
    return this.file;
  }

  _getBlockSize() {
    return this.blockSize;
  }

  _ensureOpen(): void {
    if (!this.isOpen) throw new Error('File not open');
=======
    if (this.dirtyBlocks.size === 0) return;

    // Assuming atomicWrite() has a list as input
    const writeOps: Array<{ offset: number; data: Buffer }> = [];

    for (const [blockNum, buffer] of this.dirtyBlocks) {
      writeOps.push({
        offset: blockNum * this.blockSize,
        data: buffer,
      });
    }

    await this.atomicFile.atomicWrite(writeOps);

    await this.file.sync();

    this.dirtyBlocks.clear();
>>>>>>> ade49aa (Use constructor File and dirtyBlocks)
  }

  /**
   * Reads the first free block pointer from block 0 (bytes 8–15).
   *
   * @returns {Promise<number>} The block number of the first free block or 0 if there are no free blocks.
   * @throws {Error} If the file is not open.
   * @author Arthur Cukier
   */
  async getFirstFreeBlock(): Promise<number> {
    if (!this.isOpen) {
      throw new Error('File not open');
    }

    let header: Buffer;

  if (this.dirtyBlocks.has(0)) {
    header = this.dirtyBlocks.get(0)!;
  } else {
    header = await this.readBlock(0);
  }

  this.firstfreeBlock = Number(header.readBigUInt64LE(8));
  return this.firstfreeBlock;
  }

  /**
   * Updates the first free block pointer in block 0 (bytes 8–15),
   * keeping the rootBlock value (bytes 0–7) intact.
   *
   * @param {number} blockNum - The block number to set as the first free block (0 = none).
   * @returns {Promise<void>}
   * @throws {Error} If the file is not open.
   * @author Arthur Cukier
   */
  async setFirstFreeBlock(blockNum: number): Promise<void> {
    if (!this.isOpen) throw new Error('File not open');

  let header: Buffer;

  if (this.dirtyBlocks.has(0)) {
    header = this.dirtyBlocks.get(0)!;
  } else {
    header = await this.readBlock(0);
  }

  header.writeBigUInt64LE(BigInt(blockNum), 8);
  this.dirtyBlocks.set(0, header);
  this.firstfreeBlock = blockNum;}

  /**
   * Returns the total number of blocks in the file.
   *
   * @returns {Promise<number>} Total number of blocks in the file.
   * @throws {Error} If the file is not open.
   * @author Arthur Cukier
   */
  async getBlockCount(): Promise<number> {
    if (!this.isOpen) {
      throw new Error('Cannot count blocks: file not open');
    }

    const stats = await this.file.stat();
    return Math.floor(stats.size / this.blockSize);
  }

  /**
   * Counts how many blocks are currently marked as free.
   *
   * @returns {Promise<number>} The number of free blocks found.
   * @throws {Error} If the file is not open.
   * @author Arthur Cukier
   */
  async getFreeBlockCount(): Promise<number> {
    if (!this.isOpen) {
      throw new Error('Cannot count free blocks: file not open');
    }

    let count = 0;
    let current = await this.getFirstFreeBlock();

    while (current !== 0) {
      count++;
      const buf = await this.readBlock(current);
      current = Number(buf.readBigUInt64LE(0));
    }

    return count;
  }

  /**
 * Allocates a block by removing it from the head of the free list.
 * Works against the dirty header if present; no direct disk writes.
 * @returns {Promise<void>}
 * @throws {Error} If the file is not open or the free list is empty.
 * @author Arthur Cukier
 */
async allocateBlock(): Promise<number> {
  if (!this.isOpen) throw new Error('File not open');

  const head = await this.getFirstFreeBlock();
  if (head === 0) throw new Error('Free list empty cannot be empty');

  let headBuf: Buffer;
  if (this.dirtyBlocks.has(head)) {
    headBuf = this.dirtyBlocks.get(head)!;
  } else {
    headBuf = await this.readBlock(head);
  }

  const nextFree = Number(headBuf.readBigUInt64LE(0));

  await this.setFirstFreeBlock(nextFree);
  return head;
}

/**
 * Frees a block by inserting it at the head of the free list.
 * Writes only to the dirty cache; no direct disk writes.
 * @returns {Promise<void>}
 * @throws {Error} If the file is not open or if blockNumber is 0.
 * @author Arthur Cukier
 */
async freeBlock(blockNumber: number): Promise<void> {
  if (!this.isOpen) throw new Error('File not open');
  if (blockNumber === 0) throw new Error('Cannot free block 0');

  const currentHead = await this.getFirstFreeBlock();

  let buf: Buffer;
  if (this.dirtyBlocks.has(blockNumber)) {
    buf = this.dirtyBlocks.get(blockNumber)!;
  } else {
    buf = await this.readBlock(blockNumber);
  }

  buf.writeBigUInt64LE(BigInt(currentHead), 0);
  this.dirtyBlocks.set(blockNumber, buf);
  await this.setFirstFreeBlock(blockNumber);
}

/**
 * Retrieves the current root block number.
 *
 * If block 0 (the header) is dirty in memory, reads the root
 * directly from the in-memory buffer. Otherwise, reads it from disk.
 *
 * @returns {Promise<number>} The most recent root block number.
 * @throws {Error} If the file is not open.
 * @author Arthur Cukier
 */
async getRootBlock(): Promise<number> {
  if (!this.isOpen) throw new Error('File not open');

  let header: Buffer;

  if (this.dirtyBlocks.has(0)) {
    header = this.dirtyBlocks.get(0)!;
  } else {
    header = await this.readBlock(0);
  }

  this.rootBlock = Number(header.readBigUInt64LE(0));
  return this.rootBlock;
}


/**
 * Updates the root block number in the header (block 0).
 * 
 * The new value is written to the in-memory dirty block cache,
 * not directly to disk. This ensures that changes become
 * permanent only after a successful commit().
 *
 * If block 0 is not yet cached, it is first loaded from disk.
 *
 * @param {number} blockNum - The new root block number.
 * @returns {Promise<void>}
 * @throws {Error} If the file is not open.
 * @author Arthur Cukier
 */
async setRootBlock(blockNum: number): Promise<void> {
  if (!this.isOpen) throw new Error('File not open');

  let header: Buffer;

  if (this.dirtyBlocks.has(0)) {
    header = this.dirtyBlocks.get(0)!;
  } else {
    header = await this.readBlock(0);
  }

  header.writeBigUInt64LE(BigInt(blockNum), 0);

  this.dirtyBlocks.set(0, header);
  this.rootBlock = blockNum;
}



}
