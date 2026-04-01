// @author: Alec Van Vlerken, Arthur Cukier
// @date: 2025-12-03

/**
 * freelist.mts
 * -------------------------
 * This module implements the free-list logic of FreeBlockFile.
 *
 * The free-list is a singly linked list of blocks that are currently unused.
 * Each free block stores:
 *   byte 0      → BlockType.Free
 *   bytes 1–4   → next free block pointer (u32 LE)
 *
 * This module provides:
 *   • allocateBlock()  — obtain a reusable Data block
 *   • freeBlock()      — mark a block as Free and push it into the list
 *   • getFreeBlockCount() — iterate/debug the list
 *
 * Additionally, internal helpers exist:
 *   • getFirstFreeBlock() / setFirstFreeBlock()
 *   • allocateNewBlock()
 *
 * All operations only stage modifications in the FreeBlockFile’s
 * dirty-block cache. Disk persistence happens separately via commit().
 */

import { FreeBlockFile } from './freeblockfile.mjs';
import { getHeader } from './header.mjs';
import { validateBlockNumber, setBlockType, getBlockType, getBlockCount } from './io.mjs';
import * as layout from './layout.mjs';

/**
 * Returns the first free block pointer from the header.
 *
 * @param {FreeBlockFile} fbf - The FreeBlockFile instance.
 * @returns {Promise<number>} First free block or 0 if none exist.
 *
 * @throws {Error} If the file is not open.
 *
 * @author Arthur Cukier, Alec Van Vlerken
 */
async function getFirstFreeBlock(fbf: FreeBlockFile): Promise<number> {
  const header = await getHeader(fbf);
  const firstFree = header.readUInt32LE(layout.HEADER_FIRST_FREE_OFFSET);
  return firstFree;
}

/**
 * Updates the first free block pointer in the header.
 *
 * @param {number} blockNum New head of the free list (0 = none).
 * @param {FreeBlockFile} fbf - The FreeBlockFile instance.
 * @returns {Promise<void>}
 *
 * @throws {Error} If the file is not open.
 * @throws {Error} If the block number is invalid.
 *
 * @author Arthur Cukier
 */
async function setFirstFreeBlock(fbf: FreeBlockFile, blockNum: number): Promise<void> {
  fbf._ensureOpen();
  if (blockNum !== 0) {
    validateBlockNumber(fbf, blockNum);
  }

  const header = await getHeader(fbf);
  header.writeUInt32LE(blockNum, layout.HEADER_FIRST_FREE_OFFSET);
  fbf._setDirtyBlock(0, header);
}

/**
 * Allocates a brand-new data block at the end of the file.
 *
 * The block is initialized with BlockType.Data and staged
 * in the dirty cache.
 *
 * @param {FreeBlockFile} fbf - The FreeBlockFile instance.
 * @returns {Promise<number>} Newly allocated block number.
 *
 * @throws {Error} If the file is not open.
 *
 * @author Alec Van Vlerken
 */
async function allocateNewBlock(fbf: FreeBlockFile): Promise<number> {
  const blockCount = getBlockCount(fbf);
  const newBlockNum = blockCount;

  const buf = Buffer.alloc(fbf._getBlockSize());
  setBlockType(buf, layout.BlockType.Data);

  fbf._setDirtyBlock(newBlockNum, buf);
  return newBlockNum;
}

/**
 * Allocates a block for use as a Data block.
 *
 * If free list is nonempty, reuses its head.
 * Otherwise allocates a new block at the end of the file.
 */
export async function allocateBlock(fbf: FreeBlockFile): Promise<number> {
  fbf._ensureOpen();

  const head = await getFirstFreeBlock(fbf);
  if (head === 0) {
    return await allocateNewBlock(fbf);
  }

  validateBlockNumber(fbf, head);

  let headBuf = fbf._getDirtyBlock(head);
  if (!headBuf) {
    headBuf = await fbf.readBlock(head);
  }

  const type = getBlockType(headBuf);
  if (type !== layout.BlockType.Free) {
    throw new Error(`Corrupt free list: expected free block at ${head.toString()}, found type ${type}`);
  }

  const nextFree = headBuf.readUInt32LE(layout.FREE_NEXT_OFFSET);

  setBlockType(headBuf, layout.BlockType.Data);
  fbf._setDirtyBlock(head, headBuf);

  await setFirstFreeBlock(fbf, nextFree);
  return head;
}

/**
 * Frees a Data block and adds it to the free-list.
 */
export async function freeBlock(fbf: FreeBlockFile, blockNumber: number): Promise<void> {
  fbf._ensureOpen();
  if (blockNumber === 0) throw new Error('Cannot free block 0');

  validateBlockNumber(fbf, blockNumber);

  const currentHead = await getFirstFreeBlock(fbf);

  let buf = fbf._getDirtyBlock(blockNumber);
  if (!buf) {
    buf = await fbf.readBlock(blockNumber);
  }

  const type = getBlockType(buf);
  if (type === layout.BlockType.Free) {
    throw new Error(`Double free detected for block ${blockNumber.toString()}`);
  }
  if (type !== layout.BlockType.Data) {
    throw new Error(`Cannot free non-data block ${blockNumber.toString()} (type = ${type})`);
  }

  setBlockType(buf, layout.BlockType.Free);
  buf.writeUInt32LE(currentHead, layout.FREE_NEXT_OFFSET);
  fbf._setDirtyBlock(blockNumber, buf);
  await setFirstFreeBlock(fbf, blockNumber);
}

/**
 * Counts all blocks in the free-list.
 * Performs corruption checks to detect: cycles, out-of-range pointers and incorrect block types
 */
export async function getFreeBlockCount(fbf: FreeBlockFile): Promise<number> {
  fbf._ensureOpen();

  const blockCount = getBlockCount(fbf);
  let count = 0;
  let current = await getFirstFreeBlock(fbf);
  let steps = 0;

  while (current !== 0) {
    if (steps++ >= blockCount) {
      throw new Error('Corrupt free list: cycle detected');
    }
    if (current >= blockCount) {
      throw new Error(`Corrupt free list: free block ${current.toString()} >= block count ${blockCount.toString()}`);
    }

    const buf = await fbf.readBlock(current);
    const type = getBlockType(buf);
    if (type !== layout.BlockType.Free) {
      throw new Error(`Corrupt free list: block ${current.toString()} has type ${type}, expected Free`);
    }

    count++;
    const next = buf.readUInt32LE(layout.FREE_NEXT_OFFSET);
    if (next === current) {
      throw new Error(`Corrupt free list: self-referential free block at ${current.toString()}`);
    }
    current = next;
  }

  return count;
}
