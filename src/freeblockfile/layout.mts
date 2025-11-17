/**
 * layout.mts
 * -------------------------
 * This module defines all structural constants for the block layout used by
 * FreeBlockFile. It includes the block type enum and all byte offsets for
 * the header block and free blocks.
 */

/**
 * BlockType
 * ----------
 * Identifies the logical meaning of a block:
 *
 *   • Free   — A block on the free list, available for allocation.
 *   • Header — Block 0; stores metadata such as root pointer and free-list head.
 *   • Data   — A block containing user or database data.
 */
export const enum BlockType {
  Free = 0x00,
  Header = 0x01,
  Data = 0x02,
}

/**
 * Header block (block 0) layout:
 *
 *   byte 0        → BlockType.Header
 *   bytes 1–4     → first free block pointer (uint32 LE)
 *   bytes 5–8     → root block pointer (uint32 LE)
 *   bytes 9–...   → client metadata area
 */
export const HEADER_TYPE_OFFSET = 0;
export const HEADER_FIRST_FREE_OFFSET = 1;
export const HEADER_ROOT_OFFSET = 5;
export const HEADER_CLIENT_AREA_OFFSET = 9;

/**
 * Free block layout:
 *
 *   byte 0        → BlockType.Free
 *   bytes 1–4     → next free block pointer (uint32 LE)
 *   bytes 5–...   → unused
 */
export const FREE_TYPE_OFFSET = 0;
export const FREE_NEXT_OFFSET = 1;
