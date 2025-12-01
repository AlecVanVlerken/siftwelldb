import { type AtomicFile } from '../atomic/atomicfile.mts';

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
  private file: AtomicFile;
  private blockSize: number;

  private dirtyBlocks: Map<BlockNumber, Buffer> = new Map();

  private rootBlock: BlockNumber = 0n;
  private firstfreeBlock: BlockNumber = 0n;
  private isOpen = false;

  /**
   * Creates a new FreeBlockFile instance controlling a block-structured file.
   *
   * This class manages a file divided into fixed-size blocks and maintains a
   * free-list for block allocation. Block 0 is reserved as a header block.
   *
   * @param {AtomicFileFile} file Low-level file abstraction used for physical disk access.
   * @param {number} blockSize Size (in bytes) of each block.
   *
   * @throws {Error} If blockSize is not a positive integer.
   * @throws {Error} If blockSize is too small to store the header layout.
   *
   * @author Arthur Cukier, Alec Van Vlerken
   */
  constructor(file: AtomicFile, blockSize: number) {
    if (!Number.isInteger(blockSize) || blockSize <= 0) {
      throw new Error(`Invalid block size: ${blockSize}`);
    }
    if (blockSize <= HEADER_CLIENT_AREA_OFFSET) {
      throw new Error(`Block size must be > ${HEADER_CLIENT_AREA_OFFSET} to fit header`);
    }

    this.file = file;
    this.blockSize = blockSize;
  }

  /**
   * Opens the underlying file and loads the header into memory on demand.
   *
   * @returns {Promise<void>}
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
   * Closes the underlying file.
   *
   * If the file is already closed, this method does nothing.
   *
   * @returns {Promise<void>}
   *
   * @author Arthur Cukier
   */
  async close() {
    if (!this.isOpen) return;
    await this.file.close();
    this.isOpen = false;
  }

  // ---------- helpers ------------
  /**
   * Ensures that the file is currently open.
   *
   * @throws {Error} If the file is not open.
   */
  private ensureOpen(): void {
    if (!this.isOpen) throw new Error('File not open');
  }

  /**
   * Converts a block number from number or bigint to bigint.
   *
   * @param {number | bigint} n - Block number.
   * @returns {bigint} Block number as bigint.
   */
  private toBlockNum(n: number | bigint): bigint {
    return typeof n === 'bigint' ? n : BigInt(n);
  }

  /**
   * Computes the byte offset in the file for a given block number.
   *
   * @param {BlockNumber} blockNum - Block number.
   * @returns {number} Byte offset in the file.
   *
   * @throws {Error} If the block number is negative.
   * @throws {Error} If the block number is too large to compute a safe offset.
   */
  private offsetOf(blockNum: BlockNumber): number {
    if (blockNum < 0n) {
      throw new Error(`Negative block number: ${blockNum.toString()}`);
    }

    const maxBlock = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / this.blockSize));
    if (blockNum > maxBlock) {
      throw new Error(`Block number ${blockNum.toString()} too large for safe offset calculation`);
    }

    return Number(blockNum) * this.blockSize;
  }

  /**
   * Returns the total number of blocks currently stored in the file.
   *
   * @returns {Promise<BlockNumber>} Total number of blocks in the file.
   * @throws {Error} If the file is not open.
   *
   * @author Arthur Cukier, Alec Van Vlerken
   */
  async getBlockCount(): Promise<BlockNumber> {
    this.ensureOpen();
    const stats = await this.file.stat();
    const blocks = Math.floor(stats.size / this.blockSize);
    return BigInt(blocks);
  }

  /**
   * Validates that a block number lies within the current file boundaries.
   *
   * @param {BlockNumber} blockNum Block number to validate.
   * @throws {Error} If the block number is outside the valid range.
   */
  private async validateBlockNumber(blockNum: BlockNumber): Promise<void> {
    const blockCount = await this.getBlockCount();
    if (blockNum < 0n || blockNum >= blockCount) {
      throw new Error(`Invalid block number ${blockNum.toString()} (block count = ${blockCount.toString()})`);
    }
  }

  /**
   * Retrieves the header block (block 0) from the dirty cache or disk.
   *
   *
   * @returns {Promise<Buffer>} The header block buffer.
   * @throws {Error} If the file is not open.
   * @throws {Error} If the header block is corrupted.
   */
  private async getHeader(): Promise<Buffer> {
    this.ensureOpen();

    let header = this.dirtyBlocks.get(0n);
    if (!header) {
      header = await this.readBlock(0n);
      this.dirtyBlocks.set(0n, header);
    }

    const type = header.readUInt8(HEADER_TYPE_OFFSET);
    if (type !== BlockType.Header) {
      throw new Error(`Corrupt header: expected BlockType.Header (${BlockType.Header}), found ${type}`);
    }

    return header;
  }

  /**
   * Reads the block type from a block buffer.
   *
   * @param {Buffer} buf Block buffer.
   * @returns {BlockType} The stored block type.
   */
  private getBlockType(buf: Buffer): BlockType {
    return buf.readUInt8(0);
  }

  /**
   * Writes a block type into a block buffer.
   *
   * @param {Buffer} buf Target block buffer.
   * @param {BlockType} type Block type to write.
   * @throws {Error} If the type is invalid.
   */
  private setBlockType(buf: Buffer, type: BlockType): void {
    if (type !== BlockType.Free && type !== BlockType.Header && type !== BlockType.Data) {
      throw new Error(`Invalid block type: ${type}`);
    }
    buf.writeUInt8(type, 0);
  }

  // -------------------------------------------

  /**
   * Reads a block from disk or from the dirty cache.
   *
   * @param {number | bigint} blockNumber Block index (0-based).
   * @returns {Promise<Buffer>} A buffer of size {@link blockSize}.
   *
   * @throws {Error} If the file is not open.
   * @throws {Error} If the block number is invalid.
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
   * Stages a full block for writing.
   *
   * The data is copied into an internal buffer and stored in the dirty cache.
   * The actual disk write occurs only after calling commit().
   *
   * @param {number | bigint} blockNumber Block index (0-based).
   * @param {Buffer} data Data to write into the block.
   *
   * @returns {Promise<void>}
   * @throws {Error} If the file is not open.
   * @throws {Error} If the data exceeds the block size.
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
    const header = await this.getHeader();
    return Buffer.from(header.subarray(HEADER_CLIENT_AREA_OFFSET));
  }

  /**
   * Writes data into the client metadata area of the header block.
   *
   * The header fields (block type, free list pointer, root pointer)
   * remain unchanged.
   *
   * @param {Buffer} buffer Client metadata to write.
   * @returns {Promise<void>}
   *
   * @throws {Error} If the buffer exceeds available client area space.
   * @throws {Error} If the file is not open.
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
   * @throws {Error} If the file is not open.
   * @author Alec Van Vlerken
   */
  async commit(): Promise<void> {
    if (this.dirtyBlocks.size === 0) return;
    this.ensureOpen();

    if (this.dirtyBlocks.size === 0) return;

    await this.file.atomicWrite(this.dirtyBlocks);
    await this.file.sync();
    this.dirtyBlocks.clear();
  }

  /**
   * Returns the current root block pointer stored in the header.
   *
   * @returns {Promise<BlockNumber>} Root block number.
   * @throws {Error} If the file is not open.
   *
   * @author Arthur Cukier, Alec Van Vlerken
   */
  async getRootBlock(): Promise<BlockNumber> {
    const header = await this.getHeader();
    const root = header.readBigUInt64LE(HEADER_ROOT_OFFSET);
    this.rootBlock = root;
    return root;
  }

  /**
   * Updates the root block pointer in the header.
   *
   * The change is staged in memory and persisted only after commit().
   *
   * @param {BlockNumber} blockNum - New root block number.
   * @returns {Promise<void>}
   *
   * @throws {Error} If the file is not open.
   * @throws {Error} If the block number is invalid.
   *
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
   * Returns the first free block pointer from the header.
   *
   * @returns {Promise<BlockNumber>} First free block or 0 if none exist.
   * @throws {Error} If the file is not open.
   *
   * @author Arthur Cukier, Alec Van Vlerken
   */
  async getFirstFreeBlock(): Promise<BlockNumber> {
    const header = await this.getHeader();
    const firstFree = header.readBigUInt64LE(HEADER_FIRST_FREE_OFFSET);
    this.firstfreeBlock = firstFree;
    return firstFree;
  }

  /**
   * Updates the first free block pointer in the header.
   *
   * @param {number | bigint} blockNum New head of the free list (0 = none).
   * @returns {Promise<void>}
   *
   * @throws {Error} If the file is not open.
   * @throws {Error} If the block number is invalid.
   *
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
   * Traverses the free list and counts the number of free blocks.
   *
   * Includes consistency checks for:
   *  - Out-of-range pointers
   *  - Invalid block types
   *  - Self-referential cycles
   *
   * @returns {Promise<bigint>} Number of free blocks.
   * @throws {Error} If the file is not open.
   * @throws {Error} If the free list is corrupted.
   *
   * @author Arthur Cukier, Alec Van Vlerken
   */
  async getFreeBlockCount(): Promise<bigint> {
    this.ensureOpen();

    const blockCount = await this.getBlockCount();
    let count = 0n;
    let current = await this.getFirstFreeBlock();

    while (current !== 0n) {
      if (current >= blockCount) {
        throw new Error(`Corrupt free list: free block ${current.toString()} >= block count ${blockCount.toString()}`);
      }

      const buf = await this.readBlock(current);
      const type = this.getBlockType(buf);
      if (type !== BlockType.Free) {
        throw new Error(`Corrupt free list: block ${current.toString()} has type ${type}, expected Free`);
      }

      count++;
      const next = buf.readBigUInt64LE(FREE_NEXT_OFFSET);
      if (next === current) {
        throw new Error(`Corrupt free list: self-referential free block at ${current.toString()}`);
      }
      current = next;
    }

    return count;
  }

  /**
   * Allocates a brand-new data block at the end of the file.
   *
   * The block is initialized with BlockType.Data and staged
   * in the dirty cache.
   *
   * @returns {Promise<BlockNumber>} Newly allocated block number.
   *
   * @throws {Error} If the file is not open.
   */
  private async allocateNewBlock(): Promise<BlockNumber> {
    const blockCount = await this.getBlockCount();
    const newBlockNum = blockCount;

    const buf = Buffer.alloc(this.blockSize);
    this.setBlockType(buf, BlockType.Data);

    this.dirtyBlocks.set(newBlockNum, buf);
    return newBlockNum;
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
   * @returns {Promise<BlockNumber>} Allocated block number.
   * @throws {Error} If the file is not open.
   * @throws {Error} If the free list is corrupted.
   *
   * @author Arthur Cukier, Alec Van Vlerken
   */
  async allocateBlock(): Promise<bigint> {
    this.ensureOpen();

    const head = await this.getFirstFreeBlock();
    if (head === 0n) {
      return this.allocateNewBlock();
    }

    await this.validateBlockNumber(head);

    let headBuf = this.dirtyBlocks.get(head);
    if (!headBuf) {
      headBuf = await this.readBlock(head);
    }

    const type = this.getBlockType(headBuf);
    if (type !== BlockType.Free) {
      throw new Error(`Corrupt free list: expected free block at ${head.toString()}, found type ${type}`);
    }

    const nextFree = headBuf.readBigUInt64LE(FREE_NEXT_OFFSET);

    this.setBlockType(headBuf, BlockType.Data);
    this.dirtyBlocks.set(head, headBuf);

    await this.setFirstFreeBlock(nextFree);
    return head;
  }

  /**
   * Frees a data block by prepending it to the free list.
   *
   * The block is marked as BlockType.Free and its next pointer
   * is set to the previous free list head. Changes are staged in memory
   * and persisted only after commit().
   *
   * @param {number | bigint} blockNumber Block to be released.
   * @returns {Promise<void>}
   *
   * @throws {Error} If the file is not open.
   * @throws {Error} If blockNumber is 0.
   * @throws {Error} If the block number is invalid.
   * @throws {Error} If a double-free is detected.
   *
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
      throw new Error(`Double free detected for block ${blockNumber.toString()}`);
    }

    this.setBlockType(buf, BlockType.Free);
    buf.writeBigUInt64LE(currentHead, FREE_NEXT_OFFSET);
    this.dirtyBlocks.set(bn, buf);
    await this.setFirstFreeBlock(bn);
  }
}
