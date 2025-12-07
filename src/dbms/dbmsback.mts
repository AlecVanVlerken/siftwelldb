// author: Thomas Dumon
// date: 2025-12-07

import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { type File } from '../core/file.mjs';
import { allocateBlock } from '../freeblockfile/freelist.mjs';
import { Document } from '../dbms/document.mjs';
import { RecordStore } from './recordstore.mjs';
import { BPlusTree } from '../btree/btree.mjs';
import { BlockNodeStorage } from '../btree/nodestorage.mjs';

export class DbmsBack {
  private freeblockFile: FreeBlockFile;
  private recordStore: RecordStore;
  private metaCache: Record<string, Record<string, [number, string]>> = {};

  private dataFile: File;
  private logFile: File;
  private atomicFile: AtomicFile;

  constructor(dataFile: File, logFile: File) {
    this.dataFile = dataFile;
    this.logFile = logFile;

    const atomicFile = new AtomicFile(this.dataFile, this.logFile);
    this.atomicFile = atomicFile;
    this.freeblockFile = new FreeBlockFile(atomicFile, 4096);
    this.recordStore = new RecordStore(this.freeblockFile);
  }

  async create(): Promise<void> {
    await this.freeblockFile.create(); // must be async
    await this.freeblockFile.open();
    const initialMeta = Buffer.from(JSON.stringify([]));
    await this.freeblockFile.writeClientArea(initialMeta);
  }

  static async open(dataFile: File, logFile: File): Promise<DbmsBack> {
    const dbmsback = new DbmsBack(dataFile, logFile);
    await dbmsback.freeblockFile.open();
    dbmsback.metaCache = await dbmsback.metaReadJSON();

    return dbmsback;
  }

  async close(): Promise<void> {
    await this.freeblockFile.close();
  }

  async commit(): Promise<void> {
    return this.freeblockFile.commit();
  }

  async insertDocument(document: Document): Promise<void> {
    const documentLocation = await this.recordStore.writeRecord(document);
    const collectionName = document.getCollectionName();
    const documentId = document.getId();
    let vorm = 'S';
    if (typeof documentId === 'number') {
      vorm = 'N';
    }
    // check if collection exists in meta, anders toevoegen
    const meta = this.metaCache;
    if (!(collectionName in meta)) {
      meta[collectionName] = {};
    }
    // voeg document-pointer toe aan id B+ tree

    // ga naar root voor id
    if (!('id' in meta[collectionName])) {
      // maak nieuwe B+ tree voor id aan en update meta
      const storage = new BlockNodeStorage(this.freeblockFile, { compareKeys: getCompareFunction(vorm) });
      // console.log('Creating B+ tree for collection id with form:', vorm);
      const tree = await BPlusTree.create(storage);
      const newIdRoot = tree.getRoot().getBlockNumber();

      meta[collectionName]['id'] = [newIdRoot, vorm];
    }
    // console.log('Inserting document with id:', documentId, 'into collection:', collectionName);
    const idRoot = meta[collectionName]['id'][0];
    // BPLUSTREE INSERT (IDROOT, (documentLocation, documentId ) : documentPointer)
    const idBuffer = toBuffer(vorm, documentId);
    const idStorage = new BlockNodeStorage(this.freeblockFile, { compareKeys: getCompareFunction(vorm) });
    // console.log('Loading B+ tree for collection id with root:', idRoot);
    const idTree = BPlusTree.open(idStorage, await idStorage.openTree(idRoot));
    // console.log('Inserting into B+ tree for collection id');
    const valueBuffer = Buffer.alloc(4); // 32-bit block number
    valueBuffer.writeUInt32BE(documentLocation, 0);
    await idTree.insert(idBuffer, valueBuffer);
    // update meta met nieuwe root als die veranderd is
    // console.log('Updating meta for collection id');
    meta[collectionName]['id'][0] = idTree.getRoot().getBlockNumber();
    // console.log('Document with id inserted:', documentId);
    // START FOR LOOP: voor elke iterabele key in document

    for (const key of document.getIterableKeys()) {
      // haal de vorm van de key op
      let keyVorm = vorm; // Default to vorm for unsupported types
      const keyValue = document.getFields()[key];
      let convertedKeyValue: string | number | Buffer = keyValue as string | number | Buffer;

      if (typeof keyValue === 'number') {
        // keyvorm : keyVorm + Idvorm as a string, dus "NN" of "SN" of "NS"
        keyVorm = 'N' + vorm;
      } else if (typeof keyValue === 'string') {
        keyVorm = 'S' + vorm;
      } else if (typeof keyValue === 'boolean') {
        // Treat booleans as numbers (0 for false, 1 for true)
        keyVorm = 'N' + vorm;
        convertedKeyValue = keyValue ? 1 : 0;
      }

      // check if iterable keys exist in meta, anders toevoegen
      if (!(key in meta[collectionName])) {
        // maak nieuwe B+ tree voor deze key aan en update meta
        const storage = new BlockNodeStorage(this.freeblockFile, { compareKeys: getCompareFunction(keyVorm) });
        const tree = await BPlusTree.create(storage);
        const newKeyRoot = tree.getRoot().getBlockNumber();
        meta[collectionName][key] = [newKeyRoot, keyVorm];
      }
      // load de B+ tree van de juiste collectie -> pointer naar de root
      const keyRoot = meta[collectionName][key];
      const keyStorage = new BlockNodeStorage(this.freeblockFile, { compareKeys: getCompareFunction(keyVorm) });
      const keyTree = BPlusTree.open(keyStorage, await keyStorage.openTree(keyRoot[0]));
      const keyBuffer = toBuffer(keyVorm, convertedKeyValue, documentId);
      const valueBuffer = Buffer.alloc(4);
      valueBuffer.writeUInt32BE(documentLocation, 0);
      await keyTree.insert(keyBuffer, valueBuffer);

      //update meta met nieuwe root als die veranderd is
      meta[collectionName][key][0] = keyTree.getRoot().getBlockNumber();
    }
    // END FOR LOOP
    this.metaCache = meta;
    await this.metaWriteJSON(meta);
  }

  async getDocument(documentId: number | string, collection: string): Promise<Document> {
    // ga naar root voor id
    if (!(collection in this.metaCache)) {
      throw new Error('Collection does not exist');
    } else if (!('id' in this.metaCache[collection])) {
      throw new Error('No document with given id exists');
    }
    const metaData = this.metaCache[collection]['id'];
    const root = metaData[0];
    const vorm = metaData[1];
    // zoek document-pointer in id B+ tree

    //BPLUSTREE SEARCH (root, blockId) : documentPointer
    const idBuffer = toBuffer(vorm, documentId);
    const idStorage = new BlockNodeStorage(this.freeblockFile, { compareKeys: getCompareFunction(vorm) });
    const idTree = BPlusTree.open(idStorage, await idStorage.openTree(root));
    const documentPointerBuffer = await idTree.get(idBuffer);
    // load document via recordstore writeRecord
    const documentPointer = documentPointerBuffer ? (documentPointerBuffer as Buffer).readUInt32BE(0) : null;
    if (documentPointer === null) {
      throw new Error('Document not found');
    }
    const document = (await this.recordStore.readRecord(documentPointer)) as Document;
    return document;
  }

  async deleteDocument(documentId: number | string, collection: string): Promise<void> {
    const document = await this.getDocument(documentId, collection);
    const iterableKeys = document.getIterableKeys();
    // verwijder document-pointer uit id B+ tree
    const metaData = this.metaCache[collection]['id'];
    const root = metaData[0];
    const vorm = metaData[1];
    //BPLUSTREE DELETE (root, (Key, id) )
    const idBuffer = toBuffer(vorm, documentId);
    const idStorage = new BlockNodeStorage(this.freeblockFile, { compareKeys: getCompareFunction(vorm) });
    const idTree = BPlusTree.open(idStorage, await idStorage.openTree(root));
    await idTree.delete(idBuffer);
    metaData[0] = idTree.getRoot().getBlockNumber();
    //update meta met nieuwe root als die veranderd is

    // START FOR LOOP: voor elke iterabele key in document
    for (const key of iterableKeys) {
      if (!(key in this.metaCache[collection])) {
        throw new Error('Key should exist in meta, but does not');
      }
      // load de B+ tree van de juiste collectie -> pointer naar de root
      const keyMetaData = this.metaCache[collection][key];
      const keyRoot = keyMetaData[0];
      const keyVorm = keyMetaData[1];
      const keyValue = document.getFields()[key];
      const keyStorage = new BlockNodeStorage(this.freeblockFile, { compareKeys: getCompareFunction(keyVorm) });
      const keyTree = BPlusTree.open(keyStorage, await keyStorage.openTree(keyRoot));
      const keyBuffer = toBuffer(keyVorm, keyValue as string | number | Buffer, documentId);
      await keyTree.delete(keyBuffer);
      // verwijder document-pointer uit B+ tree
      //BPLUSTREE DELETE (keyRoot, (Key, id) )
      //update meta met nieuwe root als die veranderd is
      keyMetaData[0] = keyTree.getRoot().getBlockNumber();
    }
    await this.metaWriteJSON(this.metaCache);
  }

  async cursor(
    collection: string,
    iterableKey: string,
    value?: string | number | Buffer,
  ): Promise<AsyncIterable<Document>> {
    if (!(collection in this.metaCache)) {
      throw new Error('Collection does not exist');
    }
    if (!(iterableKey in this.metaCache[collection])) {
      throw new Error('Iterable key does not exist in collection');
    }

    const keyMetaData = this.metaCache[collection][iterableKey];
    const keyRoot = keyMetaData[0];
    const keyVorm = keyMetaData[1];

    const keyStorage = new BlockNodeStorage(this.freeblockFile, { compareKeys: getCompareFunction(keyVorm) });
    const keyTree = BPlusTree.open(keyStorage, await keyStorage.openTree(keyRoot));

    const startKeyBuffer: Buffer | undefined = value !== undefined ? toBuffer(keyVorm, value) : undefined;
    const asyncGenerator = keyTree.iterate(startKeyBuffer);

    const documentGenerator = async function* (this: DbmsBack) {
      for await (const [, documentPointerBuffer] of asyncGenerator) {
        const documentPointer = (documentPointerBuffer as Buffer).readUInt32BE(0);
        const document = await this.recordStore.readRecord(documentPointer);
        if (!document) throw new Error(`Document error: not found`);
        yield document;
      }
    }.bind(this);

    return documentGenerator();
  }

  //hulperfuncties voor de meta

  async metaReadJSON(): Promise<Record<string, Record<string, [number, string]>>> {
    const binary = await this.freeblockFile.getClientArea();
    // Find the first null byte to get the actual JSON length
    let jsonLength = binary.length;
    for (let i = 0; i < binary.length; i++) {
      if (binary[i] === 0) {
        jsonLength = i;
        break;
      }
    }
    const jsonString = binary.subarray(0, jsonLength).toString();
    const meta = JSON.parse(jsonString) as number[];
    let binary2 = Buffer.alloc(0);
    for (const blockId of meta) {
      const binary3 = await this.freeblockFile.readBlock(blockId);
      // Skip the first byte (block type) when reading data blocks
      binary2 = Buffer.concat([binary2, binary3.subarray(1)]);
    }
    // Find the first null byte in the concatenated blocks
    let jsonLength2 = binary2.length;
    for (let i = 0; i < binary2.length; i++) {
      if (binary2[i] === 0) {
        jsonLength2 = i;
        break;
      }
    }
    const jsonString2 = binary2.subarray(0, jsonLength2).toString();
    return JSON.parse(jsonString2) as Record<string, Record<string, [number, string]>>;
  }

  async metaWriteJSON(meta: Record<string, Record<string, [number, string]>>): Promise<void> {
    // convert meta to binary
    const jsonString = JSON.stringify(meta);
    const binary = Buffer.from(jsonString);
    const blockSize = this.freeblockFile._getBlockSize() - 2; //-2 for safety
    const amountOfBlocks = Math.ceil(binary.length / (blockSize * 1024));

    // read existing block ids from client area
    const binaryBlockIds = await this.freeblockFile.getClientArea();
    // Find the first null byte to get the actual JSON length
    let jsonLength = binaryBlockIds.length;
    for (let i = 0; i < binaryBlockIds.length; i++) {
      if (binaryBlockIds[i] === 0) {
        jsonLength = i;
        break;
      }
    }
    const jsonString2 = binaryBlockIds.subarray(0, jsonLength).toString();
    const metaBlockIds = JSON.parse(jsonString2) as number[];

    // if amountOfBlocks > metaBlockIds.length, allocate more blocks
    // if amountOfBlocks < metaBlockIds.length, free some blocks
    if (amountOfBlocks > metaBlockIds.length) {
      for (let i = metaBlockIds.length; i < amountOfBlocks; i++) {
        const newBlockId = await allocateBlock(this.freeblockFile);
        metaBlockIds.push(newBlockId);
      }
    } else if (amountOfBlocks < metaBlockIds.length) {
      for (let i = metaBlockIds.length - 1; i >= amountOfBlocks; i--) {
        const blockIdToFree = metaBlockIds.pop() as number;
        await this.freeblockFile.freeBlock(blockIdToFree);
      }
    }
    // write data to blocks
    for (let i = 0; i < amountOfBlocks; i++) {
      const start = i * blockSize * 1024;
      const end = Math.min(start + blockSize * 1024, binary.length);
      const chunk = binary.subarray(start, end);
      await this.freeblockFile.writeBlock(metaBlockIds[i], chunk);
    }
    // write block ids to client area
    const newBinaryBlockIds = Buffer.from(JSON.stringify(metaBlockIds));
    await this.freeblockFile.writeClientArea(newBinaryBlockIds);
  }
}

function getCompareFunction(form: string): (a: Buffer, b: Buffer) => number {
  //als "N" => de key is een number
  //compare two buffers as numbers, should be 8 bytes each 64-bit float
  if (form === 'N') {
    return (a: Buffer, b: Buffer): number => {
      const numA = a.readDoubleBE(0);
      const numB = b.readDoubleBE(0);
      return numA - numB;
    };
  }
  //als "S" => de key is een string
  if (form === 'S') {
    return (a: Buffer, b: Buffer): number => {
      // compare legexicographically as buffers
      return a.compare(b);
    };
  }
  //als "B" => de key is een binary buffer
  if (form === 'B') {
    return (a: Buffer, b: Buffer): number => {
      return a.compare(b);
    };
  }
  //als "NN" => de key is een tuple van numbers
  if (form === 'NN') {
    return (a: Buffer, b: Buffer): number => {
      const numA1 = a.readDoubleBE(0);
      const numB1 = b.readDoubleBE(0);
      if (numA1 !== numB1) {
        return numA1 - numB1;
      }
      const numA2 = a.readDoubleBE(8);
      const numB2 = b.readDoubleBE(8);
      return numA2 - numB2;
    };
  }
  //als "SS" => de key is een tuple van strings
  // the buffers contain two strings, each prefixed by a 2-byte length
  if (form === 'SS') {
    return (a: Buffer, b: Buffer): number => {
      const lenA1 = a.readUInt16BE(0);
      const lenB1 = b.readUInt16BE(0);
      const strA1 = a.subarray(2, 2 + lenA1);
      const strB1 = b.subarray(2, 2 + lenB1);
      const cmp1 = strA1.compare(strB1);
      if (cmp1 !== 0) {
        return cmp1;
      }
      // Handle partial keys (only first component)
      const offsetA2 = 2 + lenA1;
      const offsetB2 = 2 + lenB1;
      if (a.length < offsetA2 + 2 || b.length < offsetB2 + 2) return 0;
      const lenA2 = a.readUInt16BE(offsetA2);
      const lenB2 = b.readUInt16BE(offsetB2);
      const strA2 = a.subarray(offsetA2 + 2, offsetA2 + 2 + lenA2);
      const strB2 = b.subarray(offsetB2 + 2, offsetB2 + 2 + lenB2);
      return strA2.compare(strB2);
    };
  }
  //als "SN" => de key is een tuple van (string, number)
  // the buffers contain a string prefixed by a 2-byte length, followed by an 8-byte number
  if (form === 'SN') {
    return (a: Buffer, b: Buffer): number => {
      const lenA1 = a.readUInt16BE(0);
      const lenB1 = b.readUInt16BE(0);
      const strA1 = a.subarray(2, 2 + lenA1);
      const strB1 = b.subarray(2, 2 + lenB1);
      const cmp1 = strA1.compare(strB1);
      if (cmp1 !== 0) {
        return cmp1;
      }
      // Handle partial keys (only first component)
      const offsetA = 2 + lenA1;
      const offsetB = 2 + lenB1;
      if (a.length < offsetA + 8 || b.length < offsetB + 8) return 0;
      const numA2 = a.readDoubleBE(offsetA);
      const numB2 = b.readDoubleBE(offsetB);
      return numA2 - numB2;
    };
  }
  // als "NS" => de key is een tuple van (number, string)
  // the buffers contain an 8-byte number followed by a string prefixed by a 2-byte length
  if (form === 'NS') {
    return (a: Buffer, b: Buffer): number => {
      const numA1 = a.readDoubleBE(0);
      const numB1 = b.readDoubleBE(0);
      if (numA1 !== numB1) {
        return numA1 - numB1;
      }
      // Handle partial keys (only first component)
      if (a.length < 10 || b.length < 10) return 0;
      const lenA2 = a.readUInt16BE(8);
      const lenB2 = b.readUInt16BE(8);
      const strA2 = a.subarray(10, 10 + lenA2);
      const strB2 = b.subarray(10, 10 + lenB2);
      return strA2.compare(strB2);
    };
  }
  throw new Error(`Unknown key form: ${form}`);
}

function toBuffer(vorm: string, input1: string | number | Buffer, input2?: string | number): Buffer {
  if (vorm === 'N') {
    const buffer = Buffer.alloc(8);
    buffer.writeDoubleBE(input1 as number, 0);
    return buffer;
  }
  if (vorm === 'S') {
    return Buffer.from(input1 as string);
  }
  if (vorm === 'B') {
    return input1 as Buffer;
  }
  if (vorm === 'NN') {
    if (input2 === undefined) {
      const buffer = Buffer.alloc(8);
      buffer.writeDoubleBE(input1 as number, 0);
      return buffer;
    }
    const buffer = Buffer.alloc(16);
    buffer.writeDoubleBE(input1 as number, 0);
    buffer.writeDoubleBE(input2 as number, 8);
    return buffer;
  }
  if (vorm === 'SS') {
    const str1 = Buffer.from(input1 as string);
    if (input2 === undefined) {
      const buffer = Buffer.alloc(2 + str1.length);
      buffer.writeUInt16BE(str1.length, 0);
      str1.copy(buffer, 2);
      return buffer;
    }
    const str2 = Buffer.from(input2 as string);
    const buffer = Buffer.alloc(2 + str1.length + 2 + str2.length);
    buffer.writeUInt16BE(str1.length, 0);
    str1.copy(buffer, 2);
    buffer.writeUInt16BE(str2.length, 2 + str1.length);
    str2.copy(buffer, 4 + str1.length);
    return buffer;
  }
  if (vorm === 'SN') {
    const str1 = Buffer.from(input1 as string);
    if (input2 === undefined) {
      const buffer = Buffer.alloc(2 + str1.length);
      buffer.writeUInt16BE(str1.length, 0);
      str1.copy(buffer, 2);
      return buffer;
    }
    const buffer = Buffer.alloc(2 + str1.length + 8);
    buffer.writeUInt16BE(str1.length, 0);
    str1.copy(buffer, 2);
    buffer.writeDoubleBE(input2 as number, 2 + str1.length);
    return buffer;
  }
  if (vorm === 'NS') {
    if (input2 === undefined) {
      const buffer = Buffer.alloc(8);
      buffer.writeDoubleBE(input1 as number, 0);
      return buffer;
    }
    const str2 = Buffer.from(input2 as string);
    const buffer = Buffer.alloc(8 + 2 + str2.length);
    buffer.writeDoubleBE(input1 as number, 0);
    buffer.writeUInt16BE(str2.length, 8);
    str2.copy(buffer, 10);
    return buffer;
  }
  throw new Error(`Unknown key form: ${vorm}`);
}
