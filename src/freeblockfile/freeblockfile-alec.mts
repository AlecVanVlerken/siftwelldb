import fs from 'fs/promises';
import { AtomicFile } from 'wait implementation';

export class FreeBlockFile {
  private fileHandle!: fs.FileHandle;
  private blockSize: number;
  private dirtyBlocks: Map<number, Buffer>;

  constructor(blockSize: number) {
    this.blockSize = blockSize;
    this.atomicFile = new AtomicFile();
    this.dirtyBlocks = new Map();
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
    if (this.dirtyBlocks.has(blockNumber)) {
      return this.dirtyBlocks.get(blockNumber)!;
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
    await Promise.resolve(); // For consistency

    if (data.length > this.blockSize) throw new Error('Block too large');
    //const offset = blockNumber * this.blockSize;
    const buffer = Buffer.alloc(this.blockSize);
    data.copy(buffer);
    // await this.fileHandle.write(buffer, 0, this.blockSize, offset);
    this.dirtyBlocks.set(blockNumber, buffer);
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
    await this.writeBlock(0, buffer);
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
    if (this.dirtyBlocks.size === 0) {
      return;
    }

    // Assuming atomicWrite() has a list as input
    const writeOps: Array<{ offset: number; data: Buffer }> = [];
    for (const [blockNumber, buffer] of this.dirtyBlocks.entries()) {
      const offset = blockNumber * this.blockSize;
      writeOps.push({ offset, data: buffer });
    }

    await this.atomicFile.atomicWrite(writeOps);

    await this.fileHandle.sync();

    this.dirtyBlocks.clear();
  }
}
