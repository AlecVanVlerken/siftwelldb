// author: Matisse De Gauquier
// date: 2025-12-07

import { Document, type RawId, type FieldValue } from './document.mjs';
import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';

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
 * [NextBlockID: 4 bytes (0 = no next block)][Data: remaining bytes]
 *
 * Block IDs are used to reference stored documents.
 */
export class RecordStore {
  private freeBlockFile: FreeBlockFile;
  private blockSize: number;
  private static readonly BLOCK_TYPE_BYTES = 1; // reserved by FreeBlockFile
  private static readonly NEXT_BLOCK_BYTES = 4; // size of the nextBlockID pointer
  private static readonly DATA_OFFSET = RecordStore.BLOCK_TYPE_BYTES + RecordStore.NEXT_BLOCK_BYTES;

  /**
   * Creates a new RecordStore instance.
   * @param blockFile - The FreeBlockFile instance to use for storage.
   */
  constructor(blockFile: FreeBlockFile) {
    this.freeBlockFile = blockFile;
    this.blockSize = blockFile._getBlockSize();
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
  async writeRecord(doc: Document): Promise<number> {
    const data = this.serializeDocument(doc);

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

    // commit changes to FreeBlockFile
    await this.freeBlockFile.commit();

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

      // Combine all chunks
      const completeData = Buffer.concat(chunks);

      // Deserialize the data back into a Document
      const doc = this.deserializeDocument(completeData);

      return doc;
    } catch (error) {
      // Block does not exist, is corrupt, or deserialization failed
      console.error(`Failed to read record from block ${blockID}:`, error);
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

    // Commit to make the changes persistent
    await this.freeBlockFile.commit();
  }

  /**
   * Serializes a Document to a Buffer for storage
   * Format: [4-byte length][JSON data]
   *
   * @param {Document} doc - The Document to serialize
   * @returns {Buffer} - The serialized Buffer
   */
  private serializeDocument(doc: Document): Buffer {
    // convert Document to JSON string
    const iterableKeys = doc.getIterableKeys();
    const nonIterableKeys = doc.getNonIterableKeys();
    const fields = doc.getFields();

    const iterableEntries = iterableKeys.map((key) => [key, fields[key] as FieldValue]);
    const nonIterableEntries = nonIterableKeys.map((key) => [key, fields[key] as FieldValue]);

    const json = JSON.stringify({
      collection: doc.getCollectionName(),
      id: doc.getId(),
      iterableEntries,
      nonIterableEntries,
    });

    const jsonBuffer = Buffer.from(json, 'utf-8');
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(jsonBuffer.length, 0);

    const resultBuffer = Buffer.concat([lengthBuffer, jsonBuffer]);

    return resultBuffer;
  }

  /**
   * Deserializes a Buffer back to a Document
   *
   * @param {Buffer} buffer - The Buffer to deserialize
   * @returns {Document} - The deserialized Document
   * @throws {Error} - If deserialization fails
   */
  private deserializeDocument(data: Buffer): Document {
    try {
      // read length in first 4 bytes
      const length = data.readUInt32BE(0);

      const jsonBuffer = data.subarray(4, 4 + length);
      const jsonString = jsonBuffer.toString('utf-8');

      // parse JSON to object
      const doc = JSON.parse(jsonString) as {
        collection: string;
        id: RawId;
        iterableEntries: [string, FieldValue][];
        nonIterableEntries: [string, FieldValue][];
      };

      return new Document(doc.collection, doc.id, doc.iterableEntries, doc.nonIterableEntries);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(errorMessage);
    }
  }
}
