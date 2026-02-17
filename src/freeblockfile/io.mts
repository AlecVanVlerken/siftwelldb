// @author: Alec Van Vlerken, Arthur Cukier
// @date: 2025-12-03

/**
 * io.mts
 * -------------------------
 * This module contains the low-level block I/O helpers used by FreeBlockFile.
 *
 * The functions here provide:
 *   • reading and writing full blocks,
 *   • safe computation of byte offsets,
 *   • block count computation,
 *   • validation of block numbers,
 *   • reading/writing block type bytes.
 */

import { FreeBlockFile } from './freeblockfile.mjs';
import { BlockType } from './layout.mjs';

/**
 * Reads a block from disk or from the dirty cache.
 */
export async function readBlock(fbf: FreeBlockFile, blockNumber: number): Promise<Buffer> {
  fbf._ensureOpen();

  if (blockNumber === 0) {
    throw new Error(
      'Direct reads from the header block are not allowed. Use getClientArea(), getRootBlock() or getFirstFreeBlock().',
    );
  }

  const cached = fbf._getDirtyBlock(blockNumber);
  if (cached !== undefined) {
    return Buffer.from(cached);
  }

  await validateBlockNumber(fbf, blockNumber);

  const offset = offsetOf(fbf, blockNumber);
  const buffer = Buffer.alloc(fbf._getBlockSize());
  await fbf._getFile().read(buffer, { position: offset });
  return buffer;
}

/**
 * Writes a full Data block into the dirty cache.
 */
export async function writeBlock(fbf: FreeBlockFile, blockNumber: number, data: Buffer): Promise<void> {
  fbf._ensureOpen();
  await validateBlockNumber(fbf, blockNumber);

  if (data.length > fbf._getBlockSize() - 1) {
    throw new Error(`Block too large (${data.length})`);
  }
  if (blockNumber === 0) {
    throw new Error('Direct writes to the header block are not allowed. Use writeClientArea().');
  }

  let buffer = fbf._getDirtyBlock(blockNumber);
  if (!buffer) buffer = await readBlock(fbf, blockNumber);

  const type = buffer.readUInt8(0) as BlockType;
  if (type !== BlockType.Data) {
    throw new Error(`writeBlock() allowed only for Data blocks; found type ${type}`);
  }

  buffer.fill(0, 1);
  data.copy(buffer, 1);
  fbf._setDirtyBlock(blockNumber, buffer);
}

/**
 * Computes the byte offset in the file for a given block number.
 *
 * @param {number} blockNum - Block number.
 * @param {FreeBlockFile} fbf - The FreeBlockFile instance.
 * @returns {number} Byte offset in the file.
 *
 * @throws {Error} If the block number is negative.
 * @throws {Error} If the block number is too large to compute a safe offset.
 *
 * @author Alec Van Vlerken, Arthur Cukier
 */
export function offsetOf(fbf: FreeBlockFile, blockNum: number): number {
  if (blockNum < 0) {
    throw new Error(`Negative block number: ${blockNum.toString()}`);
  }

  const maxBlock = Math.floor(Number.MAX_SAFE_INTEGER / fbf._getBlockSize());
  if (blockNum > maxBlock) {
    throw new Error(`Block number ${blockNum.toString()} too large for safe offset calculation`);
  }

  return blockNum * fbf._getBlockSize();
}

/**
 * Returns the total number of blocks currently stored in the file.
 *
 * @param {FreeBlockFile} fbf - The FreeBlockFile instance.
 * @returns {Promise<number>} Total number of blocks in the file.
 * @throws {Error} If the file is not open.
 * @throws {Error} If the file size is not a multiple of the block size (corrupted file).
 *
 * @author Arthur Cukier, Alec Van Vlerken
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function getBlockCount(fbf: FreeBlockFile): Promise<number> {
  fbf._ensureOpen();
  // Use cached block count instead of calling stat() every time
  const physicalBlocks = fbf._getCachedBlockCount();
  const blocks = Math.max(physicalBlocks, getHighestDirtyBlock(fbf) + 1);
  return blocks;
}

/**
 * Returns the highest block number currently present in the dirty block set.
 *
 * This is used to determine the logical file size when uncommitted writes
 * extend the file beyond its on-disk length.
 *
 * @param {FreeBlockFile} fbf - The FreeBlockFile instance.
 * @returns {number} The largest dirty block index, or -1 if none exist.
 *
 * @throws {Error} Never throws; relies on internal invariants.
 *
 * @author Alec Van Vlerken
 */
function getHighestDirtyBlock(fbf: FreeBlockFile): number {
  return fbf._getHighestDirtyBlock();
}

/**
 * Validates that a block number lies within the current file boundaries.
 *
 * @param {number} blockNum Block number to validate.
 * @param {FreeBlockFile} fbf - The FreeBlockFile instance.
 *
 * @throws {Error} If the block number is outside the valid range.
 *
 * @author Alec Van Vlerken
 */
export async function validateBlockNumber(fbf: FreeBlockFile, blockNum: number): Promise<void> {
  const blockCount = await getBlockCount(fbf);
  if (blockNum < 0 || blockNum >= blockCount) {
    throw new Error(`Invalid block number ${blockNum.toString()} (block count = ${blockCount.toString()})`);
  }
}

/**
 * Reads the block type from a block buffer.
 *
 * @param {Buffer} buf Block buffer.
 * @param {FreeBlockFile} fbf - The FreeBlockFile instance.
 * @returns {BlockType} The stored block type.
 *
 * @author Alec Van Vlerken
 */
export function getBlockType(buf: Buffer): BlockType {
  return buf.readUInt8(0);
}

/**
 * Writes a block type into a block buffer.
 *
 * @param {Buffer} buf - Target block buffer.
 * @param {BlockType} type - Block type to write.
 *
 * @throws {Error} If the type is invalid.
 *
 * @author Alec Van Vlerken
 */
export function setBlockType(buf: Buffer, type: BlockType): void {
  if (type !== BlockType.Free && type !== BlockType.Header && type !== BlockType.Data) {
    throw new Error(`Invalid block type: ${Number(type)}`);
  }
  buf.writeUInt8(type, 0);
}
