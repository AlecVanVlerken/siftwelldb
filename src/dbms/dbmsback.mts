import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { type File } from '../core/file.mjs';
import { allocateBlock } from '../freeblockfile/freelist.mjs';
import { Document } from '../dbms/document.mjs';
import { RecordStore } from './recordstore.mjs';

export class DbmsBack {
  freeblockFile: FreeBlockFile;
  recordStore: RecordStore;
  rootBlock: number;
  metaCache: Record<string, Record<string, number>>;

  private constructor(dataFile: File, logFile: File) {
    const atomicFile = new AtomicFile(dataFile, logFile);
    this.freeblockFile = new FreeBlockFile(atomicFile, 4096);
    this.recordStore = new RecordStore(this.freeblockFile);

    //initialiseer metadata, dus rootblock
    this.rootBlock = -1;
    this.metaCache = {};
  }

  async create(dataFile: File, logFile: File): Promise<DbmsBack> {
    const dbmsback = new DbmsBack(dataFile, logFile);
    await dbmsback.freeblockFile.create();

    //initialize client area for metadata
    const initialMeta = Buffer.from(JSON.stringify([]));
    await dbmsback.freeblockFile.writeClientArea(initialMeta);

    return dbmsback;
  }

  async open(dataFile: File, logFile: File): Promise<DbmsBack> {
    const dbmsback = new DbmsBack(dataFile, logFile);
    await dbmsback.freeblockFile.open();
    dbmsback.metaCache = await dbmsback.metaReadJSON();

    return dbmsback;
  }

  async insertDocument(document: Document): Promise<void> {
    const documentLocation = this.recordStore.writeRecord(document);
    const collectionName = document.getCollectionName();
    const documentId = document.getId();
    // check if collection exists in meta, anders toevoegen
    const meta = this.metaCache;
    if (!(collectionName in meta)) {
      meta[collectionName] = {};
    }
    // ga naar root voor id
    if (!('id' in meta[collectionName])) {
      // maak nieuwe B+ tree voor id aan en update meta
      meta[collectionName]['id'] = await allocateBlock(this.freeblockFile);
    }
    const idRoot = meta[collectionName]['id'];
    // voeg document-pointer toe aan id B+ tree

    // TODO: BPLUSTREE INSERT (IDROOT, (documentLocation, documentId ) : documentPointer)
    // TODO: update meta met nieuwe root als die veranderd is

    // START FOR LOOP: voor elke iterabele key in document

    for (const key of document.getIterableKeys()) {
      // check if iterable keys exist in meta, anders toevoegen
      if (!(key in meta[collectionName])) {
        // maak nieuwe B+ tree voor deze key aan en update meta
        meta[collectionName][key] = await allocateBlock(this.freeblockFile);
      }
      // load de B+ tree van de juiste collectie -> pointer naar de root
      const keyRoot = meta[collectionName][key];
      // voeg document-pointer toe aan B+ tree als in (key, id): pointer

      // TODO: BPLUSTREE INSERT (keyRoot, (documentLocation, documentId ) : documentPointer)
      // TODO: update meta met nieuwe root als die veranderd is
    }
    // END FOR LOOP
    this.metaCache = meta;
    await this.metaWriteJSON(meta);
  }

  getDocument(blockId: number, collection: string): Promise<Document> {
    // ga naar root voor id
    if (!(collection in this.metaCache)) {
      throw new Error('Collection does not exist');
    } else if (!('id' in this.metaCache[collection])) {
      throw new Error('No document with given id exists');
    }
    const root = this.metaCache[collection]['id'];
    // zoek document-pointer in id B+ tree

    //TODO: BPLUSTREE SEARCH (root, blockId) : documentPointer

    // load document via recordstore writeRecord
    // TODO const document = await this.recordStore.readRecord(documentPointer);
    throw new Error('Method not implemented.');
  }

  async deleteDocument(blockId: number, collection: string): Promise<void> {
    const document = await this.getDocument(blockId, collection);
    const iterableKeys = document.getIterableKeys();
    // verwijder document-pointer uit id B+ tree
    const root = this.metaCache[collection]['id'];

    // TODO: BPLUSTREE DELETE (root, (Key, id) )
    // TODO: update meta met nieuwe root als die veranderd is

    // START FOR LOOP: voor elke iterabele key in document
    for (const key of iterableKeys) {
      if (!(key in this.metaCache[collection])) {
        throw new Error('Key should exist in meta, but does not');
      }
      // load de B+ tree van de juiste collectie -> pointer naar de root
      const keyRoot = this.metaCache[collection][key];
      // verwijder document-pointer uit B+ tree
      //TODO BPLUSTREE DELETE (keyRoot, (Key, id) )
      //TODO: update meta met nieuwe root als die veranderd is
    }
    await this.metaWriteJSON(this.metaCache);
  }

  cursor(): AsyncIterable<Document> {
    throw new Error('Method not implemented.');
  }

  //hulperfuncties voor de meta

  async metaReadJSON(): Promise<Record<string, Record<string, number>>> {
    const binary = await this.freeblockFile.getClientArea();
    const jsonString = binary.toString();
    const meta = JSON.parse(jsonString) as number[];
    let binary2 = Buffer.alloc(0);
    for (const blockId of meta) {
      const binary3 = await this.freeblockFile.readBlock(blockId);
      binary2 = Buffer.concat([binary2, binary3]);
    }
    const jsonString2 = binary2.toString();
    return JSON.parse(jsonString2) as Record<string, Record<string, number>>;
  }

  async metaWriteJSON(meta: Record<string, Record<string, number>>): Promise<void> {
    // convert meta to binary
    const jsonString = JSON.stringify(meta);
    const binary = Buffer.from(jsonString);
    const blockSize = this.freeblockFile._getBlockSize() - 2; //-2 for safety
    const amountOfBlocks = Math.ceil(binary.length / (blockSize * 1024));

    // read existing block ids from client area
    const binaryBlockIds = await this.freeblockFile.getClientArea();
    const jsonString2 = binaryBlockIds.toString();
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
