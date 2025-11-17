import * as fs from 'fs/promises';

export class FreeBlockFile {
  private blockSize: number;
  private filePath: string;
  constructor(blockSize: number, filePath: string) {
    this.blockSize = blockSize;
    this.filePath = filePath;
  }

  private fileHandle: fs.FileHandle | null = null;
  private rootBlock = 0;
  private firstfreeBlock = 0;
  private isOpen = false;

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
    if (!this.fileHandle || !this.isOpen) {
      throw new Error('no filehandle yet or not open');
    }
    if (blockNumber < 0) {
      throw new Error(`Invalid block number: ${blockNumber}`);
    }
    const offset = blockNumber * this.blockSize;
    const buffer = Buffer.alloc(this.blockSize);
    await this.fileHandle.read(buffer, 0, this.blockSize, offset);
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
    if (!this.fileHandle || !this.isOpen) {
      throw new Error('no filehandle yet or not open');
    }

    if (blockNumber < 0) {
      throw new Error(`Invalid block number: ${blockNumber}`);
    }

    if (data.length > this.blockSize) throw new Error('Block too large');
    const offset = blockNumber * this.blockSize;
    const buffer = Buffer.alloc(this.blockSize);
    data.copy(buffer);
    await this.fileHandle.write(buffer, 0, this.blockSize, offset);
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
  async create(): Promise<void> {
    this.fileHandle = await fs.open(this.filePath, 'w+');
    this.rootBlock = 0;
    this.firstfreeBlock = 0;
    const header = Buffer.alloc(this.blockSize, 0);
    header.writeBigUInt64LE(BigInt(this.rootBlock), 0);
    header.writeBigUInt64LE(BigInt(this.firstfreeBlock), 8);
    await this.fileHandle.write(header, 0, this.blockSize, 0);
    await this.fileHandle.sync();
  }

  /**
   * Open an existing file and loads its header into memory.
   * @returns {Promise<void>}
   * @throws {Error} If the file is already open.
   * @author Arthur Cukier
   */
  async open(): Promise<void> {
    if (this.isOpen) throw new Error('File already open');
    this.fileHandle = await fs.open(this.filePath, 'r+');
    this.isOpen = true;
    const header = Buffer.alloc(this.blockSize);
    await this.fileHandle.read(header, 0, this.blockSize, 0);
    this.rootBlock = Number(header.readBigUInt64LE(0));
    this.firstfreeBlock = Number(header.readBigUInt64LE(8));
  }

  /**
   * Closes the file handle, ensuring all writes are flushed to disk.
   * @returns {Promise<void>}
   * @author Arthur Cukier
   */
  async close(): Promise<void> {
    if (!this.isOpen || !this.fileHandle) return;
    if (this.fileHandle) {
      await this.fileHandle.sync();
      await this.fileHandle.close();
    }
    this.isOpen = false;
    this.fileHandle = null;
  }

  /**
   * Reads the root block number from block 0 (bytes 0–7).
   * Reads bytes [0–7] of block 0 and updates the in-memory 'rootBlock'.
   *
   * @returns {Promise<number>} The current root block number.
   * @throws {Error} If the file does not exist or if the file is not open.
   * @author Arthur Cukier
   */
  async getRootBlock(): Promise<number> {
    if (!this.fileHandle || !this.isOpen) {
      throw new Error('File not existing or not open');
    }

    const header = await this.readBlock(0);
    this.rootBlock = Number(header.readBigUInt64LE(0));
    return this.rootBlock;
  }

  /**
   * Updates the root block number in block 0 (bytes 0–7),
   * keeping the firstfreeBlock value (bytes 8–15) intact.
   *
   * @param {number} blockNum - The new root block number.
   * @throws {Error} If the file does not exist or if the file is not open.
   * @returns {Promise<void>}
   * @author Arthur Cukier
   */
  async setRootBlock(blockNum: number): Promise<void> {
    if (!this.isOpen || !this.fileHandle) {
      throw new Error('Cannot set root block: file not open');
    }

    const header = await this.readBlock(0);
    header.writeBigUInt64LE(BigInt(blockNum), 0);
    await this.writeBlock(0, header);

    this.rootBlock = blockNum;
  }

  /**
   * Reads the first free block pointer from block 0 (bytes 8–15).
   *
   * @returns {Promise<number>} The block number of the first free block or 0 if there are no free blocks.
   * @throws {Error} If the file does not exist or if the file is not open.
   * @author Arthur Cukier
   */
  async getFirstFreeBlock(): Promise<number> {
    if (!this.isOpen || !this.fileHandle) {
      throw new Error('Cannot get free block: file not open');
    }

    const header = await this.readBlock(0);
    this.firstfreeBlock = Number(header.readBigUInt64LE(8));
    return this.firstfreeBlock;
  }

  /**
   * Updates the first free block pointer in block 0 (bytes 8–15),
   * keeping the rootBlock value (bytes 0–7) intact.
   *
   * @param {number} blockNum - The block number to set as the first free block (0 = none).
   * @returns {Promise<void>}
   * @throws {Error} If the file does not exist or if the file is not open.
   * @author Arthur Cukier
   */
  async setFirstFreeBlock(blockNum: number): Promise<void> {
    if (!this.isOpen || !this.fileHandle) {
      throw new Error('Cannot set free block: file not open');
    }

    const header = await this.readBlock(0);

    header.writeBigUInt64LE(BigInt(blockNum), 8);

    await this.writeBlock(0, header);
    this.firstfreeBlock = blockNum;
  }

  /**
   * Allocates a block by removing it from the head of the free list.
   *
   * The first block in the free list is returned to the caller and the
   * header is updated so that its successor becomes the new head.
   *
   * @returns {Promise<number>} The block number allocated for use.
   * @throws {Error} If the file does not exist or if the file is not open.
   * @throws {Error} If no free blocks are available.
   * @author Arthur Cukier
   */
  async allocateBlock(): Promise<number> {
    if (!this.isOpen || !this.fileHandle) {
      throw new Error('Cannot allocate: file not open');
    }

    const freeBlock = await this.getFirstFreeBlock();

    if (freeBlock === 0) {
      throw new Error('Free list empty — expected at least one free block');
    }

    const freeBlockBuf = await this.readBlock(freeBlock);
    const nextFree = Number(freeBlockBuf.readBigUInt64LE(0));

    await this.setFirstFreeBlock(nextFree);

    return freeBlock;
  }

  /**
   * Frees a block by adding it to the head of the free list.
   *
   * The freed block’s first 8 bytes store the previous head of the list,
   * effectively inserting this block at the beginning of the chain.
   * The header is then updated to point to this block.
   *
   * @param {number} blockNumber - Block number to free (must not be 0).
   * @returns {Promise<void>}
   * @throws {Error} If attempting to free block 0 or if the file is not open or if the file does not exist.
   * @author Arthur Cukier
   */
  async free(blockNumber: number): Promise<void> {
    if (!this.isOpen || !this.fileHandle) {
      throw new Error('Cannot free: file not open');
    }

    if (blockNumber === 0) {
      throw new Error('Cannot free header block (block 0)');
    }
    const currentHead = this.firstfreeBlock;

    const buf = Buffer.alloc(this.blockSize, 0);
    buf.writeBigUInt64LE(BigInt(currentHead), 0);
    await this.writeBlock(blockNumber, buf);

    await this.setFirstFreeBlock(blockNumber);
  }

  /**
   * Returns the total number of blocks in the file.
   *
   * @returns {Promise<number>} Total number of blocks in the file.
   * @throws {Error} If the file is not open or I/O fails.
   * @author Arthur Cukier
   */
  async getBlockCount(): Promise<number> {
    if (!this.isOpen || !this.fileHandle) {
      throw new Error('Cannot count blocks: file not open');
    }

    const stats = await this.fileHandle.stat();
    return Math.floor(stats.size / this.blockSize);
  }

  /**
   * Counts how many blocks are currently marked as free.
   *
   * @returns {Promise<number>} The number of free blocks found.
   * @throws {Error} If the file is not open or I/O fails.
   * @author Arthur Cukier
   */
  async getFreeBlockCount(): Promise<number> {
    if (!this.isOpen || !this.fileHandle) {
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
}
