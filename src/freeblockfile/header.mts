// @author: Alec Van Vlerken, Arthur Cukier
// @date: 2025-12-03

/**
 * header.mts
 * -------------------------
 * This module contains operations for reading and updating the header block.
 *
 * The header block (block 0) stores:
 *   • block type (Header)
 *   • the first-free pointer
 *   • the root pointer
 *   • the client metadata area
 */

import { FreeBlockFile } from './freeblockfile.mjs';
import * as layout from './layout.mjs';
import { offsetOf, validateBlockNumber, getBlockCount } from './io.mjs';

/**
 * Retrieves the header block (block 0) from the dirty cache or disk.
 *
 * @param {FreeBlockFile} fbf - The FreeBlockFile instance.
 * @returns {Promise<Buffer>} The header block buffer.
 *
 * @throws {Error} If the file is not open.
 * @throws {Error} If the header block is corrupted or contains invalid block pointers.
 *
 * @author Alec Van Vlerken
 */
export async function getHeader(fbf: FreeBlockFile): Promise<Buffer> {
  fbf._ensureOpen();

  let header = fbf._getDirtyBlock(0);
  if (!header) {
    const offset = offsetOf(fbf, 0);
    header = Buffer.alloc(fbf._getBlockSize());
    await fbf._getFile().read(header, { position: offset });

    fbf._setDirtyBlock(0, header);
  }

  const type = header.readUInt8(layout.HEADER_TYPE_OFFSET) as layout.BlockType;
  if (type !== layout.BlockType.Header) {
    throw new Error(`Corrupt header: expected ${layout.BlockType.Header}, got ${type}`);
  }

  const firstFree = header.readUInt32LE(layout.HEADER_FIRST_FREE_OFFSET);
  const root = header.readUInt32LE(layout.HEADER_ROOT_OFFSET);
  const blockCount = getBlockCount(fbf);

  if (firstFree >= blockCount) {
    throw new Error(`Corrupt header: firstFree=${firstFree} >= blockCount=${blockCount}`);
  }
  if (root >= blockCount) {
    throw new Error(`Corrupt header: root=${root} >= blockCount=${blockCount}`);
  }

  return header;
}

/**
 * Returns the client metadata area stored in the header.
 */
export async function getClientArea(fbf: FreeBlockFile): Promise<Buffer> {
  const header = await getHeader(fbf);
  return Buffer.from(header.subarray(layout.HEADER_CLIENT_AREA_OFFSET));
}

/**
 * Writes the client metadata area of the header.
 * The header's first-free pointer and root pointer are preserved.
 */
export async function writeClientArea(fbf: FreeBlockFile, buffer: Buffer): Promise<void> {
  if (buffer.length > fbf._getBlockSize() - layout.HEADER_CLIENT_AREA_OFFSET) {
    throw new Error('Client area buffer exceeds available header space');
  }

  const header = await getHeader(fbf);

  header.fill(0, layout.HEADER_CLIENT_AREA_OFFSET, fbf._getBlockSize());

  buffer.copy(header, layout.HEADER_CLIENT_AREA_OFFSET);
  fbf._setDirtyBlock(0, header);
}

/**
 * Returns the root block pointer from the header.
 */
export async function getRootBlock(fbf: FreeBlockFile): Promise<number> {
  const header = await getHeader(fbf);
  const root = header.readUInt32LE(layout.HEADER_ROOT_OFFSET);
  return root;
}

/**
 * Updates the stored root block pointer.
 */
export async function setRootBlock(fbf: FreeBlockFile, blockNum: number): Promise<void> {
  fbf._ensureOpen();
  validateBlockNumber(fbf, blockNum);

  const header = await getHeader(fbf);
  header.writeUInt32LE(blockNum, layout.HEADER_ROOT_OFFSET);
  fbf._setDirtyBlock(0, header);
}
