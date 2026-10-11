// author: Matisse De Gauquier
// date: 2025-12-07

import { Document, type RawId, type FieldValue } from '../../database/document.mjs';
import { FreeBlockFile } from '../blocks/freeblockfile.mjs';
import { getBlockCount, getBlockType } from '../blocks/io.mjs';
import { BlockType } from '../blocks/layout.mjs';
import {
  CompressionRegistry,
  type CompressionAlgorithm,
  type FieldCompressionDefaults,
  type FieldCompressionOverrides,
} from '../../database/compression.mjs';

export type RecordWriteOptions = {
  compressionDefaults?: FieldCompressionDefaults;
  compressionOverrides?: FieldCompressionOverrides;
};

export class RecordReadError extends Error {
  constructor(blockID: number, cause: unknown, encoded = false) {
    super(
      `Cannot read ${encoded ? 'encoded record' : 'record'} at block ${blockID}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'RecordReadError';
  }
}

export type RecordRelocationWriteOptions = {
  maxBlockExclusive?: number;
};

export type EncodedFieldEntry = {
  key: string;
  valueType: 'string' | 'number' | 'boolean' | 'buffer';
  compression: CompressionAlgorithm;
  payloadBase64: string;
};

export type EncodedDocument = {
  collection: string;
  id: RawId;
  iterableEntries: EncodedFieldEntry[];
  nonIterableEntries: EncodedFieldEntry[];
};

export type RecordStorageEstimate = {
  serializedBytes: number;
  blocks: number;
  allocatedBytes: number;
  blockSize: number;
  dataBytesPerBlock: number;
};

type LegacyStoredDocument = {
  collection: string;
  id: RawId;
  iterableEntries: [string, unknown][];
  nonIterableEntries: [string, unknown][];
};

type StoredDocumentV2 = {
  version: 2;
  collection: string;
  id: RawId;
  iterableEntries: EncodedFieldEntry[];
  nonIterableEntries: EncodedFieldEntry[];
};

/**
 * RecordStore class
 *
 * Provides high-level operations for storing, reading, and deleting documents
 * in a FreeBlockFile based storage system.
 *
 * Each Document is serialized and stored across one or more blocks.
 * Large documents are split across multiple blocks using a linked list structure.
 *
 * Block format:
 * - 1 byte: block type (reserved by FreeBlockFile)
 * - 4 bytes: next block ID (0 = no next block)
 * - remaining bytes: document data
 *
 * Block IDs are used to reference stored documents.
 */
export class RecordStore {
  private freeBlockFile: FreeBlockFile;
  private blockSize: number;
  private compressionRegistry: CompressionRegistry;
  private static readonly BLOCK_TYPE_BYTES = 1; // reserved by FreeBlockFile
  private static readonly NEXT_BLOCK_BYTES = 4; // size of the nextBlockID pointer
  private static readonly DATA_OFFSET = RecordStore.BLOCK_TYPE_BYTES + RecordStore.NEXT_BLOCK_BYTES;

  /**
   * Creates a new RecordStore instance.
   * @param blockFile - The FreeBlockFile instance to use for storage.
   */
  constructor(blockFile: FreeBlockFile, compressionRegistry: CompressionRegistry = new CompressionRegistry()) {
    this.freeBlockFile = blockFile;
    this.blockSize = blockFile._getBlockSize();
    this.compressionRegistry = compressionRegistry;
  }

  /**
   * Writes a Document to the store.
   *
   * The document is serialized and stored in one or more blocks.
   * Each block contains a pointer to the next block if the document
   * spans multiple blocks.
   *
   * @param {Document} doc - The Document to write
   * @returns {Promise<number>} - The block ID of the first block
   * @throws {Error} - If serialization fails
   */
  async writeRecord(doc: Document, options?: RecordWriteOptions): Promise<number> {
    const data = this.serializeDocument(doc, options);
    const blockNumber = await this.writeSerializedRecord(data);
    if (blockNumber === null) {
      throw new Error('RecordStore.writeRecord could not allocate record blocks');
    }
    return blockNumber;
  }

  async writeRecordEncoded(doc: EncodedDocument): Promise<number> {
    const data = this.serializeEncodedDocument(doc);
    const blockNumber = await this.writeSerializedRecord(data);
    if (blockNumber === null) {
      throw new Error('RecordStore.writeRecordEncoded could not allocate record blocks');
    }
    return blockNumber;
  }

  async writeRecordEncodedBelow(doc: EncodedDocument, options: RecordRelocationWriteOptions): Promise<number | null> {
    const data = this.serializeEncodedDocument(doc);
    return await this.writeSerializedRecord(data, options);
  }

  private async writeSerializedRecord(
    data: Buffer,
    options: RecordRelocationWriteOptions = {},
  ): Promise<number | null> {
    // Block size minus block type byte and next block pointer
    const maxDataPerBlock = this.getDataBytesPerBlock();

    // split data into chunks fitting in blocks
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < data.length) {
      const chunkSize = Math.min(maxDataPerBlock, data.length - offset);
      chunks.push(data.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    }

    // allocate blocks for all chunks (in reversed order for linking)
    const blockIDs =
      options.maxBlockExclusive === undefined
        ? await this.allocateRecordBlocks(chunks.length)
        : await this.freeBlockFile.allocateBlocksBelow(options.maxBlockExclusive, chunks.length);

    if (blockIDs === null) {
      return null;
    }

    // write each chunk to its block with next block pointer
    for (let i = 0; i < chunks.length; i++) {
      const blockID = blockIDs[i];
      const chunk = chunks[i];
      const nextBlockID = i < chunks.length - 1 ? blockIDs[i + 1] : 0;

      // Write directly into the FBF dirty block that allocateBlock created.
      // This avoids Buffer.alloc(blockSize) + data.copy() inside writeBlock().
      let rawBlock = this.freeBlockFile._getDirtyBlock(blockID);
      if (rawBlock === undefined) {
        // Fallback path (should not happen for freshly allocated blocks).
        rawBlock = await this.freeBlockFile.readBlock(blockID);
        this.freeBlockFile._setDirtyBlock(blockID, rawBlock);
      }
      const usable = rawBlock.subarray(1);
      usable.writeUInt32LE(nextBlockID, 0);
      chunk.copy(usable, RecordStore.NEXT_BLOCK_BYTES);
    }

    // return the first block ID (head of the chain)
    return blockIDs[0];
  }

  private async allocateRecordBlocks(count: number): Promise<number[]> {
    const blockIDs: number[] = [];
    for (let i = 0; i < count; i++) {
      blockIDs.push(await this.freeBlockFile.allocateBlock());
    }
    return blockIDs;
  }

  estimateRecordStorage(doc: Document, options?: RecordWriteOptions): RecordStorageEstimate {
    const data = this.serializeDocument(doc, options);
    const dataBytesPerBlock = this.getDataBytesPerBlock();
    const blocks = Math.max(1, Math.ceil(data.length / dataBytesPerBlock));

    return {
      serializedBytes: data.length,
      blocks,
      allocatedBytes: blocks * this.blockSize,
      blockSize: this.blockSize,
      dataBytesPerBlock,
    };
  }

  /**
   * Reads a Document from the store by block ID.
   *
   * Follows the linked list of blocks to reconstruct the complete document.
   *
   * @param {number} blockID - The block ID of the first block in the chain
   * @returns {Promise<Document | null>} The Document, or null for an absent/freed head block.
   * @throws {Error} - If reading or deserialization fails
   */
  async readRecord(blockID: number): Promise<Document | null> {
    try {
      const stored = await this.readStoredDocument(blockID);
      if (!stored) return null;
      return this.deserializeDocument(stored);
    } catch (err) {
      throw new RecordReadError(blockID, err);
    }
  }

  async readRecordEncoded(blockID: number): Promise<EncodedDocument | null> {
    try {
      const stored = await this.readStoredDocument(blockID);
      if (!stored) return null;
      return {
        collection: stored.collection,
        id: stored.id,
        iterableEntries: stored.iterableEntries,
        nonIterableEntries: stored.nonIterableEntries,
      };
    } catch (error) {
      throw new RecordReadError(blockID, error, true);
    }
  }

  /**
   * Deletes a Document from the store by block ID.
   *
   * Follows the linked list and frees all blocks in the chain.
   *
   * @param {number} blockID - The block ID of the first block in the chain
   * @returns {Promise<void>}
   * @throws {Error} If any block cannot be freed
   */
  /**
   * Returns the on-disk byte footprint of a record's block chain:
   * `chainLength × blockSize`. Walks the linked list of blocks starting
   * at `blockID`. This reflects physical disk reservation, including
   * unused tail space in the last block.
   *
   * @param {number} blockID - The block ID of the first block in the chain
   * @returns {Promise<number>} - Total bytes reserved on disk for this record
   */
  async getStoredByteCount(blockID: number): Promise<number> {
    return (await this.readRecordBlockChain(blockID)).length * this.blockSize;
  }

  /**
   * Underlying block size in bytes. Useful for callers that want to
   * report per-block accounting alongside per-record byte totals.
   */
  getBlockSize(): number {
    return this.blockSize;
  }

  async deleteRecord(blockID: number): Promise<void> {
    const blocksToFree = await this.readRecordBlockChain(blockID);

    // Free all blocks
    for (const blockToFree of blocksToFree) {
      await this.freeBlockFile.freeBlock(blockToFree);
    }
  }

  async readRecordBlockChain(blockID: number): Promise<number[]> {
    const blocks: number[] = [];
    for await (const [currentBlockID] of this.recordBlocks(blockID)) blocks.push(currentBlockID);
    return blocks;
  }

  private async *recordBlocks(blockID: number, head?: Buffer): AsyncGenerator<[number, Buffer]> {
    const visited = new Set<number>();
    let currentBlockID = blockID;
    while (currentBlockID !== 0) {
      if (visited.has(currentBlockID)) throw new Error(`Cyclic record chain at block ${currentBlockID}`);
      visited.add(currentBlockID);
      const blockData = currentBlockID === blockID && head ? head : await this.freeBlockFile.readBlock(currentBlockID);
      if (getBlockType(blockData) !== BlockType.Data) {
        throw new Error(`Record chain references non-data block ${currentBlockID} (type=${blockData[0]})`);
      }
      yield [currentBlockID, blockData];
      currentBlockID = blockData.readUInt32LE(RecordStore.BLOCK_TYPE_BYTES);
    }
  }

  private serializeDocument(doc: Document, options?: RecordWriteOptions): Buffer {
    const iterableEntries = this.serializeEntries(doc.getIterableKeys(), doc.getFields(), options);
    const nonIterableEntries = this.serializeEntries(doc.getNonIterableKeys(), doc.getFields(), options);

    const payload: StoredDocumentV2 = {
      version: 2,
      collection: doc.getCollectionName(),
      id: doc.getId(),
      iterableEntries,
      nonIterableEntries,
    };

    const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf-8');
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(jsonBuffer.length, 0);

    return Buffer.concat([lengthBuffer, jsonBuffer]);
  }

  private serializeEncodedDocument(doc: EncodedDocument): Buffer {
    const payload: StoredDocumentV2 = {
      version: 2,
      collection: doc.collection,
      id: doc.id,
      iterableEntries: doc.iterableEntries,
      nonIterableEntries: doc.nonIterableEntries,
    };

    const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf-8');
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(jsonBuffer.length, 0);

    return Buffer.concat([lengthBuffer, jsonBuffer]);
  }

  private serializeEntries(
    keys: string[],
    fields: Record<string, FieldValue>,
    options?: RecordWriteOptions,
  ): EncodedFieldEntry[] {
    const entries: EncodedFieldEntry[] = [];

    for (const key of keys) {
      const value = fields[key];
      const valueType = this.resolveValueType(value);

      if (valueType === 'string' || valueType === 'buffer') {
        const raw = valueType === 'string' ? Buffer.from(value as string, 'utf-8') : (value as Buffer);
        const requested = this.resolveCompressionAlgorithm(key, options);

        let compression: CompressionAlgorithm = requested;
        let payload: Buffer<ArrayBufferLike> = raw;

        if (requested !== 'none') {
          const compressed = this.compressionRegistry.get(requested).compress(raw);
          // Keep only size-effective compression.
          if (compressed.length < raw.length) {
            payload = compressed;
          } else {
            compression = 'none';
          }
        }

        entries.push({
          key,
          valueType,
          compression,
          payloadBase64: payload.toString('base64'),
        });
      } else {
        const payload = Buffer.from(JSON.stringify(value), 'utf-8');
        entries.push({
          key,
          valueType,
          compression: 'none',
          payloadBase64: payload.toString('base64'),
        });
      }
    }

    return entries;
  }

  private resolveValueType(value: FieldValue): EncodedFieldEntry['valueType'] {
    if (Buffer.isBuffer(value)) return 'buffer';
    if (typeof value === 'string') return 'string';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    throw new Error('Unsupported value type');
  }

  private getDataBytesPerBlock(): number {
    return this.blockSize - RecordStore.DATA_OFFSET;
  }

  private resolveCompressionAlgorithm(key: string, options?: RecordWriteOptions): CompressionAlgorithm {
    const overrides = options?.compressionOverrides;
    const override = overrides && Object.hasOwn(overrides, key) ? overrides[key] : undefined;
    if (override === 'off') return 'none';
    if (override) return override;

    const defaults = options?.compressionDefaults;
    return (defaults && Object.hasOwn(defaults, key) ? defaults[key] : undefined) ?? 'none';
  }

  private async readStoredDocument(blockID: number): Promise<StoredDocumentV2 | null> {
    // Absence is determined explicitly; read/decode failures are never absence.
    if (!Number.isSafeInteger(blockID) || blockID < 0) throw new Error(`Invalid record block ${blockID}`);
    if (blockID === 0 || blockID >= getBlockCount(this.freeBlockFile)) return null;
    const head = await this.freeBlockFile.readBlock(blockID);
    if (getBlockType(head) === BlockType.Free) return null;
    const chunks: Buffer[] = [];

    // Follow the chain of blocks
    for await (const [, blockData] of this.recordBlocks(blockID, head)) {
      // Read the pointer to the next block
      const nextBlockID = blockData.readUInt32LE(RecordStore.BLOCK_TYPE_BYTES);

      // Extract the data (skip the pointer)
      const dataInBlock = blockData.subarray(RecordStore.DATA_OFFSET);

      // Add to chunks (without trailing zeros if this is the last block)
      if (nextBlockID === 0) {
        // Last block: trim trailing zeros
        let actualLength = dataInBlock.length;
        while (actualLength > 0 && dataInBlock[actualLength - 1] === 0) {
          actualLength--;
        }
        chunks.push(dataInBlock.subarray(0, actualLength));
      } else {
        // Not the last block: use all
        chunks.push(dataInBlock);
      }
    }

    const completeData = Buffer.concat(chunks);
    return this.deserializeStoredDocument(completeData);
  }

  private deserializeStoredDocument(data: Buffer): StoredDocumentV2 {
    if (data.length < 4) throw new Error('Record payload has no complete length prefix');
    const length = data.readUInt32BE(0);
    // Reused blocks may retain bytes after the payload. The length prefix,
    // rather than padding contents, determines the stored JSON boundary.
    if (length === 0 || length > data.length - 4) throw new Error('Record payload length exceeds its data');
    const jsonBuffer = data.subarray(4, 4 + length);
    const jsonString = jsonBuffer.toString('utf-8');

    const rawParsed = JSON.parse(jsonString) as LegacyStoredDocument | StoredDocumentV2;
    if (
      !rawParsed ||
      typeof rawParsed !== 'object' ||
      typeof rawParsed.collection !== 'string' ||
      !['string', 'number'].includes(typeof rawParsed.id) ||
      !Array.isArray(rawParsed.iterableEntries) ||
      !Array.isArray(rawParsed.nonIterableEntries)
    ) {
      throw new Error('Invalid stored document structure');
    }
    if ('version' in rawParsed && rawParsed.version === 2) {
      for (const entry of [...rawParsed.iterableEntries, ...rawParsed.nonIterableEntries]) {
        if (
          !entry ||
          typeof entry.key !== 'string' ||
          !['string', 'number', 'boolean', 'buffer'].includes(entry.valueType) ||
          typeof entry.compression !== 'string' ||
          typeof entry.payloadBase64 !== 'string'
        )
          throw new Error('Invalid stored field structure');
      }
      return rawParsed;
    }
    if ('version' in rawParsed) throw new Error(`Unsupported stored document version ${String(rawParsed.version)}`);

    return this.fromLegacy(rawParsed);
  }

  private fromLegacy(doc: LegacyStoredDocument): StoredDocumentV2 {
    const toEntries = (entries: [string, unknown][]): EncodedFieldEntry[] => {
      return entries.map(([key, value]) => {
        const legacyValue = this.decodeLegacyValue(value);
        const valueType = this.resolveValueType(legacyValue);

        const payload =
          valueType === 'string'
            ? Buffer.from(legacyValue as string, 'utf-8')
            : valueType === 'buffer'
              ? (legacyValue as Buffer)
              : Buffer.from(JSON.stringify(legacyValue), 'utf-8');

        return {
          key,
          valueType,
          compression: 'none',
          payloadBase64: payload.toString('base64'),
        };
      });
    };

    return {
      version: 2,
      collection: doc.collection,
      id: doc.id,
      iterableEntries: toEntries(doc.iterableEntries),
      nonIterableEntries: toEntries(doc.nonIterableEntries),
    };
  }

  private decodeLegacyValue(value: unknown): FieldValue {
    if (value !== null && typeof value === 'object' && '__bin' in (value as Record<string, unknown>)) {
      const raw = (value as { __bin: string }).__bin;
      return Buffer.from(raw, 'base64');
    }

    if (
      Buffer.isBuffer(value) ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }

    throw new Error('Unsupported legacy field value');
  }

  private deserializeDocument(stored: StoredDocumentV2): Document {
    const iterableEntries = this.decodeEntries(stored.iterableEntries);
    const nonIterableEntries = this.decodeEntries(stored.nonIterableEntries);

    return new Document(stored.collection, stored.id, iterableEntries, nonIterableEntries);
  }

  private decodeEntries(entries: EncodedFieldEntry[]): [string, FieldValue][] {
    return entries.map((entry) => {
      const payload = Buffer.from(entry.payloadBase64, 'base64');
      const decoded = this.decodeFieldPayload(entry, payload);
      return [entry.key, decoded];
    });
  }

  private decodeFieldPayload(entry: EncodedFieldEntry, payload: Buffer): FieldValue {
    let raw = payload;

    if (entry.compression !== 'none') {
      const codec = this.compressionRegistry.get(entry.compression);

      // Validate encoded bytes agree with expected algorithm magic when available.
      const detected = this.compressionRegistry.detect(payload);
      if (detected && !this.compressionFormatsMatch(detected.id, entry.compression)) {
        throw new Error(`Compression metadata mismatch for field ${entry.key}`);
      }

      raw = codec.decompress(payload);
    }

    if (entry.valueType === 'buffer') {
      return raw;
    }

    const asText = raw.toString('utf-8');
    if (entry.valueType === 'string') {
      return asText;
    }
    if (entry.valueType === 'number') {
      const value: unknown = JSON.parse(asText);
      if (typeof value !== 'number') throw new Error(`Invalid number payload for field ${entry.key}`);
      return value;
    }
    if (entry.valueType === 'boolean') {
      const value: unknown = JSON.parse(asText);
      if (typeof value !== 'boolean') throw new Error(`Invalid boolean payload for field ${entry.key}`);
      return value;
    }

    throw new Error(`Unknown value type: ${entry.valueType as string}`);
  }

  private compressionFormatsMatch(detected: CompressionAlgorithm, expected: CompressionAlgorithm): boolean {
    if (detected === expected) return true;
    return detected.startsWith('zstd') && expected.startsWith('zstd');
  }
}
