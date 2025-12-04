// @author: Matisse De Gauquier

import { Document, type RawId, type FieldValue } from "./document.mjs";
import { FreeBlockFile } from "../freeblockfile/freeblockfile.mjs";


// class definition for RecordStore
// Provides high-level operations for storing, reading and deleting documents
// in a FreeBlockFile based storage system
//
// Each Document is serialized and stored in a block
// Block IDs are used to reference stored documents
export class RecordStore {

    private freeBlockFile: FreeBlockFile;

    // Creates a new RecordStore instance
    // @param {FreeBlockFile} blockFile - The FreeBlockFile instance to use for storage
    constructor(blockFile: FreeBlockFile) {
        this.freeBlockFile = blockFile;
    }

    // writeRecord writes a Document to the store
    // The document is serialized to a binary format and written to a free block
    // If there are free blocks available, it reuses one
    // Otherwise, it appends a new block to the file
    // It returns the block ID where the document is stored
    // @param {Document} doc - The Document to write
    // @returns {Promise<number>} - The block ID where the document is stored
    // @throws {Error} - If serialization fails or the document is too large
    async writeRecord(doc: Document): Promise<number> {
        
        const data = this.serializeDocument(doc);

        const blockID = await this.freeBlockFile.allocateBlock();
        await this.freeBlockFile.writeBlock(blockID, data);
        await this.freeBlockFile.commit();
        return blockID;
    }


    // readRecord reads a Document from the store by block id
    // It returns the Document object or null if not found
    // @param {number} blockID - The block ID of the Document to read
    // @returns {Promise<Document | null>} - The Document object or null if not found
    // @throws {Error} - If reading or deserialization fails
    async readRecord(blockID: number): Promise<Document | null> {
        try {
            const data = await this.freeBlockFile.readBlock(blockID);

            const doc = this.deserializeDocument(data);
            return doc;
        } catch (error) {
            console.error("Error reading record:", error);
            return null;
        }
    }

    // deleteRecord deletes a Document from the store by block id
    // The block is freed and added back to the free block list
    // @param {number} blockID - The block ID of the Document to delete
    // @returns {Promise<void>}
    // @throws {Error} - If the block cannot be freed
    async deleteRecord(blockID: number): Promise<void> {
        await this.freeBlockFile.freeBlock(blockID);
        await this.freeBlockFile.commit();
    }

    // Serializes a Document to a Buffer for storage
    // Format: [4-byte length][JSON data]
    // @param {Document} doc - The Document to serialize
    // @returns {Buffer} - The serialized Buffer
    // @throws {Error} - If the serialized data exceeds maximum block size
    private serializeDocument(doc: Document): Buffer {
        // convert Document to JSON string
        const json = JSON.stringify({
            collection: doc.getCollectionName(),
            id: doc.getId(),
            iterableEntries: doc.getIterableKeys(),
            nonIterableEntries: doc.getNonIterableKeys()
        });
        
        const jsonBuffer = Buffer.from(json, 'utf-8');
        const lengthBuffer = Buffer.alloc(4);
        lengthBuffer.writeUInt32BE(jsonBuffer.length, 0);

        const resultBuffer = Buffer.concat([lengthBuffer, jsonBuffer]);

        const maxBlockSize = this.freeBlockFile._getBlockSize() - 1;
        if (resultBuffer.length > maxBlockSize) {
            throw new Error("Serialized document exceeds maximum block size");
        }

        return resultBuffer;
    }

    // Deserializes a Buffer back to a Document
    // @param {Buffer} buffer - The Buffer to deserialize
    // @returns {Document} - The deserialized Document
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

        return new Document(
            doc.collection,
            doc.id,
            doc.iterableEntries,
            doc.nonIterableEntries
        );
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(errorMessage);
    }
    }
}