/**
 * commit.mts
 * -------------------------
 * This module implements the commit logic for FreeBlockFile.
 *
 * FreeBlockFile accumulates pending changes in an in-memory dirty block map.
 * The commit() function:
 *   • checks if there is anything to write,
 *   • performs a WAL-protected atomic write via AtomicFile,
 *   • fsyncs the underlying file,
 *   • clears the dirty-block cache.
 */

import { FreeBlockFile } from './freeblockfile.mjs';

/**
 * Atomically persists all staged block modifications.
 */
export async function commit(fbf: FreeBlockFile): Promise<void> {
  const dirty = fbf._getDirtyBlocks();
  if (dirty.size === 0) return;
  fbf._ensureOpen();

  const updates = new Map<number, Buffer>();
  const blockSize = fbf._getBlockSize();

  for (const [blockNum, buf] of dirty.entries()) {
    const position = blockNum * blockSize;
    updates.set(position, buf);
  }

  const ok = await fbf._getFile().atomicWrite(updates);
  if (!ok) throw new Error('Atomic write failed; database not updated');

  await fbf._getFile().sync();
  fbf._clearDirty();
}
