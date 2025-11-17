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
    this.file = file;
    this.blockSize = blockSize;
  }

  /**
   * Create a new file and initialize header (block 0).
   * The header block is written with both the root block and first free
   * block pointers set to 0. This marks the file as newly initialized.
   * Header layout:
   *   [0–7]  rootBlock  (uint64 LE)
   *   [8–15] freeBlock   (uint64 LE)
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
   * Reads a single block of data from the file at the specified block number.
   *
   * Each block has a fixed size defined by 'this.blockSize'. The function
   * calculates the byte offset of the block in the file, reads exactly
   * 'blockSize' bytes into a buffer, and returns it.
   *
   * @param {number} blockNumber - The index of the block to read (0-based).
   * @returns {Promise<Buffer>} A promise that resolves with a Buffer
   * containing the block data. The buffer is always 'blockSize' bytes long.
   *
   * @author Alec Van Vlerken
   */
  async readBlock(blockNumber: number): Promise<Buffer> {
    const cached = this.dirtyBlocks.get(blockNumber);
    if (cached !== undefined) {
      return cached;
    }

    const offset = blockNumber * this.blockSize;
    const buffer = Buffer.alloc(this.blockSize);
    await this.file.read(buffer, { position: offset });
    return buffer;
  }

  /**
   * Writes a single block of data to the file at the specified block number.
   *
   * Each block has a fixed size defined by 'this.blockSize'. The function
   * calculates the byte offset of the block in the file, copies the provided
   * data into a buffer of size 'blockSize', and writes it to the file.
   * If the input data is larger than the block size, an error is thrown.
   *
   * @param {number} blockNumber - The index of the block to write (0-based).
   * @param {Buffer} data - A buffer containing the data to write. Must not exceed 'blockSize' bytes.
   * @returns {Promise<void>} A promise that resolves once the write operation is complete.
   *
   * @throws {Error} If the data length exceeds 'blockSize'.
   *
   * @author Alec Van Vlerken
   */
  async writeBlock(blockNumber: number, data: Buffer): Promise<void> {
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
   *
   * @author Alec Van Vlerken
   */
  async getClientArea(): Promise<Buffer> {
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
   * @returns {Promise<void>} A promise that resolves once all pending changes
   * are durably and atomically written to disk.
   *
   * @author Alec Van Vlerken
   */
  async commit(): Promise<void> {
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
  }

  /**
   * Reads the root block number from block 0 (bytes 0–7).
   * Reads bytes [0–7] of block 0 of and updates the in-memory 'rootBlock'.
   *
   * @returns {Promise<number>} The current root block number.
   * @throws {Error} If the file is not open.
   * @author Arthur Cukier
   */
  async getRootBlock(): Promise<number> {
    if (!this.isOpen) {
      throw new Error('File not open');
    }
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
   * Updates the root block number in block 0 (bytes 0–7),
   * keeping the firstfreeBlock value (bytes 8–15) intact.
   *
   * @param {number} blockNum - The new root block number.
   * @throws {Error} If the file is not open.
   * @returns {Promise<void>}
   * @author Arthur Cukier
   */
  async setRootBlock(blockNum: number): Promise<void> {
    if (!this.isOpen) {
      throw new Error('File not open');
    }

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
 * @throws {Error} If the file is not open or if blockNumber is 0.
 * @author Arthur Cukier
 */
async free(blockNumber: number): Promise<void> {
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



}
