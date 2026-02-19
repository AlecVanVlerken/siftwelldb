// author: Thomas Dumon
// date: 2025-12-07

import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { type File } from '../core/file.mjs';
import { allocateBlock } from '../freeblockfile/freelist.mjs';
import { Document, type FieldValue } from '../dbms/document.mjs';
import { RecordStore } from './recordstore.mjs';
import { BPlusTree } from '../btree/btree.mjs';
import { BlockNodeStorage } from '../btree/nodestorage.mjs';
import type { BlockLeafNode } from '../btree/leafnode.mjs';
import type { BlockInternalNode } from '../btree/internalnode.mjs';
import { HNSWIndex } from '../hnsw/hnswIndex.mjs';
import { HNSWGraphStorage } from '../hnsw/hnswGraphStorage.mjs';
import { VectorHeapFile } from '../hnsw/vectorHeapFile.mjs';

// ── HNSW semantic-search integration ─────────────────────────────────────────

/**
 * Factory that produces the two File pairs needed for a per-collection HNSW
 * index (graph storage + vector heap).  Called once per role and collection.
 */
export type HnswFileFactory = (collectionName: string, role: 'graph' | 'vector') => { dataFile: File; logFile: File };

/**
 * Optional configuration block that enables per-collection HNSW semantic
 * search inside a `DbmsBack` / `SimpleDbms` instance.
 *
 * When present, every document that contains at least one non-`_`-prefixed
 * string field will have those string values concatenated and embedded into
 * the collection's HNSW index upon insertion.
 */
export type HnswConfig = {
  /** Dimensionality of the vectors produced by `embeddingFn`. */
  dimension: number;
  /**
   * Async function that converts a plain-text string into a fixed-size
   * float32 embedding vector — supply any HuggingFace (or other) model here.
   */
  embeddingFn: (text: string) => Promise<Float32Array>;
  /**
   * Factory that returns File pairs for each collection's HNSW storage.
   * For a production deployment, return real OS-backed Files.
   * For tests, return MockFiles.
   */
  fileFactory: HnswFileFactory;
  /** HNSW M parameter (max neighbours per node). Default: 16. */
  M?: number;
  /** Maximum level stored per node. Default: 4. */
  maxStoredLevel?: number;
  /** ef during index construction. Default: 200. */
  efConstruction?: number;
  /** ef during search. Default: 50. */
  efSearch?: number;
};

/** Reserved metaCache key used to track which collections have an HNSW index. */
const HNSW_META_KEY = '__hnsw__';

type CachedTree = {
  storage: BlockNodeStorage;
  tree: BPlusTree<Buffer, Buffer, BlockLeafNode, BlockInternalNode>;
};

/**
 * DbmsBack class
 *
 * Provides low-level operations for managing the database backend,
 * including document insertion, retrieval, deletion, and cursor-based iteration.
 */
export class DbmsBack {
  private freeblockFile: FreeBlockFile;
  private recordStore: RecordStore;
  private metaCache: Record<string, Record<string, [number, string]>> = {};

  private dataFile: File;
  private logFile: File;
  private atomicFile: AtomicFile;

  // Cache for BlockNodeStorage instances: key = "collection:field"
  private storageCache: Map<string, BlockNodeStorage> = new Map();

  // Cache for B+ trees: key = "collection:field"
  private treeCache: Map<string, CachedTree> = new Map();

  // ── HNSW fields ────────────────────────────────────────────────────────────
  private hnswConfig: HnswConfig | undefined;
  /** In-memory cache of per-collection HNSW indices. */
  private hnswIndexCache: Map<string, HNSWIndex> = new Map();

  /**
   * Creates an instance of the DbmsBack class.
   * @param dataFile - The file to use for storing data.
   * @param logFile - The file to use for logging.
   */
  constructor(dataFile: File, logFile: File, hnswConfig?: HnswConfig) {
    this.dataFile = dataFile;
    this.logFile = logFile;

    const atomicFile = new AtomicFile(this.dataFile, this.logFile);
    this.atomicFile = atomicFile;
    this.freeblockFile = new FreeBlockFile(atomicFile, 4096);
    this.recordStore = new RecordStore(this.freeblockFile);
    this.hnswConfig = hnswConfig;
  }

  /**
   * Creates a new database backend.
   * @returns A Promise that resolves when the database backend is created.
   */
  async create(): Promise<void> {
    await this.freeblockFile.create(); // must be async
    await this.freeblockFile.open();
    const initialMeta = Buffer.from(JSON.stringify([]));
    await this.freeblockFile.writeClientArea(initialMeta);
  }

  /**
   * Opens an existing database backend.
   * @param dataFile - The file to use for storing data.
   * @param logFile - The file to use for logging.
   * @returns A Promise that resolves to the opened DbmsBack instance.
   */
  static async open(dataFile: File, logFile: File, hnswConfig?: HnswConfig): Promise<DbmsBack> {
    const dbmsback = new DbmsBack(dataFile, logFile, hnswConfig);
    await dbmsback.freeblockFile.open();
    dbmsback.metaCache = await dbmsback.metaReadJSON();

    // Re-open HNSW indices for every collection that was indexed before.
    if (hnswConfig && HNSW_META_KEY in dbmsback.metaCache) {
      for (const col of Object.keys(dbmsback.metaCache[HNSW_META_KEY])) {
        const idx = await dbmsback.openHnswIndex(col);
        dbmsback.hnswIndexCache.set(col, idx);
      }
    }

    return dbmsback;
  }

  /**
   * Closes the database backend.
   * @returns A Promise that resolves when the database backend is closed.
   */
  async close(): Promise<void> {
    for (const idx of this.hnswIndexCache.values()) {
      await idx.close();
    }
    await this.freeblockFile.close();
  }

  /**
   * Gets or creates a cached BlockNodeStorage for the given collection and field.
   * @param collection - The collection name.
   * @param field - The field name (e.g., 'id' or an iterable key).
   * @param vorm - The key form string for comparison function.
   * @returns The cached or newly created BlockNodeStorage.
   */
  private getOrCreateStorage(collection: string, field: string, vorm: string): BlockNodeStorage {
    const cacheKey = `${collection}:${field}`;
    let storage = this.storageCache.get(cacheKey);
    if (!storage) {
      storage = new BlockNodeStorage(this.freeblockFile, { compareKeys: getCompareFunction(vorm) });
      this.storageCache.set(cacheKey, storage);
    }
    return storage;
  }

  /**
   * Gets or creates a cached B+ tree for the given collection and field.
   * @param collection - The collection name.
   * @param field - The field name (e.g., 'id' or an iterable key).
   * @param vorm - The key form string for comparison function.
   * @param rootBlock - The root block number of the tree.
   * @returns The cached or newly opened B+ tree.
   */
  private async getOrCreateTree(
    collection: string,
    field: string,
    vorm: string,
    rootBlock: number,
  ): Promise<BPlusTree<Buffer, Buffer, BlockLeafNode, BlockInternalNode>> {
    const cacheKey = `${collection}:${field}`;
    const cached = this.treeCache.get(cacheKey);
    if (cached) {
      return cached.tree;
    }
    const storage = this.getOrCreateStorage(collection, field, vorm);
    const root = await storage.openTree(rootBlock);
    const tree: BPlusTree<Buffer, Buffer, BlockLeafNode, BlockInternalNode> = BPlusTree.open(storage, root);
    this.treeCache.set(cacheKey, { storage, tree });
    return tree;
  }

  /**
   * Commits all changes to the database.
   * @returns A Promise that resolves when the commit is complete.
   */
  async commit(): Promise<void> {
    await this.metaWriteJSON(this.metaCache);
    await this.freeblockFile.commit();
    // Commit HNSW AFTER the main FBF so the "data before index" crash-safety
    // invariant is preserved: if a crash occurs between the two commits, the
    // main store is in a consistent state and the HNSW index is just stale.
    for (const idx of this.hnswIndexCache.values()) {
      await idx.commit();
    }
  }

  /**
   * Inserts a Document into the database.
   * @param document - The Document to insert.
   * @returns A Promise that resolves when the document is inserted.
   */
  async insertDocument(document: Document): Promise<void> {
    const documentLocation = await this.recordStore.writeRecord(document); //constant time
    const collectionName = document.getCollectionName(); //constant time
    const documentId = document.getId(); //constant time
    let vorm = 'S'; //constant time
    if (typeof documentId === 'number') {
      vorm = 'N'; //constant time
    }
    // check if collection exists in meta, anders toevoegen
    const meta = this.metaCache; //constant time
    if (!(collectionName in meta)) {
      meta[collectionName] = {};
    }
    // voeg document-pointer toe aan id B+ tree

    // ga naar root voor id
    let idTree: BPlusTree<Buffer, Buffer, BlockLeafNode, BlockInternalNode>; // constant time
    if (!('id' in meta[collectionName])) {
      // maak nieuwe B+ tree voor id aan en update meta
      const storage = this.getOrCreateStorage(collectionName, 'id', vorm);
      idTree = await BPlusTree.create(storage);
      const newIdRoot = idTree.getRoot().getBlockNumber();
      meta[collectionName]['id'] = [newIdRoot, vorm];
      // Cache the newly created tree
      this.treeCache.set(`${collectionName}:id`, { storage, tree: idTree });
    } else {
      const idRoot = meta[collectionName]['id'][0];
      idTree = await this.getOrCreateTree(collectionName, 'id', vorm, idRoot);
    }

    // BPLUSTREE INSERT (IDROOT, (documentLocation, documentId ) : documentPointer)
    const idBuffer = toBuffer(vorm, documentId); //constant time
    const valueBuffer = Buffer.alloc(4); // 32-bit block number
    valueBuffer.writeUInt32BE(documentLocation, 0);
    await idTree.insert(idBuffer, valueBuffer);
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
      let keyTree: BPlusTree<Buffer, Buffer, BlockLeafNode, BlockInternalNode>;
      if (!(key in meta[collectionName])) {
        // maak nieuwe B+ tree voor deze key aan en update meta
        const storage = this.getOrCreateStorage(collectionName, key, keyVorm);
        keyTree = await BPlusTree.create(storage);
        const newKeyRoot = keyTree.getRoot().getBlockNumber();
        meta[collectionName][key] = [newKeyRoot, keyVorm];
        // Cache the newly created tree
        this.treeCache.set(`${collectionName}:${key}`, { storage, tree: keyTree });
      } else {
        // load de B+ tree van de juiste collectie -> pointer naar de root
        const keyRoot = meta[collectionName][key][0];
        keyTree = await this.getOrCreateTree(collectionName, key, keyVorm, keyRoot);
      }

      const keyBuffer = toBuffer(keyVorm, convertedKeyValue, documentId);
      const valueBuffer = Buffer.alloc(4);
      valueBuffer.writeUInt32BE(documentLocation, 0);
      await keyTree.insert(keyBuffer, valueBuffer);
    }
    // END FOR LOOP

    // ── HNSW: embed and index text fields ────────────────────────────────────
    if (this.hnswConfig) {
      const text = this.extractText(document);
      if (text !== null) {
        const hnswIdx = await this.getOrCreateHnswIndex(collectionName);
        const vector = await this.hnswConfig.embeddingFn(text);
        // docId = documentLocation (block number) — unique uint32 per record.
        await hnswIdx.insert(documentLocation, vector);
      }
    }

    this.metaCache = meta;
    // Note: metaWriteJSON is called in commit() to batch writes
  }

  /**
   * Retrieves a document from the database.
   * @param documentId - The ID of the document to retrieve.
   * @param collection - The collection to retrieve the document from.
   * @returns A Promise that resolves to the retrieved Document.
   */
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
    const idTree = await this.getOrCreateTree(collection, 'id', vorm, root);
    const documentPointerBuffer = await idTree.get(idBuffer);
    // load document via recordstore writeRecord
    const documentPointer = documentPointerBuffer ? documentPointerBuffer.readUInt32BE(0) : null;
    if (documentPointer === null) {
      throw new Error('Document not found');
    }
    const document = (await this.recordStore.readRecord(documentPointer)) as Document;
    return document;
  }

  /**
   * Deletes a document from the database.
   * @param documentId - The ID of the document to delete.
   * @param collection - The collection to delete the document from.
   */
  async deleteDocument(documentId: number | string, collection: string): Promise<void> {
    // Check if collection exists
    if (!(collection in this.metaCache)) {
      throw new Error('Collection does not exist');
    }
    if (!('id' in this.metaCache[collection])) {
      throw new Error('No document with given id exists');
    }

    // First, get the document pointer from the id tree before deleting
    const metaData = this.metaCache[collection]['id'];
    const root = metaData[0];
    const vorm = metaData[1];
    const idBuffer = toBuffer(vorm, documentId);
    const idTree = await this.getOrCreateTree(collection, 'id', vorm, root);
    const documentPointerBuffer = await idTree.get(idBuffer);
    if (!documentPointerBuffer) {
      throw new Error('Document not found');
    }
    const documentPointer = documentPointerBuffer.readUInt32BE(0);

    // Get the document for its iterable keys
    const document = await this.recordStore.readRecord(documentPointer);
    if (!document) {
      throw new Error('Document not found in record store');
    }
    const iterableKeys = document.getIterableKeys();

    // Delete from id B+ tree
    await idTree.delete(idBuffer);
    metaData[0] = idTree.getRoot().getBlockNumber();

    // Delete from all iterable key trees
    for (const key of iterableKeys) {
      if (!(key in this.metaCache[collection])) {
        throw new Error('Key should exist in meta, but does not');
      }
      // load de B+ tree van de juiste collectie -> pointer naar de root
      const keyMetaData = this.metaCache[collection][key];
      const keyRoot = keyMetaData[0];
      const keyVorm = keyMetaData[1];
      const keyValue = document.getFields()[key];
      const keyTree = await this.getOrCreateTree(collection, key, keyVorm, keyRoot);
      const keyBuffer = toBuffer(keyVorm, keyValue as string | number | Buffer, documentId);
      await keyTree.delete(keyBuffer);
      // verwijder document-pointer uit B+ tree
      //BPLUSTREE DELETE (keyRoot, (Key, id) )
      //update meta met nieuwe root als die veranderd is
      keyMetaData[0] = keyTree.getRoot().getBlockNumber();
    }

    // Remove from HNSW (no-op if this collection was never indexed or the
    // document was inserted without HNSW config active).
    if (this.hnswConfig && this.hnswIndexCache.has(collection)) {
      await this.hnswIndexCache.get(collection)!.delete(documentPointer);
    }

    // Free the record blocks from the record store
    await this.recordStore.deleteRecord(documentPointer);

    // Note: metaWriteJSON is called in commit() to batch writes
  }

  /**
   * Edits a document in the database.
   * @param existingDocument - The existing document to edit.
   * @param newDocument - The new document with updated fields.
   * @returns A Promise that resolves when the document is edited.
   * @throws {Error} If the document ID or collection name is changed.
   *
   * @author: Matisse De Gauquier
   */
  async editDocumentByID(collection: string, id: string, field: string, newValue: FieldValue): Promise<void> {
    const existingDocument = await this.getDocument(id, collection);
    const newDocumentObj = existingDocument.cloneWithUpdatedField(field, newValue);

    if (
      existingDocument.getId() !== newDocumentObj.getId() ||
      existingDocument.getCollectionName() !== newDocumentObj.getCollectionName()
    ) {
      throw new Error('Cannot change document ID or collection name during edit.');
    }

    await this.deleteDocument(existingDocument.getId(), existingDocument.getCollectionName());
    await this.insertDocument(newDocumentObj);
  }

  /**
   * Queries the database for documents matching the specified criteria.
   * @param collection - The collection to query.
   * @param iterableKey - The key to iterate over.
   * @param value - The value to match (optional).
   * @returns An AsyncIterable of matching Documents.
   */
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

    const keyTree = await this.getOrCreateTree(collection, iterableKey, keyVorm, keyRoot);

    const startKeyBuffer: Buffer | undefined = value !== undefined ? toBuffer(keyVorm, value) : undefined;
    const asyncGenerator = keyTree.iterate(startKeyBuffer);

    const documentGenerator = async function* (this: DbmsBack) {
      for await (const [, documentPointerBuffer] of asyncGenerator) {
        const documentPointer = documentPointerBuffer.readUInt32BE(0);
        const document = await this.recordStore.readRecord(documentPointer);
        if (!document) throw new Error(`Document error: not found`);
        yield document;
      }
    }.bind(this);

    return documentGenerator();
  }

  // ── Public semantic-search API ────────────────────────────────────────────

  /**
   * Perform a semantic (approximate nearest-neighbour) search over the
   * specified collection using the configured embedding model.
   *
   * @param collection - Collection to search in.
   * @param query      - Natural-language query string.
   * @param k          - Number of results to return.
   * @returns Up to `k` Documents ordered by semantic similarity (closest first).
   * @throws If HNSW is not configured.
   */
  async semanticSearch(collection: string, query: string, k: number): Promise<Document[]> {
    if (!this.hnswConfig) throw new Error('Semantic search is not configured (no hnswConfig provided).');

    // If the collection has never had any text documents indexed, return empty.
    if (!(HNSW_META_KEY in this.metaCache) || !(collection in this.metaCache[HNSW_META_KEY])) {
      return [];
    }

    const hnswIdx = await this.getOrCreateHnswIndex(collection);
    const queryVector = await this.hnswConfig.embeddingFn(query);
    const documentLocations = await hnswIdx.search(queryVector, k);

    const results: Document[] = [];
    for (const loc of documentLocations) {
      const doc = await this.recordStore.readRecord(loc);
      if (doc) results.push(doc);
    }
    return results;
  }

  // ── Private HNSW helpers ──────────────────────────────────────────────────

  /**
   * Concatenate all non-`_`-prefixed string field values into a single
   * embeddable text string.  Returns `null` if the document contains no
   * embeddable text.
   */
  private extractText(document: Document): string | null {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(document.getFields())) {
      if (!key.startsWith('_') && typeof value === 'string') {
        parts.push(value);
      }
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }

  /**
   * Return the in-memory HNSW index for `collectionName`, creating it (and
   * its backing FreeBlockFiles) if it does not yet exist.
   */
  private async getOrCreateHnswIndex(collectionName: string): Promise<HNSWIndex> {
    const cached = this.hnswIndexCache.get(collectionName);
    if (cached) return cached;

    const hnswMeta = this.metaCache[HNSW_META_KEY];
    let idx: HNSWIndex;

    if (hnswMeta && collectionName in hnswMeta) {
      // FBF files already exist for this collection — open them.
      idx = await this.openHnswIndex(collectionName);
    } else {
      // First time this collection is seen — create fresh FBF files.
      idx = await this.createHnswIndex(collectionName);
      if (!(HNSW_META_KEY in this.metaCache)) {
        this.metaCache[HNSW_META_KEY] = {};
      }
      this.metaCache[HNSW_META_KEY][collectionName] = [1, 'hnsw'];
    }

    this.hnswIndexCache.set(collectionName, idx);
    return idx;
  }

  /** Create brand-new HNSW FBF files for `collectionName`. */
  private async createHnswIndex(collectionName: string): Promise<HNSWIndex> {
    const cfg = this.hnswConfig!;
    const { dataFile: gData, logFile: gLog } = cfg.fileFactory(collectionName, 'graph');
    const { dataFile: vData, logFile: vLog } = cfg.fileFactory(collectionName, 'vector');

    const graphFbf = new FreeBlockFile(new AtomicFile(gData, gLog), 4096);
    const vectorFbf = new FreeBlockFile(new AtomicFile(vData, vLog), 4096);
    await graphFbf.create();
    await graphFbf.open();
    await vectorFbf.create();
    await vectorFbf.open();

    const M = cfg.M ?? 16;
    const maxStoredLevel = cfg.maxStoredLevel ?? 4;
    const efConstruction = cfg.efConstruction ?? 200;
    const efSearch = cfg.efSearch ?? 50;

    const graphStorage = await HNSWGraphStorage.create(graphFbf, M, maxStoredLevel);
    const vectorHeap = new VectorHeapFile(vectorFbf, cfg.dimension);
    return HNSWIndex.create(graphStorage, vectorHeap, { M, efConstruction, efSearch });
  }

  /** Open existing HNSW FBF files for `collectionName`. */
  private async openHnswIndex(collectionName: string): Promise<HNSWIndex> {
    const cfg = this.hnswConfig!;
    const { dataFile: gData, logFile: gLog } = cfg.fileFactory(collectionName, 'graph');
    const { dataFile: vData, logFile: vLog } = cfg.fileFactory(collectionName, 'vector');

    const graphFbf = new FreeBlockFile(new AtomicFile(gData, gLog), 4096);
    const vectorFbf = new FreeBlockFile(new AtomicFile(vData, vLog), 4096);
    await graphFbf.open();
    await vectorFbf.open();

    const efConstruction = cfg.efConstruction ?? 200;
    const efSearch = cfg.efSearch ?? 50;

    const graphStorage = await HNSWGraphStorage.open(graphFbf);
    const vectorHeap = new VectorHeapFile(vectorFbf, cfg.dimension);
    return HNSWIndex.open(graphStorage, vectorHeap, { efSearch, efConstruction });
  }

  //hulperfuncties voor de meta

  /**
   * Reads the meta information from the database.
   * @returns The meta information as a JSON object.
   */
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

  /**
   * Writes the meta information to the database.
   * @param meta - The meta information to write as a JSON object.
   */
  async metaWriteJSON(meta: Record<string, Record<string, [number, string]>>): Promise<void> {
    // convert meta to binary
    const jsonString = JSON.stringify(meta);
    const binary = Buffer.from(jsonString);
    // Data per block = blockSize - 1 (1 byte reserved for block type)
    const dataPerBlock = this.freeblockFile._getBlockSize() - 1;
    const amountOfBlocks = Math.ceil(binary.length / dataPerBlock);

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
      const start = i * dataPerBlock;
      const end = Math.min(start + dataPerBlock, binary.length);
      const chunk = binary.subarray(start, end);
      await this.freeblockFile.writeBlock(metaBlockIds[i], chunk);
    }
    // write block ids to client area
    const newBinaryBlockIds = Buffer.from(JSON.stringify(metaBlockIds));
    await this.freeblockFile.writeClientArea(newBinaryBlockIds);
  }
}

/**
 * Gets the comparison function for the specified key form.
 * @param form - The key form string.
 * @returns A comparison function for the specified key form.
 */
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

/**
 * Converts the input values to a Buffer according to the specified form.
 * @param vorm - The key form.
 * @param input1 - The first input value.
 * @param input2 - The second input value (optional).
 * @returns The resulting Buffer.
 */
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
