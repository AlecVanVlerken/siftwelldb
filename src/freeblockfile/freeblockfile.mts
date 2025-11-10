import fs from 'fs/promises';

export class FreeBlockFile {
  private fileHandle!: fs.FileHandle;
  private blockSize: number;
  constructor(blockSize: number) {
    this.blockSize = blockSize;
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
    if (data.length > this.blockSize) throw new Error('Block too large');
    const offset = blockNumber * this.blockSize;
    const buffer = Buffer.alloc(this.blockSize);
    data.copy(buffer);
    await this.fileHandle.write(buffer, 0, this.blockSize, offset);
  }
}
