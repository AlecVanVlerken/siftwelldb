import { type File } from '../core/file.mjs';
import { type AtomicFile } from 'wait implementation';

export class FreeBlockFile {
  private file: File;
  private blockSize: number;
  private dirtyBlocks: Map<number, Buffer> = new Map();
  private atomicFile: new AtomicFile;

  constructor(file: File, blockSize: number) {
    this.file = file;
    this.blockSize = blockSize;
  }

  async open() {
    await this.file.open();
  }

  async close() {
    await this.file.close();
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
}
