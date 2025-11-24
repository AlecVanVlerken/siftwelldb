import { type File } from '../core/file.mjs';
import { type AtomicFile } from 'wait implementation';

const enum BlockType {
  Free = 0x00,
  Header = 0x01,
  Data = 0x02,
}

// Header block (block 0) layout:
// byte 0      : BlockType.Header
// bytes 1–8   : first free block pointer (u64 LE)
// bytes 9–16  : root block pointer (u64 LE)
// bytes 17–.. : client area (user metadata)
const HEADER_TYPE_OFFSET = 0;
const HEADER_FIRST_FREE_OFFSET = 1;
const HEADER_ROOT_OFFSET = 9;
const HEADER_CLIENT_AREA_OFFSET = 17;

// Free block layout:
// byte 0      : BlockType.Free
// bytes 1–8   : next free block pointer (u64 LE)
// bytes 9–..  : unused
const FREE_TYPE_OFFSET = 0;
const FREE_NEXT_OFFSET = 1;

type BlockNumber = bigint;

export class FreeBlockFile {
  private file: File;
  private blockSize: number;
  private atomicFile: new AtomicFile;
  
  private dirtyBlocks: Map<BlockNumber, Buffer> = new Map();
  
  private rootBlock: BlockNumber = 0n;
  private firstfreeBlock: BlockNumber = 0n;
  private isOpen = false;

  constructor(file: File, blockSize: number) {
    if (!Number.isInteger(blockSize) || blockSize <= 0) {
      throw new Error(`Invalid block size: ${blockSize}`);
    }
    if (blockSize <= HEADER_CLIENT_AREA_OFFSET) {
      throw new Error(
        `Block size must be > ${HEADER_CLIENT_AREA_OFFSET} to fit header`
      );
    }

    this.file = file;
    this.blockSize = blockSize;
  }


  /**
   * Create a new file and initialize header (block 0).
   * The header block is written with both the root block and first free
   * block pointers set to 0. This marks the file as newly initialized.
   * @returns {Promise<void>}
   * @author Arthur Cukier, Alec Van Vlerken
   */
  async create(){
    await this.file.create();

    const wasOpen = this.isOpen;
    if (!wasOpen) {
      await this.file.open();
      this.isOpen = true;
    }

    const header = Buffer.alloc(this.blockSize);
    header.writeUInt8(BlockType.Header, HEADER_TYPE_OFFSET);
    header.writeBigUInt64LE(0n, HEADER_FIRST_FREE_OFFSET);
    header.writeBigUInt64LE(0n, HEADER_ROOT_OFFSET);
    
    // client area is zeroed by Buffer.alloc

    // Stage and commit header through atomicFile
    this.dirtyBlocks.set(0n, header);
    await this.commit();

    if (!wasOpen) {
      await this.file.close();
      this.isOpen = false;
    }
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


  // ---------- helpers ------------
  private ensureOpen(): void {
    if (!this.isOpen) throw new Error('File not open');
  }

  private toBlockNum(n: number | bigint): bigint {
    return typeof n === "bigint" ? n : BigInt(n);
  }

  private offsetOf(blockNum: BlockNumber): number {
    if (blockNum < 0n) {
      throw new Error(`Negative block number: ${blockNum.toString()}`);
    }

    const maxBlock = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / this.blockSize));
    if (blockNum > maxBlock) {
      throw new Error(
        `Block number ${blockNum.toString()} too large for safe offset calculation`
      );
    }

    return Number(blockNum) * this.blockSize;
  }

  /**
   * Returns the total number of blocks in the file.
   *
   * @returns {Promise<BlockNumber>} Total number of blocks in the file.
   * @throws {Error} If the file is not open.
   * @author Arthur Cukier, Alec Van Vlerken
   */
  async getBlockCount(): Promise<BlockNumber> {
    this.ensureOpen();
    const stats = await this.file.stat();
    const blocks = Math.floor(stats.size / this.blockSize);
    return BigInt(blocks);
  }

  private async validateBlockNumber(blockNum: BlockNumber): Promise<void> {
    const blockCount = await this.getBlockCount();
    if (blockNum < 0n || blockNum >= blockCount) {
      throw new Error(
        `Invalid block number ${blockNum.toString()} (block count = ${blockCount.toString()})`
      );
    }
  }

  private async getHeader(): Promise<Buffer> {
    this.ensureOpen();

    let header = this.dirtyBlocks.get(0n);
    if (!header) {
      header = await this.readBlock(0n);
      this.dirtyBlocks.set(0n, header);
    }

    const type = header.readUInt8(HEADER_TYPE_OFFSET);
    if (type !== BlockType.Header) {
      throw new Error(
        `Corrupt header: expected BlockType.Header (${BlockType.Header}), found ${type}`
      );
    }

    return header;
  }

  private getBlockType(buf: Buffer): BlockType {
    return buf.readUInt8(0);
  }

  /**
   * (types should then be added to all writes and such)
   */
  private setBlockType(buf: Buffer, type: BlockType): void {
    if (type !== BlockType.Free &&
        type !== BlockType.Header &&
        type !== BlockType.Data) {
        throw new Error(`Invalid block type: ${type}`);
    }
    buf.writeUInt8(type, 0);
  }
  

  // -------------------------------------------

  /**
   * Reads a single block of data from the file at the specified block number.
   *
   * Each block has a fixed size defined by 'this.blockSize'. The function
   * calculates the byte offset of the block in the file, reads exactly
   * 'blockSize' bytes into a buffer, and returns it.
   *
   * @param {number | bigint} blockNumber - The index of the block to read (0-based).
   * @returns {Promise<Buffer>} A promise that resolves with a Buffer
   * containing the block data. The buffer is always 'blockSize' bytes long.
   *
   * @author Alec Van Vlerken
   */
  async readBlock(blockNumber: number | bigint): Promise<Buffer> {
    const bn = this.toBlockNum(blockNumber);

    this.ensureOpen();
    await this.validateBlockNumber(bn);

    const cached = this.dirtyBlocks.get(bn);
    if (cached !== undefined) {
      return cached;
    }

    const offset = this.offsetOf(bn);
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
   * @param {number | bigint} blockNumber - The index of the block to write (0-based).
   * @param {Buffer} data - A buffer containing the data to write. Must not exceed 'blockSize' bytes.
   * @returns {Promise<void>} A promise that resolves once the write operation is complete.
   *
   * @throws {Error} If the data length exceeds 'blockSize'.
   *
   * @author Alec Van Vlerken
   */
  async writeBlock(blockNumber: number | bigint, data: Buffer): Promise<void> {
    const bn = this.toBlockNum(blockNumber);

    this.ensureOpen();

    if (data.length > this.blockSize) {
      throw new Error(`Block too large (${data.length})`);
    }

    const buffer = Buffer.alloc(this.blockSize);
    data.copy(buffer, 0, 0, data.length);
    this.dirtyBlocks.set(bn, buffer);
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
    const header = await this.getHeader();
    return Buffer.from(header.subarray(HEADER_CLIENT_AREA_OFFSET));
  }

  /**
   * (implement this further that only certain bytes can be changed)
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
    if (buffer.length > this.blockSize - HEADER_CLIENT_AREA_OFFSET) {
      throw new Error('Client area buffer exceeds available header space');
    }

    const header = await this.getHeader();
    buffer.copy(header, HEADER_CLIENT_AREA_OFFSET);
    this.dirtyBlocks.set(0n, header);
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
    this.ensureOpen();

    // Assuming atomicWrite() has a list as input
    const writeOps: Array<{ offset: number; data: Buffer }> = [];

    for (const [blockNum, buffer] of this.dirtyBlocks.entries()) {
      const offset = this.offsetOf(blockNum);
      writeOps.push({
        offset,
        data: buffer,
      });
    }

    await this.atomicFile.atomicWrite(writeOps);

    await this.file.sync();

    this.dirtyBlocks.clear();
  }

  /**
   * Retrieves the current root block number.
   *
   * If block 0 (the header) is dirty in memory, reads the root
   * directly from the in-memory buffer. Otherwise, reads it from disk.
   *
   * @returns {Promise<BlockNumber>} The most recent root block number.
   * @throws {Error} If the file is not open.
   * @author Arthur Cukier, Alec Van Vlerken
   */
  async getRootBlock(): Promise<BlockNumber> {
    const header = await this.getHeader();
    const root = header.readBigUInt64LE(HEADER_ROOT_OFFSET);
    this.rootBlock = root;
    return root;
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
   * @param {BlockNumber} blockNum - The new root block number.
   * @returns {Promise<void>}
   * @throws {Error} If the file is not open.
   * @author Arthur Cukier, Alec Van Vlerken
   */
  async setRootBlock(blockNum: BlockNumber): Promise<void> {
    this.ensureOpen();
    await this.validateBlockNumber(blockNum);

    const header = await this.getHeader();
    header.writeBigUInt64LE(blockNum, HEADER_ROOT_OFFSET);
    this.dirtyBlocks.set(0n, header);
    this.rootBlock = blockNum;
  }

  /**
   * Reads the first free block pointer from block 0 (bytes 8–15).
   * @returns {Promise<BlockNumber>} The block number of the first free block or 0 if there are no free blocks.
   * @throws {Error} If the file is not open.
   * @author Arthur Cukier, Alec Van Vlerken
   */
  async getFirstFreeBlock(): Promise<BlockNumber> {
    const header = await this.getHeader();
    const firstFree = header.readBigUInt64LE(HEADER_FIRST_FREE_OFFSET);
    this.firstfreeBlock = firstFree;
    return firstFree;
  }

  /**
   * Updates the first free block pointer in block 0 (bytes 8–15),
   * keeping the rootBlock value (bytes 0–7) intact.
   *
   * @param {number | bigint} blockNum - The block number to set as the first free block (0 = none).
   * @returns {Promise<void>}
   * @throws {Error} If the file is not open.
   * @author Arthur Cukier
   */
  async setFirstFreeBlock(blockNum: number | bigint): Promise<void> {
    const bn = this.toBlockNum(blockNum);

    this.ensureOpen();
    if (bn !== 0n) {
        await this.validateBlockNumber(bn);
    }

    const header = await this.getHeader();
    header.writeBigUInt64LE(bn, HEADER_FIRST_FREE_OFFSET);
    this.dirtyBlocks.set(0n, header);
    this.firstfreeBlock = bn;
  }


    /**
     * Counts how many blocks are currently marked as free.
     *
     * @returns {Promise<bigint>} The number of free blocks found.
     * @throws {Error} If the file is not open.
     * @author Arthur Cukier, Alec Van Vlerken
     */
    async getFreeBlockCount(): Promise<bigint> {
      this.ensureOpen();

      const blockCount = await this.getBlockCount();
      let count = 0n;
      let current = await this.getFirstFreeBlock();

      while (current !== 0n) {
        if (current >= blockCount) {
          throw new Error(
            `Corrupt free list: free block ${current.toString()} >= block count ${blockCount.toString()}`
          );
        }

      const buf = await this.readBlock(current);
      const type = this.getBlockType(buf);
      if (type !== BlockType.Free) {
        throw new Error(
          `Corrupt free list: block ${current.toString()} has type ${type}, expected Free`
        );
      }

      count++;
      const next = buf.readBigUInt64LE(FREE_NEXT_OFFSET);
      if (next === current) {
        throw new Error(
          `Corrupt free list: self-referential free block at ${current.toString()}`
        );
      }
      current = next;
    }

      return count;
    }

  private async allocateNewBlock(): Promise<BlockNumber> {
    const blockCount = await this.getBlockCount();
    const newBlockNum = blockCount;

    const buf = Buffer.alloc(this.blockSize);
    this.setBlockType(buf, BlockType.Data);

    this.dirtyBlocks.set(newBlockNum, buf);
    return newBlockNum;
  }

  /**
  * Allocates a block by removing it from the head of the free list.
  * Works against the dirty header if present; no direct disk writes.
  * @returns {Promise<bigint>}
  * @throws {Error} If the file is not open or the free list is empty.
  * @author Arthur Cukier, Alec Van Vlerken
  */
  async allocateBlock(): Promise<bigint> {
    this.ensureOpen();

    const head = await this.getFirstFreeBlock();
    if (head === 0n) {
      this.allocateNewBlock();
    }

    await this.validateBlockNumber(head);

    let headBuf = this.dirtyBlocks.get(head);
    if (!headBuf) {
      headBuf = await this.readBlock(head);
    }

    const type = this.getBlockType(headBuf);
    if (type !== BlockType.Free) {
      throw new Error(
        `Corrupt free list: expected free block at ${head.toString()}, found type ${type}`
      );
    }

    const nextFree = headBuf.readBigUInt64LE(FREE_NEXT_OFFSET);

    this.setBlockType(headBuf, BlockType.Data);
    this.dirtyBlocks.set(head, headBuf);

    await this.setFirstFreeBlock(nextFree);
    return head;
  }

  /**
   * Frees a block by inserting it at the head of the free list.
   * Writes only to the dirty cache; no direct disk writes.
   * @returns {Promise<void>}
   * @throws {Error} If the file is not open or if blockNumber is 0.
   * @author Arthur Cukier, Alec Van Vlerken
   */
  async freeBlock(blockNumber: number | bigint): Promise<void> {
    const bn = this.toBlockNum(blockNumber);
    this.ensureOpen();
    if (bn === 0n) throw new Error('Cannot free block 0');

    await this.validateBlockNumber(bn);

    const currentHead = await this.getFirstFreeBlock();

    let buf = this.dirtyBlocks.get(bn);
    if (!buf) {
      buf = await this.readBlock(bn);
    }

    const type = this.getBlockType(buf);
    if (type === BlockType.Free) {
      throw new Error(
        `Double free detected for block ${blockNumber.toString()}`
      );
    }

    this.setBlockType(buf, BlockType.Free);
    buf.writeBigUInt64LE(currentHead, FREE_NEXT_OFFSET);
    this.dirtyBlocks.set(bn, buf);
    await this.setFirstFreeBlock(bn);
  }


}
