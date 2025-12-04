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

  private constructor(dataFile: File, logFile: File) {
    const atomicFile = new AtomicFile(dataFile, logFile);
    this.freeblockFile = new FreeBlockFile(atomicFile, 4096);
    this.recordStore = new RecordStore(this.freeblockFile);

    //initialiseer metadata, dus rootblock
    this.rootBlock = -1;
  }

  async create(dataFile: File, logFile: File): Promise<DbmsBack> {
    const dbmsback = new DbmsBack(dataFile, logFile);
    await dbmsback.freeblockFile.create();

    //initialiseer metadata, dus rootblock
    dbmsback.rootBlock = await allocateBlock(dbmsback.freeblockFile);
    await dbmsback.freeblockFile.setRootBlock(dbmsback.rootBlock);

    return dbmsback;
  }

  async open(dataFile: File, logFile: File): Promise<DbmsBack> {
    const dbmsback = new DbmsBack(dataFile, logFile);
    await dbmsback.freeblockFile.open();

    return dbmsback;
  }

  insertDocument(document: Document): Promise<void> {
    const documentLocation = this.recordStore.writeRecord(document);
    // check if collection exists in meta, anders toevoegen
    // check if iterable keys exist in meta, anders toevoegen
    // load de B+ tree van de juiste collectie
    // voeg document toe aan B+ tree
    throw new Error('Method not implemented.');
  }

  getDocument(blockId: number): Promise<Document> {
    throw new Error('Method not implemented.');
  }

  deleteDocument(blockId: number): Promise<void> {
    throw new Error('Method not implemented.');
  }

  cursor(): AsyncIterable<Document> {
    throw new Error('Method not implemented.');
  }

  //hulperfuncties voor de meta

  async metaGetCollections(): Promise<string[]> {
    const binary = await this.freeblockFile.getClientArea();
    const jsonString = binary.toString();
    const meta = JSON.parse(jsonString) as Record<string, number>;
    return Object.keys(meta);
  }

  async metaGetKeyTreeRoot(collection: string, iterabeleKey: string): Promise<number> {
    if (iterabeleKey[0] === '_') {
      throw new Error('Input should be an iterable key, so not starting with _');
    }
    const binary = await this.freeblockFile.getClientArea();
    const jsonString = binary.toString();
    const meta = JSON.parse(jsonString) as Record<string, number>;
    const binary2 = await this.freeblockFile.readBlock(meta[collection]);
    const jsonString2 = binary2.toString();
    const collectionMeta = JSON.parse(jsonString2) as Record<string, number>;
    return collectionMeta[iterabeleKey];
  }

  async metaAddCollection(collection: string): Promise<void> {
    const binary = await this.freeblockFile.getClientArea();
    const jsonString = binary.toString();
    const meta = JSON.parse(jsonString) as Record<string, number>;
    const blockId = await allocateBlock(this.freeblockFile);
    meta[collection] = blockId;
    const newMetaBinary = Buffer.from(JSON.stringify(meta));
    await this.freeblockFile.writeClientArea(newMetaBinary);
  }

  async metaAddIterableKey(collection: string, iterableKey: string): Promise<void> {
    const binary = await this.freeblockFile.getClientArea();
    const jsonString = binary.toString();
    const meta = JSON.parse(jsonString) as Record<string, number>;
    const blockId = meta[collection];
    const binary2 = await this.freeblockFile.readBlock(blockId);
    const jsonString2 = binary2.toString();
    const collectionMeta = JSON.parse(jsonString2) as Record<string, number>;
    if (iterableKey in collectionMeta) {
      throw new Error('iterableKey already exists');
    }
    const newBlockId = await allocateBlock(this.freeblockFile);
    collectionMeta[iterableKey] = newBlockId;
    const newCollectionMetaBinary = Buffer.from(JSON.stringify(collectionMeta));
    await this.freeblockFile.writeBlock(blockId, newCollectionMetaBinary);
  }

  async metaDeleteCollection(collection: string): Promise<void> {
    const binary = await this.freeblockFile.getClientArea();
    const jsonString = binary.toString();
    const meta = JSON.parse(jsonString) as Record<string, number>;
    const blockId = meta[collection];
    const binary2 = await this.freeblockFile.readBlock(blockId);
    const jsonString2 = binary2.toString();
    const collectionMeta = JSON.parse(jsonString2) as Record<string, number>;
    if (Object.keys(collectionMeta).length !== 0) {
      throw new Error('Collection is not empty, you must delete all iterable keys first');
    }
    await this.freeblockFile.freeBlock(blockId);
    delete meta[collection];
    const newMetaBinary = Buffer.from(JSON.stringify(meta));
    await this.freeblockFile.writeClientArea(newMetaBinary);
  }

  async metaDeleteIterableKey(collection: string, iterableKey: string): Promise<void> {
    const binary = await this.freeblockFile.getClientArea();
    const jsonString = binary.toString();
    const meta = JSON.parse(jsonString) as Record<string, number>;
    const blockId = meta[collection];
    const binary2 = await this.freeblockFile.readBlock(blockId);
    const jsonString2 = binary2.toString();
    const collectionMeta = JSON.parse(jsonString2) as Record<string, number>;
    await this.freeblockFile.freeBlock(collectionMeta[iterableKey]);
    delete collectionMeta[iterableKey];
    const newCollectionMetaBinary = Buffer.from(JSON.stringify(collectionMeta));
    await this.freeblockFile.writeBlock(blockId, newCollectionMetaBinary);
  }

  /**
   *
   * @param collection
   * @param key
   * @returns the blockId of the root of the B+ tree for this key; if it does not exist yet, it is created
   * if the collection does not exist yet, it is created as well
   */
  async metaGetKeyRoot(collection: string, key: string): Promise<number> {
    const binary = await this.freeblockFile.getClientArea();
    const jsonString = binary.toString();
    const meta = JSON.parse(jsonString) as Record<string, number>;
    if (!(collection in meta)) {
      const blockId = await allocateBlock(this.freeblockFile);
      meta[collection] = blockId;
      const newMetaBinary = Buffer.from(JSON.stringify(meta));
      await this.freeblockFile.writeClientArea(newMetaBinary);
    }
    const blockId = meta[collection];
    const binary2 = await this.freeblockFile.readBlock(blockId);
    const jsonString2 = binary2.toString();
    const collectionMeta = JSON.parse(jsonString2) as Record<string, number>;
    if (key in collectionMeta) {
      return collectionMeta[key];
    } else {
      const newBlockId = await allocateBlock(this.freeblockFile);
      collectionMeta[key] = newBlockId;
      const newCollectionMetaBinary = Buffer.from(JSON.stringify(collectionMeta));
      await this.freeblockFile.writeBlock(blockId, newCollectionMetaBinary);
      return newBlockId;
    }
  }
}
