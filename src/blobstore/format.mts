export const UINT32_MAX = 0xffff_ffff;
export const VERSION = 1;

// Markers/kinds
export const META_BLOCK_MARKER = 0x4d; // 'M'
export const META_ROOT_KIND = 0x52; // 'R'
export const META_TABLE_KIND = 0x54; // 'T'
export const BLOB_BLOCK_MARKER = 0x42; // 'B'

// Root layout
export const ROOT_MARKER_OFFSET = 0;
export const ROOT_KIND_OFFSET = 1;
export const ROOT_VERSION_OFFSET = 2;
export const ROOT_NEXT_BLOB_ID_OFFSET = 3;
export const ROOT_TABLE_HEAD_OFFSET = 7;
export const ROOT_TABLE_TAIL_OFFSET = 11;
export const ROOT_HEADER_SIZE = 15;

// Table layout
export const TABLE_MARKER_OFFSET = 0;
export const TABLE_KIND_OFFSET = 1;
export const TABLE_NEXT_BLOCK_OFFSET = 2;
export const TABLE_USED_BYTES_OFFSET = 6;
export const TABLE_HEADER_SIZE = 10;

// Meta ops
export const META_OP_UPSERT = 0x01;
export const META_OP_DELETE = 0x02;

// Blob data block layout (inside "data region" == raw.subarray(1))
export const BLOB_MARKER_OFFSET = 0;
export const BLOB_NEXT_BLOCK_OFFSET = 1;
export const BLOB_PAYLOAD_LENGTH_OFFSET = 5;
export const BLOB_PAYLOAD_OFFSET = 9;

export const DEFAULT_STREAM_CHUNK_SIZE = 64 * 1024;

export function computeBlockDataSize(blockSize: number): number {
  // your FreeBlockFile reserves 1 byte in the physical block
  return blockSize - 1;
}