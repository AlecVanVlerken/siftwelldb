import type { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import {
  BLOB_BLOCK_MARKER,
  BLOB_MARKER_OFFSET,
  BLOB_NEXT_BLOCK_OFFSET,
  BLOB_PAYLOAD_LENGTH_OFFSET,
  BLOB_PAYLOAD_OFFSET,
  DEFAULT_STREAM_CHUNK_SIZE,
  UINT32_MAX,
  computeBlockDataSize,
  TABLE_HEADER_SIZE,
} from './format.mjs';
import { BlobNotFound, CorruptBlobChain, InvalidRange, type BlobInfo, type BlobRef } from './types.mjs';
import {
  type BlobMetadataRecord,
  readMetaRootBlock,
  writeMetaRootBlock,
  createEmptyMetaTableBuffer,
  writeMetaTableBlock,
  loadMetadataIndex,
  encodeUpsertMetadataEntry,
  encodeDeleteMetadataEntry,
  appendMetadataEntry,
  bumpNextBlobId,
} from './metadata.mjs';

export class BlobStore {
  private readonly blockSize: number;
  private readonly blockDataSize: number;
  private readonly maxBlobPayload: number;
  private readonly maxMetaEntryBytes: number;

  private readonly blobIndex: Map<number, BlobMetadataRecord> = new Map();

  private constructor(
    private readonly fbf: FreeBlockFile,
    private readonly metaBlockId: number,
    private nextBlobId: number,
    private metaHeadBlockId: number,
    private metaTailBlockId: number,
  ) {
    this.blockSize = this.fbf._getBlockSize();
    this.blockDataSize = computeBlockDataSize(this.blockSize);
    this.maxBlobPayload = this.blockDataSize - BLOB_PAYLOAD_OFFSET;
    this.maxMetaEntryBytes = this.blockDataSize - TABLE_HEADER_SIZE;

    if (this.maxBlobPayload <= 0) {
      throw new Error(`Block size ${this.blockSize.toString()} is too small for BlobStore`);
    }
  }

  getMetaBlockId(): number {
    return this.metaBlockId;
  }

  static async create(fbf: FreeBlockFile): Promise<BlobStore> {
    const metaBlockId = await fbf.allocateBlock();
    const tableBlockId = await fbf.allocateBlock();

    const store = new BlobStore(fbf, metaBlockId, 1, tableBlockId, tableBlockId);

    // init root + empty table
    await writeMetaRootBlock(fbf, metaBlockId, store.blockDataSize, {
      nextBlobId: store.nextBlobId,
      metaHeadBlockId: store.metaHeadBlockId,
      metaTailBlockId: store.metaTailBlockId,
    });
    await writeMetaTableBlock(fbf, tableBlockId, createEmptyMetaTableBuffer(store.blockDataSize));

    return store;
  }

  static async open(fbf: FreeBlockFile, metaBlockId: number): Promise<BlobStore> {
    const root = await readMetaRootBlock(fbf, metaBlockId);

    const store = new BlobStore(fbf, metaBlockId, root.nextBlobId, root.metaHeadBlockId, root.metaTailBlockId);

    const { maxBlobId } = await loadMetadataIndex(fbf, store.blockDataSize, store.metaHeadBlockId, store.blobIndex);
    store.nextBlobId = bumpNextBlobId(store.nextBlobId, maxBlobId);

    return store;
  }

  async writeBlobFromBuffer(data: Buffer, options?: { mimeType?: string }): Promise<BlobRef> {
    return this.writeBlobFromStream([data], options);
  }

  async writeBlobFromStream(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, options?: { mimeType?: string }): Promise<BlobRef> {
    const mimeType = this.normalizeMimeType(options?.mimeType);
    const createdAtMs = Date.now();

    const allocatedBlocks: number[] = [];
    let headBlockId = 0;
    let tailBlockId = 0;
    let currentBlockId = 0;
    let currentPayloadLength = 0;
    let sizeBytes = 0;
    const currentPayload = Buffer.alloc(this.maxBlobPayload);

    const allocateDataBlock = async (): Promise<number> => {
      const id = await this.fbf.allocateBlock();
      allocatedBlocks.push(id);
      return id;
    };

    const flushCurrent = async (nextBlockId: number): Promise<void> => {
      if (currentBlockId === 0) return;

      const blockData = Buffer.alloc(this.blockDataSize);
      blockData.writeUInt8(BLOB_BLOCK_MARKER, BLOB_MARKER_OFFSET);
      blockData.writeUInt32BE(nextBlockId, BLOB_NEXT_BLOCK_OFFSET);
      blockData.writeUInt32BE(currentPayloadLength, BLOB_PAYLOAD_LENGTH_OFFSET);
      currentPayload.subarray(0, currentPayloadLength).copy(blockData, BLOB_PAYLOAD_OFFSET);

      await this.fbf.writeBlock(currentBlockId, blockData);
      tailBlockId = currentBlockId;
    };

    try {
      for await (const chunk of chunks) {
        const chunkBuffer = Buffer.from(chunk);
        let cursor = 0;

        while (cursor < chunkBuffer.length) {
          if (currentBlockId === 0) {
            currentBlockId = await allocateDataBlock();
            if (headBlockId === 0) headBlockId = currentBlockId;
          }

          if (currentPayloadLength === this.maxBlobPayload) {
            const nextBlockId = await allocateDataBlock();
            await flushCurrent(nextBlockId);
            currentBlockId = nextBlockId;
            currentPayloadLength = 0;
            continue;
          }

          const writable = Math.min(this.maxBlobPayload - currentPayloadLength, chunkBuffer.length - cursor);
          chunkBuffer.copy(currentPayload, currentPayloadLength, cursor, cursor + writable);

          cursor += writable;
          currentPayloadLength += writable;
          sizeBytes += writable;

          if (sizeBytes > Number.MAX_SAFE_INTEGER) throw new Error('Blob size exceeds Number.MAX_SAFE_INTEGER');
        }
      }

      if (currentBlockId !== 0) await flushCurrent(0);

      const blobId = this.allocateBlobId();
      const metadata: BlobMetadataRecord = { sizeBytes, headBlockId, tailBlockId, mimeType };
      this.blobIndex.set(blobId, metadata);

      const entry = encodeUpsertMetadataEntry(blobId, metadata);
      const updated = await appendMetadataEntry({
        fbf: this.fbf,
        blockDataSize: this.blockDataSize,
        entry,
        maxMetaEntryBytes: this.maxMetaEntryBytes,
        metaHeadBlockId: this.metaHeadBlockId,
        metaTailBlockId: this.metaTailBlockId,
      });
      this.metaHeadBlockId = updated.metaHeadBlockId;
      this.metaTailBlockId = updated.metaTailBlockId;

      await writeMetaRootBlock(this.fbf, this.metaBlockId, this.blockDataSize, {
        nextBlobId: this.nextBlobId,
        metaHeadBlockId: this.metaHeadBlockId,
        metaTailBlockId: this.metaTailBlockId,
      });

      const ref: BlobRef = { kind: 'blob', blobId, sizeBytes, mimeType, createdAtMs };
      return ref;
    } catch (err) {
      await this.cleanupAllocatedBlocks(allocatedBlocks);
      throw err;
    }
  }

  async readRange(blobId: number, offset: number, length: number): Promise<Buffer> {
    const metadata = this.getMetadataOrThrow(blobId);
    this.assertRange(offset, length, metadata.sizeBytes);

    if (length === 0 || offset === metadata.sizeBytes) return Buffer.alloc(0);

    const endExclusive = Math.min(metadata.sizeBytes, offset + length);
    let remainingSkip = offset;
    let remainingRead = endExclusive - offset;
    let currentBlockId = metadata.headBlockId;

    const pieces: Buffer[] = [];
    const visited = new Set<number>();
    const maxVisited = this.maxReasonableDataBlocks(metadata.sizeBytes);

    while (currentBlockId !== 0 && remainingRead > 0) {
      this.assertNoLoop(visited, currentBlockId, maxVisited);
      const block = await this.readBlobDataBlock(currentBlockId);

      if (remainingSkip >= block.payloadLength) {
        remainingSkip -= block.payloadLength;
        currentBlockId = block.nextBlockId;
        continue;
      }

      const blockStart = remainingSkip;
      const take = Math.min(block.payloadLength - blockStart, remainingRead);

      pieces.push(block.payload.subarray(blockStart, blockStart + take));
      remainingRead -= take;
      remainingSkip = 0;
      currentBlockId = block.nextBlockId;
    }

    if (remainingRead !== 0) throw new CorruptBlobChain(`Blob ${blobId.toString()} ended before requested range could be read`);
    return Buffer.concat(pieces);
  }

  async *openReadStream(
    blobId: number,
    options?: { start?: number; endExclusive?: number; chunkSize?: number },
  ): AsyncIterable<Buffer> {
    const metadata = this.getMetadataOrThrow(blobId);

    const start = options?.start ?? 0;
    const endExclusive = options?.endExclusive ?? metadata.sizeBytes;
    const chunkSize = options?.chunkSize ?? DEFAULT_STREAM_CHUNK_SIZE;

    if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new InvalidRange('chunkSize must be a positive integer');
    if (!Number.isInteger(start) || !Number.isInteger(endExclusive)) throw new InvalidRange('start and endExclusive must be integers');
    if (start < 0 || endExclusive < 0) throw new InvalidRange('start and endExclusive must be non-negative');
    if (start > endExclusive) throw new InvalidRange('start must be <= endExclusive');
    if (endExclusive > metadata.sizeBytes) throw new InvalidRange('endExclusive is out of range for this blob');
    if (start === endExclusive) return;

    let remainingSkip = start;
    let remainingRead = endExclusive - start;
    let currentBlockId = metadata.headBlockId;

    const visited = new Set<number>();
    const maxVisited = this.maxReasonableDataBlocks(metadata.sizeBytes);

    let emitBuffer = Buffer.allocUnsafe(chunkSize);
    let emitLength = 0;

    while (currentBlockId !== 0 && remainingRead > 0) {
      this.assertNoLoop(visited, currentBlockId, maxVisited);
      const block = await this.readBlobDataBlock(currentBlockId);

      if (remainingSkip >= block.payloadLength) {
        remainingSkip -= block.payloadLength;
        currentBlockId = block.nextBlockId;
        continue;
      }

      let sourceOffset = remainingSkip;
      let sourceRemaining = Math.min(block.payloadLength - sourceOffset, remainingRead);

      while (sourceRemaining > 0) {
        const writable = Math.min(chunkSize - emitLength, sourceRemaining);
        block.payload.copy(emitBuffer, emitLength, sourceOffset, sourceOffset + writable);

        emitLength += writable;
        sourceOffset += writable;
        sourceRemaining -= writable;
        remainingRead -= writable;

        if (emitLength === chunkSize) {
          yield Buffer.from(emitBuffer);
          emitBuffer = Buffer.allocUnsafe(chunkSize);
          emitLength = 0;
        }
      }

      remainingSkip = 0;
      currentBlockId = block.nextBlockId;
    }

    if (remainingRead !== 0) throw new CorruptBlobChain(`Blob ${blobId.toString()} ended unexpectedly while streaming`);
    if (emitLength > 0) yield Buffer.from(emitBuffer.subarray(0, emitLength));
  }

  getBlobInfo(blobId: number): BlobInfo {
    const metadata = this.getMetadataOrThrow(blobId);
    return {
      sizeBytes: metadata.sizeBytes,
      mimeType: metadata.mimeType,
    };
  }

  async deleteBlob(blobId: number): Promise<void> {
    const metadata = this.getMetadataOrThrow(blobId);

    const visited = new Set<number>();
    const maxVisited = this.maxReasonableDataBlocks(metadata.sizeBytes);

    let currentBlockId = metadata.headBlockId;
    while (currentBlockId !== 0) {
      this.assertNoLoop(visited, currentBlockId, maxVisited);
      const block = await this.readBlobDataBlock(currentBlockId);
      const next = block.nextBlockId;
      await this.fbf.freeBlock(currentBlockId);
      currentBlockId = next;
    }

    this.blobIndex.delete(blobId);

    const entry = encodeDeleteMetadataEntry(blobId);
    const updated = await appendMetadataEntry({
      fbf: this.fbf,
      blockDataSize: this.blockDataSize,
      entry,
      maxMetaEntryBytes: this.maxMetaEntryBytes,
      metaHeadBlockId: this.metaHeadBlockId,
      metaTailBlockId: this.metaTailBlockId,
    });
    this.metaHeadBlockId = updated.metaHeadBlockId;
    this.metaTailBlockId = updated.metaTailBlockId;

    await writeMetaRootBlock(this.fbf, this.metaBlockId, this.blockDataSize, {
      nextBlobId: this.nextBlobId,
      metaHeadBlockId: this.metaHeadBlockId,
      metaTailBlockId: this.metaTailBlockId,
    });
  }

  async verifyBlobChain(blobId: number): Promise<void> {
    const metadata = this.getMetadataOrThrow(blobId);

    if (metadata.sizeBytes === 0) {
      if (metadata.headBlockId !== 0 || metadata.tailBlockId !== 0) {
        throw new CorruptBlobChain(`Blob ${blobId.toString()} has zero size but non-zero chain pointers`);
      }
      return;
    }

    if (metadata.headBlockId === 0 || metadata.tailBlockId === 0) {
      throw new CorruptBlobChain(`Blob ${blobId.toString()} has invalid head/tail pointers`);
    }

    const visited = new Set<number>();
    const maxVisited = this.maxReasonableDataBlocks(metadata.sizeBytes);

    let currentBlockId = metadata.headBlockId;
    let totalBytes = 0;
    let lastBlockId = 0;

    while (currentBlockId !== 0) {
      this.assertNoLoop(visited, currentBlockId, maxVisited);
      const block = await this.readBlobDataBlock(currentBlockId);

      totalBytes += block.payloadLength;
      if (totalBytes > Number.MAX_SAFE_INTEGER) {
        throw new CorruptBlobChain(`Blob ${blobId.toString()} size overflow while verifying chain`);
      }

      lastBlockId = currentBlockId;
      currentBlockId = block.nextBlockId;
    }

    if (totalBytes !== metadata.sizeBytes) {
      throw new CorruptBlobChain(
        `Blob ${blobId.toString()} size mismatch: metadata=${metadata.sizeBytes.toString()} chain=${totalBytes.toString()}`,
      );
    }

    if (lastBlockId !== metadata.tailBlockId) {
      throw new CorruptBlobChain(
        `Blob ${blobId.toString()} tail mismatch: metadata=${metadata.tailBlockId.toString()} chain=${lastBlockId.toString()}`,
      );
    }
  }

  // ---- internals ----

  private normalizeMimeType(mimeType: string | undefined): string | undefined {
    if (mimeType === undefined) return undefined;
    const normalized = mimeType.trim();
    if (normalized.length === 0) return undefined;
    if (Buffer.byteLength(normalized, 'utf8') > 0xffff) throw new Error('mimeType is too large to store');
    return normalized;
  }

  private allocateBlobId(): number {
    const blobId = this.nextBlobId;
    if (!Number.isInteger(blobId) || blobId <= 0 || blobId > UINT32_MAX) throw new Error('Blob id space exhausted');
    this.nextBlobId++;
    return blobId;
  }

  private getMetadataOrThrow(blobId: number): BlobMetadataRecord {
    const metadata = this.blobIndex.get(blobId);
    if (!metadata) throw new BlobNotFound(blobId);
    return metadata;
  }

  private async cleanupAllocatedBlocks(blockIds: number[]): Promise<void> {
    for (const blockId of blockIds) {
      try { await this.fbf.freeBlock(blockId); } catch { /* best effort */ }
    }
  }

  private assertRange(offset: number, length: number, sizeBytes: number): void {
    if (!Number.isInteger(offset) || !Number.isInteger(length)) throw new InvalidRange('offset and length must be integers');
    if (offset < 0 || length < 0) throw new InvalidRange('offset and length must be non-negative');
    if (offset > sizeBytes) throw new InvalidRange('offset exceeds blob size');
  }

  private assertNoLoop(visited: Set<number>, blockId: number, maxVisited: number): void {
    if (visited.has(blockId)) throw new CorruptBlobChain(`Detected loop in blob chain at block ${blockId.toString()}`);
    visited.add(blockId);
    if (visited.size > maxVisited) throw new CorruptBlobChain('Blob chain is larger than expected; possible corruption');
  }

  private maxReasonableDataBlocks(sizeBytes: number): number {
    return Math.ceil(sizeBytes / Math.max(1, this.maxBlobPayload)) + 2;
  }

  private async readBlobDataBlock(
    blockId: number,
  ): Promise<{ nextBlockId: number; payloadLength: number; payload: Buffer }> {
    const raw = await this.fbf.readBlock(blockId);
    const data = raw.subarray(1);

    if (data.readUInt8(BLOB_MARKER_OFFSET) !== BLOB_BLOCK_MARKER) {
      throw new CorruptBlobChain(`Block ${blockId.toString()} is not a blob data block`);
    }

    const nextBlockId = data.readUInt32BE(BLOB_NEXT_BLOCK_OFFSET);
    const payloadLength = data.readUInt32BE(BLOB_PAYLOAD_LENGTH_OFFSET);
    if (payloadLength > this.maxBlobPayload) {
      throw new CorruptBlobChain(
        `Block ${blockId.toString()} payload length ${payloadLength.toString()} exceeds max payload ${this.maxBlobPayload.toString()}`,
      );
    }

    const payload = data.subarray(BLOB_PAYLOAD_OFFSET, BLOB_PAYLOAD_OFFSET + payloadLength);
    return { nextBlockId, payloadLength, payload };
  }
}