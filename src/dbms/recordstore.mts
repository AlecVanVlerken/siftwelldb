// author: Matisse De Gauquier
// date: 2025-12-07

import { Document, type RawId, type FieldValue } from './document.mjs';
import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import {
  CompressionRegistry,
  type CompressionAlgorithm,
  type FieldCompressionDefaults,
  type FieldCompressionOverrides,
} from './compression.mjs';

export type RecordWriteOptions = {
  compressionDefaults?: FieldCompressionDefaults;
  compressionOverrides?: FieldCompressionOverrides;
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

    // Block size minus block type byte and next block pointer
    const maxDataPerBlock = this.blockSize - RecordStore.DATA_OFFSET;

    // split data into chunks fitting in blocks
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < data.length) {
      const chunkSize = Math.min(maxDataPerBlock, data.length - offset);
      chunks.push(data.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    }

    // allocate blocks for all chunks (in reversed order for linking)
    const blockIDs: number[] = [];
    for (const chunk of chunks) {
      void chunk;
      blockIDs.push(await this.freeBlockFile.allocateBlock());
    }

    // write each chunk to its block with next block pointer
    for (let i = 0; i < chunks.length; i++) {
      const blockID = blockIDs[i];
      const chunk = chunks[i];
      const nextBlockID = i < chunks.length - 1 ? blockIDs[i + 1] : 0;

      // make buffer for block data
      const blockBuffer = Buffer.alloc(this.blockSize - RecordStore.BLOCK_TYPE_BYTES);
      blockBuffer.writeUInt32LE(nextBlockID, 0); // written after the type byte by writeBlock
      chunk.copy(blockBuffer, RecordStore.NEXT_BLOCK_BYTES);

      await this.freeBlockFile.writeBlock(blockID, blockBuffer);
    }

    // return the first block ID (head of the chain)
    return blockIDs[0];
  }

  /**
   * Reads a Document from the store by block ID.
   *
   * Follows the linked list of blocks to reconstruct the complete document.
   *
   * @param {number} blockID - The block ID of the first block in the chain
   * @returns {Promise<Document | null>} The Document object, or null if not found or invalid
   * @throws {Error} - If reading or deserialization fails
   */
  async readRecord(blockID: number): Promise<Document | null> {
    try {
      const stored = await this.readStoredDocument(blockID);
      if (!stored) return null;
      return this.deserializeDocument(stored);
    } catch (err) {
      console.error(`RecordStore.readRecord(${blockID}) failed:`, err);
      return null;
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
      console.error(`Failed to read encoded record from block ${blockID}:`, error);
      return null;
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
  async deleteRecord(blockID: number): Promise<void> {
    const blocksToFree: number[] = [];
    let currentBlockID = blockID;

    // Collect all block IDs in the chain
    while (currentBlockID !== 0) {
      blocksToFree.push(currentBlockID);

      // Read the block to get the next pointer
      const blockData = await this.freeBlockFile.readBlock(currentBlockID);
      const nextBlockID = blockData.readUInt32LE(RecordStore.BLOCK_TYPE_BYTES);

      currentBlockID = nextBlockID;
    }

    // Free all blocks
    for (const blockToFree of blocksToFree) {
      await this.freeBlockFile.freeBlock(blockToFree);
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

  private resolveCompressionAlgorithm(key: string, options?: RecordWriteOptions): CompressionAlgorithm {
    const override = options?.compressionOverrides?.[key];
    if (override === 'off') return 'none';
    if (override) return override;

    return options?.compressionDefaults?.[key] ?? 'none';
  }

  private async readStoredDocument(blockID: number): Promise<StoredDocumentV2 | null> {
    const chunks: Buffer[] = [];
    let currentBlockID = blockID;

    // Follow the chain of blocks
    while (currentBlockID !== 0) {
      // Read the block
      const blockData = await this.freeBlockFile.readBlock(currentBlockID);

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

      currentBlockID = nextBlockID;
    }

    const completeData = Buffer.concat(chunks);
    return this.deserializeStoredDocument(completeData);
  }

  private deserializeStoredDocument(data: Buffer): StoredDocumentV2 {
    const length = data.readUInt32BE(0);
    const jsonBuffer = data.subarray(4, 4 + length);
    const jsonString = jsonBuffer.toString('utf-8');

    const rawParsed = JSON.parse(jsonString) as LegacyStoredDocument | StoredDocumentV2;
    if ('version' in rawParsed && rawParsed.version === 2) {
      return rawParsed;
    }

    return this.fromLegacy(rawParsed as LegacyStoredDocument);
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

    if (Buffer.isBuffer(value) || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
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
      if (detected && detected.id !== entry.compression) {
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
      return JSON.parse(asText) as number;
    }
    if (entry.valueType === 'boolean') {
      return JSON.parse(asText) as boolean;
    }

    throw new Error(`Unknown value type: ${entry.valueType as string}`);
  }
}
