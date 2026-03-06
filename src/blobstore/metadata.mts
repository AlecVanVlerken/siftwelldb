// blobstore/metadata.ts

import type { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import {
  UINT32_MAX,
  VERSION,
  META_BLOCK_MARKER,
  META_ROOT_KIND,
  META_TABLE_KIND,
  ROOT_HEADER_SIZE,
  ROOT_MARKER_OFFSET,
  ROOT_KIND_OFFSET,
  ROOT_VERSION_OFFSET,
  ROOT_NEXT_BLOB_ID_OFFSET,
  ROOT_TABLE_HEAD_OFFSET,
  ROOT_TABLE_TAIL_OFFSET,
  TABLE_MARKER_OFFSET,
  TABLE_KIND_OFFSET,
  TABLE_NEXT_BLOCK_OFFSET,
  TABLE_USED_BYTES_OFFSET,
  TABLE_HEADER_SIZE,
  META_OP_UPSERT,
  META_OP_DELETE,
} from './format.mjs';
import { CorruptBlobChain } from './types.mjs';

export type BlobMetadataRecord = {
  sizeBytes: number;
  headBlockId: number;
  tailBlockId: number;
  mimeType?: string;
};

export type BlobStoreRoot = {
  version: number;
  nextBlobId: number;
  metaHeadBlockId: number;
  metaTailBlockId: number;
};

export function assertRootHeader(data: Buffer): void {
  if (data.length < ROOT_HEADER_SIZE) throw new CorruptBlobChain('Metadata root block is too small');
  if (data.readUInt8(ROOT_MARKER_OFFSET) !== META_BLOCK_MARKER) throw new CorruptBlobChain('Metadata root marker mismatch');
  if (data.readUInt8(ROOT_KIND_OFFSET) !== META_ROOT_KIND) throw new CorruptBlobChain('Metadata root kind mismatch');
  if (data.readUInt8(ROOT_VERSION_OFFSET) !== VERSION) throw new CorruptBlobChain('Unsupported BlobStore metadata version');
}

export async function readMetaRootBlock(fbf: FreeBlockFile, metaBlockId: number): Promise<BlobStoreRoot> {
  const raw = await fbf.readBlock(metaBlockId);
  const data = raw.subarray(1);
  assertRootHeader(data);

  return {
    version: data.readUInt8(ROOT_VERSION_OFFSET),
    nextBlobId: data.readUInt32BE(ROOT_NEXT_BLOB_ID_OFFSET),
    metaHeadBlockId: data.readUInt32BE(ROOT_TABLE_HEAD_OFFSET),
    metaTailBlockId: data.readUInt32BE(ROOT_TABLE_TAIL_OFFSET),
  };
}

export async function writeMetaRootBlock(
  fbf: FreeBlockFile,
  metaBlockId: number,
  blockDataSize: number,
  root: { nextBlobId: number; metaHeadBlockId: number; metaTailBlockId: number },
): Promise<void> {
  const data = Buffer.alloc(blockDataSize);
  data.writeUInt8(META_BLOCK_MARKER, ROOT_MARKER_OFFSET);
  data.writeUInt8(META_ROOT_KIND, ROOT_KIND_OFFSET);
  data.writeUInt8(VERSION, ROOT_VERSION_OFFSET);
  data.writeUInt32BE(root.nextBlobId, ROOT_NEXT_BLOB_ID_OFFSET);
  data.writeUInt32BE(root.metaHeadBlockId, ROOT_TABLE_HEAD_OFFSET);
  data.writeUInt32BE(root.metaTailBlockId, ROOT_TABLE_TAIL_OFFSET);
  await fbf.writeBlock(metaBlockId, data);
}

export function createEmptyMetaTableBuffer(blockDataSize: number): Buffer {
  const data = Buffer.alloc(blockDataSize);
  data.writeUInt8(META_BLOCK_MARKER, TABLE_MARKER_OFFSET);
  data.writeUInt8(META_TABLE_KIND, TABLE_KIND_OFFSET);
  data.writeUInt32BE(0, TABLE_NEXT_BLOCK_OFFSET);
  data.writeUInt32BE(0, TABLE_USED_BYTES_OFFSET);
  return data;
}

export function assertMetaTableHeader(data: Buffer, blockId: number): void {
  if (data.readUInt8(TABLE_MARKER_OFFSET) !== META_BLOCK_MARKER) {
    throw new CorruptBlobChain(`Metadata table block ${blockId.toString()} marker mismatch`);
  }
  if (data.readUInt8(TABLE_KIND_OFFSET) !== META_TABLE_KIND) {
    throw new CorruptBlobChain(`Metadata table block ${blockId.toString()} kind mismatch`);
  }
}

export async function readMetaTableBlock(
  fbf: FreeBlockFile,
  blockId: number,
  blockDataSize: number,
): Promise<{ data: Buffer; nextBlockId: number; usedBytes: number }> {
  const raw = await fbf.readBlock(blockId);
  const data = Buffer.from(raw.subarray(1));
  assertMetaTableHeader(data, blockId);

  const nextBlockId = data.readUInt32BE(TABLE_NEXT_BLOCK_OFFSET);
  const usedBytes = data.readUInt32BE(TABLE_USED_BYTES_OFFSET);
  if (usedBytes > blockDataSize - TABLE_HEADER_SIZE) {
    throw new CorruptBlobChain(`Metadata table block ${blockId.toString()} has invalid used byte count`);
  }
  return { data, nextBlockId, usedBytes };
}

export async function writeMetaTableBlock(fbf: FreeBlockFile, blockId: number, data: Buffer): Promise<void> {
  assertMetaTableHeader(data, blockId);
  await fbf.writeBlock(blockId, data);
}

export function encodeUpsertMetadataEntry(blobId: number, metadata: BlobMetadataRecord): Buffer {
  const mimeBuffer = metadata.mimeType ? Buffer.from(metadata.mimeType, 'utf8') : Buffer.alloc(0);
  const hasMime = mimeBuffer.length > 0 ? 1 : 0;
  if (mimeBuffer.length > 0xffff) throw new Error('mimeType is too large to store');

  const entrySize = 1 + 4 + 8 + 4 + 4 + 1 + (hasMime ? 2 + mimeBuffer.length : 0);
  const entry = Buffer.alloc(entrySize);
  let offset = 0;

  entry.writeUInt8(META_OP_UPSERT, offset++);
  entry.writeUInt32BE(blobId, offset); offset += 4;
  entry.writeBigUInt64BE(BigInt(metadata.sizeBytes), offset); offset += 8;
  entry.writeUInt32BE(metadata.headBlockId, offset); offset += 4;
  entry.writeUInt32BE(metadata.tailBlockId, offset); offset += 4;
  entry.writeUInt8(hasMime, offset++);

  if (hasMime) {
    entry.writeUInt16BE(mimeBuffer.length, offset); offset += 2;
    mimeBuffer.copy(entry, offset);
  }

  return entry;
}

export function encodeDeleteMetadataEntry(blobId: number): Buffer {
  const entry = Buffer.alloc(1 + 4);
  entry.writeUInt8(META_OP_DELETE, 0);
  entry.writeUInt32BE(blobId, 1);
  return entry;
}

export function decodeMetadataEntriesIntoIndex(
  entriesData: Buffer,
  blobIndex: Map<number, BlobMetadataRecord>,
): void {
  let offset = 0;
  while (offset < entriesData.length) {
    const op = entriesData.readUInt8(offset++);
    if (op === META_OP_UPSERT) {
      if (offset + 4 + 8 + 4 + 4 + 1 > entriesData.length) throw new CorruptBlobChain('Incomplete upsert metadata entry');

      const blobId = entriesData.readUInt32BE(offset); offset += 4;
      const sizeBI = entriesData.readBigUInt64BE(offset); offset += 8;
      if (sizeBI > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new CorruptBlobChain(`uint64 value exceeds Number.MAX_SAFE_INTEGER: ${sizeBI.toString()}`);
      }
      const sizeBytes = Number(sizeBI);

      const headBlockId = entriesData.readUInt32BE(offset); offset += 4;
      const tailBlockId = entriesData.readUInt32BE(offset); offset += 4;
      const hasMime = entriesData.readUInt8(offset++);

      let mimeType: string | undefined;
      if (hasMime === 1) {
        if (offset + 2 > entriesData.length) throw new CorruptBlobChain('Incomplete upsert metadata entry mime length');
        const mimeLength = entriesData.readUInt16BE(offset); offset += 2;
        if (offset + mimeLength > entriesData.length) throw new CorruptBlobChain('Incomplete upsert metadata entry mime bytes');
        mimeType = entriesData.subarray(offset, offset + mimeLength).toString('utf8');
        offset += mimeLength;
      } else if (hasMime !== 0) {
        throw new CorruptBlobChain(`Invalid hasMime flag in metadata entry: ${hasMime.toString()}`);
      }

      blobIndex.set(blobId, { sizeBytes, headBlockId, tailBlockId, mimeType });
      continue;
    }

    if (op === META_OP_DELETE) {
      if (offset + 4 > entriesData.length) throw new CorruptBlobChain('Incomplete delete metadata entry');
      const blobId = entriesData.readUInt32BE(offset); offset += 4;
      blobIndex.delete(blobId);
      continue;
    }

    throw new CorruptBlobChain(`Unknown metadata op code: ${op.toString()}`);
  }
}

export async function loadMetadataIndex(
  fbf: FreeBlockFile,
  blockDataSize: number,
  metaHeadBlockId: number,
  blobIndex: Map<number, BlobMetadataRecord>,
): Promise<{ maxBlobId: number }> {
  blobIndex.clear();
  if (metaHeadBlockId === 0) return { maxBlobId: 0 };

  const visited = new Set<number>();
  let currentBlockId = metaHeadBlockId;

  while (currentBlockId !== 0) {
    if (visited.has(currentBlockId)) {
      throw new CorruptBlobChain(`Loop detected in metadata table chain at block ${currentBlockId.toString()}`);
    }
    visited.add(currentBlockId);

    const { data, nextBlockId, usedBytes } = await readMetaTableBlock(fbf, currentBlockId, blockDataSize);
    const entriesSlice = data.subarray(TABLE_HEADER_SIZE, TABLE_HEADER_SIZE + usedBytes);
    decodeMetadataEntriesIntoIndex(entriesSlice, blobIndex);
    currentBlockId = nextBlockId;
  }

  let maxBlobId = 0;
  for (const id of blobIndex.keys()) maxBlobId = Math.max(maxBlobId, id);
  return { maxBlobId };
}

export async function appendMetadataEntry(params: {
  fbf: FreeBlockFile;
  blockDataSize: number;
  entry: Buffer;
  maxMetaEntryBytes: number;
  metaHeadBlockId: number;
  metaTailBlockId: number;
}): Promise<{ metaHeadBlockId: number; metaTailBlockId: number }> {
  const { fbf, blockDataSize, entry, maxMetaEntryBytes } = params;
  let { metaHeadBlockId, metaTailBlockId } = params;

  if (entry.length > maxMetaEntryBytes) {
    throw new Error(`Metadata entry too large (${entry.length.toString()} bytes). Consider shorter mimeType strings.`);
  }

  if (metaTailBlockId === 0) {
    const firstTableBlockId = await fbf.allocateBlock();
    metaHeadBlockId = firstTableBlockId;
    metaTailBlockId = firstTableBlockId;
    await writeMetaTableBlock(fbf, firstTableBlockId, createEmptyMetaTableBuffer(blockDataSize));
  }

  const tail = await readMetaTableBlock(fbf, metaTailBlockId, blockDataSize);
  const freeBytes = blockDataSize - TABLE_HEADER_SIZE - tail.usedBytes;

  if (entry.length <= freeBytes) {
    entry.copy(tail.data, TABLE_HEADER_SIZE + tail.usedBytes);
    tail.data.writeUInt32BE(tail.usedBytes + entry.length, TABLE_USED_BYTES_OFFSET);
    await writeMetaTableBlock(fbf, metaTailBlockId, tail.data);
    return { metaHeadBlockId, metaTailBlockId };
  }

  const newTailBlockId = await fbf.allocateBlock();
  tail.data.writeUInt32BE(newTailBlockId, TABLE_NEXT_BLOCK_OFFSET);
  await writeMetaTableBlock(fbf, metaTailBlockId, tail.data);

  const newTailData = createEmptyMetaTableBuffer(blockDataSize);
  entry.copy(newTailData, TABLE_HEADER_SIZE);
  newTailData.writeUInt32BE(entry.length, TABLE_USED_BYTES_OFFSET);
  await writeMetaTableBlock(fbf, newTailBlockId, newTailData);

  metaTailBlockId = newTailBlockId;
  return { metaHeadBlockId, metaTailBlockId };
}

export function bumpNextBlobId(nextBlobId: number, maxBlobId: number): number {
  if (nextBlobId > maxBlobId) return nextBlobId;
  if (maxBlobId >= UINT32_MAX) throw new Error('Blob id space exhausted');
  return maxBlobId + 1;
}