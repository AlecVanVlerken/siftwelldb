// author: Thomas Dumon
// date: 2025-12-07

import { FreeBlockFile, type FreeBlockFileStats } from '../freeblockfile/freeblockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { type File } from '../core/file.mjs';
import { allocateBlock } from '../freeblockfile/freelist.mjs';
import { Document, type FieldValue, isImageField } from '../dbms/document.mjs';
import {
  RecordStore,
  type EncodedDocument,
  type RecordStorageEstimate,
  type RecordWriteOptions,
} from './recordstore.mjs';
import { BPlusTree } from '../btree/btree.mjs';
import { BlockNodeStorage } from '../btree/nodestorage.mjs';
import type { BlockLeafNode } from '../btree/leafnode.mjs';
import type { BlockInternalNode } from '../btree/internalnode.mjs';
import { HNSWIndex, type HnswGraphStructureNode, type HnswGraphStructureSnapshot } from '../hnsw/hnswIndex.mjs';
import { HNSWGraphStorage } from '../hnsw/hnswGraphStorage.mjs';
import { VectorHeapFile } from '../hnsw/vectorHeapFile.mjs';
import {
  COMPRESSION_ALGORITHMS,
  type CompressionAlgorithm,
  type FieldCompressionDefaults,
  type FieldCompressionOverrides,
} from './compression.mjs';
import {
  runIncrementalCompactionUntilTarget as runIncrementalCompactionCycleForSource,
  runIncrementalCompactionStep as runIncrementalCompactionStepForSource,
  vacuumCompactInto as runVacuumCompactInto,
} from '../compaction/compaction.mjs';
import {
  compressionSampleFromValue,
  recommendCompression,
  type CompressionRecommendation,
  type CompressionRecommendationRequest,
  type CompressionSample,
  type CompressionStorageEstimate,
} from './compression-advisor.mjs';
import type { VacuumProgress } from '../compaction/compaction.mjs';
import type {
  HnswRelocationTarget,
  IncrementalCompactionPolicy,
  IncrementalCompactionResult,
  DocumentRelocationResult,
  RelocationOptions,
  RelocationTarget,
} from '../compaction/incrementaltypes.mjs';

/**
 * Optional configuration block that enables per-collection HNSW semantic
 * search inside a `DbmsBack` / `SimpleDbms` instance.
 *
 * When present, every document that contains at least one non-`_`-prefixed
 * string field will have those string values concatenated and embedded into
 * the collection's HNSW index upon insertion.
 *
 * HNSW graph and vector data are stored inside the same single FreeBlockFile
 * as the rest of the database (records + B+ tree indexes), giving one unified
 * WAL domain and fully atomic commits.
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
   * Optional async function that converts raw image bytes (JPEG/PNG/WebP)
   * into a float32 embedding vector.  When provided, document fields whose
   * names end in `.jpeg`, `.jpg`, `.png` or `.webp` are automatically
   * embedded with this function at insert time.  Must produce vectors of
   * the **same** `dimension` as `embeddingFn` (e.g. both sides of a CLIP
   * model) so that text-to-image semantic search works.
   */
  imageEmbeddingFn?: (imageData: Buffer) => Promise<Float32Array>;
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
const COMPRESSION_META_KEY = '__compression__';
const RESERVED_META_KEYS = new Set([HNSW_META_KEY, COMPRESSION_META_KEY]);
const SUPPORTED_COMPRESSION_ALGORITHMS: Set<CompressionAlgorithm> = new Set(COMPRESSION_ALGORITHMS);

type CachedTree = {
  storage: BlockNodeStorage;
  tree: BPlusTree<Buffer, Buffer, BlockLeafNode, BlockInternalNode>;
};

type MetaCache = Record<string, unknown>;
type CompressionStorageTotals = Map<CompressionAlgorithm, CompressionStorageEstimate>;

/**
 * DbmsBack class
 *
 * Provides low-level operations for managing the database backend,
 * including document insertion, retrieval, deletion, and cursor-based iteration.
 */
export class DbmsBack {
  private freeblockFile: FreeBlockFile;
  private recordStore: RecordStore;
  private metaCache: MetaCache = {};

  private dataFile: File;
  private logFile: File;
  private atomicFile: AtomicFile;

  // Cache for BlockNodeStorage instances: key = "collection:field"
  private storageCache: Map<string, BlockNodeStorage> = new Map();

  // Cache for B+ trees: key = "collection:field"
  private treeCache: Map<string, CachedTree> = new Map();

  // HNSW fields
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
    if (hnswConfig) {
      try {
        for (const col of Object.keys(dbmsback.getHnswMeta())) {
          const idx = await dbmsback.openHnswIndex(col);
          dbmsback.hnswIndexCache.set(col, idx);
        }
      } catch (err) {
        // Stored HNSW parameters don't match current config (e.g. DB was created
        // with different dimensions or M). Disable HNSW for this session so the
        // DB can still be opened for non-semantic operations.
        console.warn(
          'HNSW index could not be opened, semantic search disabled:',
          err instanceof Error ? err.message : err,
        );
        dbmsback.hnswConfig = undefined;
        dbmsback.hnswIndexCache.clear();
      }
    }

    return dbmsback;
  }

  /**
   * Retrieves a list of all collection names in the database.
   * @returns A Promise that resolves to an array of collection names.
   */
  getCollections(): Promise<string[]> {
    const keys = Object.keys(this.metaCache).filter((k) => !k.startsWith('__'));
    return Promise.resolve(keys);
  }

  /**
   * Deletes an entire collection from the database.
   * Frees records, B+ tree nodes, and HNSW storage owned by the collection,
   * then removes collection metadata.
   * @param collection - The name of the collection to delete.
   */
  async deleteCollection(collection: string): Promise<void> {
    if (!this.hasCollectionMeta(collection)) {
      throw new Error(`Collection "${collection}" does not exist`);
    }

    const collectionMeta = { ...this.getCollectionMeta(collection) };

    const hnswMeta = this.getExistingHnswMeta();
    if (hnswMeta && collection in hnswMeta) {
      if (!this.hnswConfig) {
        throw new Error(`Cannot fully delete HNSW-backed collection "${collection}" without hnswConfig`);
      }

      const hnswIdx = await this.getOrCreateHnswIndex(collection);
      await hnswIdx.dropStorage();
      delete hnswMeta[collection];
      if (Object.keys(hnswMeta).length === 0) {
        delete this.metaCache[HNSW_META_KEY];
      }
    }

    const recordPointers = new Set<number>();
    const idMeta = collectionMeta['id'];
    if (idMeta) {
      const [rootBlock, vorm] = idMeta;
      const idTree = await this.getOrCreateTree(collection, 'id', vorm, rootBlock);
      for await (const [, pointerBuffer] of idTree.iterate()) {
        recordPointers.add(pointerBuffer.readUInt32BE(0));
      }
    }

    for (const pointer of recordPointers) {
      await this.recordStore.deleteRecord(pointer);
    }

    const btreeBlocks = new Set<number>();
    for (const [field, [rootBlock, vorm]] of Object.entries(collectionMeta)) {
      const storage = this.getOrCreateStorage(collection, field, vorm);
      const locations = await storage.listNodeBlocks(rootBlock);
      for (const location of locations) {
        btreeBlocks.add(location.blockNumber);
      }
    }

    for (const blockNumber of [...btreeBlocks].sort((a, b) => b - a)) {
      await this.freeblockFile.freeBlock(blockNumber);
    }

    delete this.metaCache[collection];

    const compressionMetaRaw = this.metaCache[COMPRESSION_META_KEY];
    if (compressionMetaRaw && typeof compressionMetaRaw === 'object' && !Array.isArray(compressionMetaRaw)) {
      delete (compressionMetaRaw as Record<string, unknown>)[collection];
      if (Object.keys(compressionMetaRaw as Record<string, unknown>).length === 0) {
        delete this.metaCache[COMPRESSION_META_KEY];
      }
    }

    this.clearCollectionCaches(collection);
  }

  private clearCollectionCaches(collection: string): void {
    for (const [key, storage] of [...this.storageCache.entries()]) {
      if (key.startsWith(`${collection}:`)) {
        storage.dispose();
        this.storageCache.delete(key);
      }
    }
    for (const key of [...this.treeCache.keys()]) {
      if (key.startsWith(`${collection}:`)) {
        this.treeCache.delete(key);
      }
    }
    this.hnswIndexCache.delete(collection);
  }

  /**
   * Closes the database backend.
   * @returns A Promise that resolves when the database backend is closed.
   */
  async close(): Promise<void> {
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

  private getCollectionMeta(collection: string): Record<string, [number, string]> {
    const raw = this.metaCache[collection];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, [number, string]>;
    }
    const created: Record<string, [number, string]> = {};
    this.metaCache[collection] = created;
    return created;
  }

  private hasCollectionMeta(collection: string): boolean {
    if (RESERVED_META_KEYS.has(collection)) return false;
    const raw = this.metaCache[collection];
    return !!raw && typeof raw === 'object' && !Array.isArray(raw);
  }

  private getHnswMeta(): Record<string, [number, string]> {
    const raw = this.metaCache[HNSW_META_KEY];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, [number, string]>;
    }
    const created: Record<string, [number, string]> = {};
    this.metaCache[HNSW_META_KEY] = created;
    return created;
  }

  private getExistingHnswMeta(): Record<string, [number, string]> | null {
    const raw = this.metaCache[HNSW_META_KEY];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, [number, string]>;
    }
    return null;
  }

  private getCompressionMeta(): Record<string, FieldCompressionDefaults> {
    const raw = this.metaCache[COMPRESSION_META_KEY];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, FieldCompressionDefaults>;
    }
    const created: Record<string, FieldCompressionDefaults> = {};
    this.metaCache[COMPRESSION_META_KEY] = created;
    return created;
  }

  private getCompressionDefaults(collection: string): FieldCompressionDefaults {
    const compressionMeta = this.getCompressionMeta();
    return compressionMeta[collection] ?? {};
  }

  setFieldCompressionDefaults(collection: string, defaults: FieldCompressionDefaults): void {
    for (const algorithm of Object.values(defaults)) {
      if (!SUPPORTED_COMPRESSION_ALGORITHMS.has(algorithm)) {
        throw new Error(`Unsupported compression algorithm: ${algorithm}`);
      }
    }
    const compressionMeta = this.getCompressionMeta();
    compressionMeta[collection] = { ...defaults };
  }

  getFieldCompressionDefaults(collection: string): FieldCompressionDefaults {
    return { ...this.getCompressionDefaults(collection) };
  }

  private createCompressionStorageEstimate(): CompressionStorageEstimate {
    return {
      samples: 0,
      rawSerializedBytes: 0,
      compressedSerializedBytes: 0,
      rawBlocks: 0,
      compressedBlocks: 0,
      blocksSaved: 0,
      allocatedBytesSaved: 0,
      readAmplification: 1,
      writeCost: 0,
    };
  }

  private ensureCompressionStorageTotal(
    totals: CompressionStorageTotals,
    algorithm: CompressionAlgorithm,
  ): CompressionStorageEstimate {
    const existing = totals.get(algorithm);
    if (existing) return existing;

    const created = this.createCompressionStorageEstimate();
    totals.set(algorithm, created);
    return created;
  }

  private addCompressionStorageTotals(
    totals: CompressionStorageTotals,
    algorithm: CompressionAlgorithm,
    rawEstimate: RecordStorageEstimate,
    candidateEstimate: RecordStorageEstimate,
  ): void {
    const total = this.ensureCompressionStorageTotal(totals, algorithm);
    total.samples++;
    total.rawSerializedBytes += rawEstimate.serializedBytes;
    total.compressedSerializedBytes += candidateEstimate.serializedBytes;
    total.rawBlocks += rawEstimate.blocks;
    total.compressedBlocks += candidateEstimate.blocks;
    total.blocksSaved += rawEstimate.blocks - candidateEstimate.blocks;
    total.allocatedBytesSaved += rawEstimate.allocatedBytes - candidateEstimate.allocatedBytes;
  }

  private estimateCompressionStorageForDocument(
    totals: CompressionStorageTotals,
    document: Document,
    field: string,
    compressionDefaults: FieldCompressionDefaults,
  ): Pick<RecordStorageEstimate, 'blockSize' | 'dataBytesPerBlock'> {
    const rawEstimate = this.recordStore.estimateRecordStorage(document, {
      compressionDefaults,
      compressionOverrides: { [field]: 'off' },
    });

    for (const algorithm of COMPRESSION_ALGORITHMS) {
      const candidateEstimate = this.recordStore.estimateRecordStorage(document, {
        compressionDefaults,
        compressionOverrides: { [field]: algorithm === 'none' ? 'off' : algorithm },
      });
      this.addCompressionStorageTotals(totals, algorithm, rawEstimate, candidateEstimate);
    }

    return {
      blockSize: rawEstimate.blockSize,
      dataBytesPerBlock: rawEstimate.dataBytesPerBlock,
    };
  }

  private finalizeCompressionStorageEstimates(
    totals: CompressionStorageTotals,
  ): Partial<Record<CompressionAlgorithm, CompressionStorageEstimate>> {
    const estimates: Partial<Record<CompressionAlgorithm, CompressionStorageEstimate>> = {};

    for (const [algorithm, total] of totals) {
      estimates[algorithm] = {
        ...total,
        readAmplification: total.rawBlocks === 0 ? 1 : total.compressedBlocks / total.rawBlocks,
      };
    }

    return estimates;
  }

  private draftDocumentForCompressionEstimate(
    request: CompressionRecommendationRequest,
    sample: CompressionSample,
  ): Document {
    const value: FieldValue =
      sample.kind === 'text' ? (request.draftValue ?? sample.raw.toString('utf-8')) : sample.raw;
    const entry: [string, FieldValue] = [request.field, value];

    if (request.field.startsWith('_') || isImageField(request.field)) {
      return new Document(request.collection, '__draft__', [], [entry]);
    }

    return new Document(request.collection, '__draft__', [entry], []);
  }

  async recommendCompression(request: CompressionRecommendationRequest): Promise<CompressionRecommendation> {
    const sampleLimit = Math.max(1, Math.floor(request.sampleSize ?? 50));
    const samples: CompressionSample[] = [];
    const storageTotals: CompressionStorageTotals = new Map();
    let documentsScanned = 0;
    let fieldPresenceCount = 0;
    let blockSize: number | undefined;
    let dataBytesPerBlock: number | undefined;
    const collectionExists = this.hasCollectionMeta(request.collection);
    const compressionDefaults = collectionExists ? this.getCompressionDefaults(request.collection) : {};

    if (collectionExists) {
      const cursor = await this.cursor(request.collection, 'id');
      for await (const document of cursor) {
        documentsScanned++;
        const fieldValue = document.getFields()[request.field];
        if (fieldValue !== undefined) {
          fieldPresenceCount++;
          const sample = compressionSampleFromValue(request.field, fieldValue);
          if (sample) {
            samples.push(sample);
          }

          const estimateShape = this.estimateCompressionStorageForDocument(
            storageTotals,
            document,
            request.field,
            compressionDefaults,
          );
          blockSize = estimateShape.blockSize;
          dataBytesPerBlock = estimateShape.dataBytesPerBlock;
        }
        if (documentsScanned >= sampleLimit) break;
      }
    }

    let draftValueUsed = false;
    if (request.draftValue !== undefined && request.draftValue !== '') {
      const draftSample = compressionSampleFromValue(request.field, request.draftValue);
      if (draftSample) {
        samples.push(draftSample);
        draftValueUsed = true;
        const draftDocument = this.draftDocumentForCompressionEstimate(request, draftSample);
        const estimateShape = this.estimateCompressionStorageForDocument(
          storageTotals,
          draftDocument,
          request.field,
          compressionDefaults,
        );
        blockSize = estimateShape.blockSize;
        dataBytesPerBlock = estimateShape.dataBytesPerBlock;
      }
    }

    return recommendCompression({
      request,
      samples,
      documentsScanned,
      fieldPresenceCount,
      draftValueUsed,
      storageEstimates: this.finalizeCompressionStorageEstimates(storageTotals),
      blockSize,
      dataBytesPerBlock,
    });
  }

  /**
   * Commits all changes to the database.
   * A single commit atomically flushes records, B+ tree indexes, HNSW graph
   * nodes, and HNSW vector data — they all share the same FreeBlockFile WAL.
   * @returns A Promise that resolves when the commit is complete.
   */
  async commit(): Promise<void> {
    // Flush all dirty B+tree nodes to the FBF dirty-block cache before committing.
    for (const storage of this.storageCache.values()) {
      await storage.flushDirtyNodes();
    }
    await this.metaWriteJSON(this.metaCache);
    await this.freeblockFile.commit();
  }

  /**
   * Inserts a Document into the database.
   * @param document - The Document to insert.
   * @returns A Promise that resolves when the document is inserted.
   */
  async insertDocument(
    document: Document,
    compressionOverrides?: FieldCompressionOverrides,
    options?: { skipSemanticIndex?: boolean },
  ): Promise<void> {
    const collectionName = document.getCollectionName(); //constant time
    const writeOptions: RecordWriteOptions = {
      compressionDefaults: this.getCompressionDefaults(collectionName),
      compressionOverrides,
    };
    const documentLocation = await this.recordStore.writeRecord(document, writeOptions); //constant time
    const documentId = document.getId(); //constant time
    let vorm = 'S'; //constant time
    if (typeof documentId === 'number') {
      vorm = 'N'; //constant time
    }
    // check if collection exists in meta, anders toevoegen
    const collectionMeta = this.getCollectionMeta(collectionName);
    // voeg document-pointer toe aan id B+ tree

    // ga naar root voor id
    let idTree: BPlusTree<Buffer, Buffer, BlockLeafNode, BlockInternalNode>; // constant time
    if (!('id' in collectionMeta)) {
      // maak nieuwe B+ tree voor id aan en update meta
      const storage = this.getOrCreateStorage(collectionName, 'id', vorm);
      idTree = await BPlusTree.create(storage);
      const newIdRoot = idTree.getRoot().getBlockNumber();
      collectionMeta['id'] = [newIdRoot, vorm];
      // Cache the newly created tree
      this.treeCache.set(`${collectionName}:id`, { storage, tree: idTree });
    } else {
      const idRoot = collectionMeta['id'][0];
      idTree = await this.getOrCreateTree(collectionName, 'id', vorm, idRoot);
    }

    // BPLUSTREE INSERT (IDROOT, (documentLocation, documentId ) : documentPointer)
    const idBuffer = toBuffer(vorm, documentId); //constant time
    const valueBuffer = Buffer.alloc(4); // 32-bit block number
    valueBuffer.writeUInt32BE(documentLocation, 0);
    await idTree.insert(idBuffer, valueBuffer);
    collectionMeta['id'][0] = idTree.getRoot().getBlockNumber();
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
      if (!(key in collectionMeta)) {
        // maak nieuwe B+ tree voor deze key aan en update meta
        const storage = this.getOrCreateStorage(collectionName, key, keyVorm);
        keyTree = await BPlusTree.create(storage);
        const newKeyRoot = keyTree.getRoot().getBlockNumber();
        collectionMeta[key] = [newKeyRoot, keyVorm];
        // Cache the newly created tree
        this.treeCache.set(`${collectionName}:${key}`, { storage, tree: keyTree });
      } else {
        // load de B+ tree van de juiste collectie -> pointer naar de root
        const keyRoot = collectionMeta[key][0];
        keyTree = await this.getOrCreateTree(collectionName, key, keyVorm, keyRoot);
      }

      const keyBuffer = toBuffer(keyVorm, convertedKeyValue, documentId);
      const valueBuffer = Buffer.alloc(4);
      valueBuffer.writeUInt32BE(documentLocation, 0);
      await keyTree.insert(keyBuffer, valueBuffer);
      collectionMeta[key][0] = keyTree.getRoot().getBlockNumber();
    }
    // END FOR LOOP

    // HNSW: embed and index the document (image or text) if HNSW is configured.
    if (this.hnswConfig && !options?.skipSemanticIndex) {
      const imageData = this.extractImageData(document);
      if (imageData !== null && this.hnswConfig.imageEmbeddingFn) {
        // Document contains an image field — embed with the image encoder.
        const hnswIdx = await this.getOrCreateHnswIndex(collectionName);
        const vector = await this.hnswConfig.imageEmbeddingFn(imageData);
        await hnswIdx.insert(documentLocation, vector);
      } else {
        // Fall back to text embedding for non-image documents.
        const text = this.extractText(document);
        if (text !== null) {
          const hnswIdx = await this.getOrCreateHnswIndex(collectionName);
          const vector = await this.hnswConfig.embeddingFn(text);
          await hnswIdx.insert(documentLocation, vector);
        }
      }
    }

    // Note: metaWriteJSON is called in commit() to batch writes
  }

  /**
   * Retrieves a document from the database.
   * @param documentId - The ID of the document to retrieve.
   * @param collection - The collection to retrieve the document from.
   * @returns A Promise that resolves to the retrieved Document.
   */
  async getDocument(
    documentId: number | string,
    collection: string,
    encoded = false,
  ): Promise<Document | EncodedDocument> {
    // ga naar root voor id
    if (!this.hasCollectionMeta(collection)) {
      throw new Error('Collection does not exist');
    }
    const collectionMeta = this.getCollectionMeta(collection);
    if (!('id' in collectionMeta)) {
      throw new Error('No document with given id exists');
    }
    const metaData = collectionMeta['id'];
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
    const document = encoded
      ? await this.recordStore.readRecordEncoded(documentPointer)
      : await this.recordStore.readRecord(documentPointer);
    if (!document) {
      throw new Error('Document not found');
    }
    return document;
  }

  /**
   * Deletes a document from the database.
   * @param documentId - The ID of the document to delete.
   * @param collection - The collection to delete the document from.
   */
  async deleteDocument(documentId: number | string, collection: string): Promise<void> {
    // Check if collection exists
    if (!this.hasCollectionMeta(collection)) {
      throw new Error('Collection does not exist');
    }
    const collectionMeta = this.getCollectionMeta(collection);
    if (!('id' in collectionMeta)) {
      throw new Error('No document with given id exists');
    }

    // First, get the document pointer from the id tree before deleting
    const metaData = collectionMeta['id'];
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

    const hnswMeta = this.getExistingHnswMeta();
    const collectionHasHnsw = hnswMeta !== null && collection in hnswMeta;
    if (collectionHasHnsw && !this.hnswConfig) {
      throw new Error(`Cannot delete from HNSW-backed collection "${collection}" without hnswConfig`);
    }

    // Delete from id B+ tree
    await idTree.delete(idBuffer);
    metaData[0] = idTree.getRoot().getBlockNumber();

    // Delete from all iterable key trees
    for (const key of iterableKeys) {
      if (!(key in collectionMeta)) {
        throw new Error('Key should exist in meta, but does not');
      }
      // load de B+ tree van de juiste collectie -> pointer naar de root
      const keyMetaData = collectionMeta[key];
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

    let retainedRecordForSemanticTombstone = false;

    if (collectionHasHnsw) {
      const hnswIdx = await this.getOrCreateHnswIndex(collection);
      retainedRecordForSemanticTombstone = await hnswIdx.delete(documentPointer);
    }

    // HNSW currently uses physical record pointers as semantic doc ids. When a
    // semantic entry is tombstoned, keep its record chain allocated as the
    // durable identity anchor so RecordStore cannot reuse that pointer for a
    // later live document in the same HNSW collection. The logical DBMS delete
    // has already removed every B+ tree path to the document above.
    if (!retainedRecordForSemanticTombstone) {
      await this.recordStore.deleteRecord(documentPointer);
    }

    // Note: metaWriteJSON is called in commit() to batch writes
  }

  /**
   * HNSW tombstone primitive.
   *
   * This marks the existing semantic entry for a logical document as deleted
   * inside the HNSW index while leaving the logical document and its regular
   * B+ tree entries untouched. Normal deleteDocument() uses the same HNSWIndex
   * tombstone primitive after removing logical B+ tree entries.
   */
  async tombstoneSemanticEntry(documentId: number | string, collection: string): Promise<boolean> {
    if (!this.hnswConfig) {
      throw new Error('Cannot tombstone semantic entry without hnswConfig');
    }

    const hnswMeta = this.getExistingHnswMeta();
    if (!hnswMeta || !(collection in hnswMeta)) return false;

    const collectionMeta = this.getCollectionMeta(collection);
    const metaData = collectionMeta['id'];
    if (metaData === undefined) {
      throw new Error('No document with given id exists');
    }

    const idBuffer = toBuffer(metaData[1], documentId);
    const idTree = await this.getOrCreateTree(collection, 'id', metaData[1], metaData[0]);
    const documentPointerBuffer = await idTree.get(idBuffer);
    if (!documentPointerBuffer) {
      throw new Error('Document not found');
    }

    const documentPointer = documentPointerBuffer.readUInt32BE(0);
    const hnswIdx = await this.getOrCreateHnswIndex(collection);
    return await hnswIdx.tombstone(documentPointer);
  }

  /**
   * Ensure a collection has a clean HNSW metadata/index container.
   *
   * Full vacuum rebuilds semantic indexes from live logical documents only.
   * When an HNSW-backed source collection has no live semantic documents left,
   * no copied insert will naturally create target HNSW metadata. This helper
   * creates an empty live-only index so the rebuilt target preserves the
   * collection's semantic capability without carrying source tombstones over.
   */
  async ensureHnswCollection(collection: string): Promise<void> {
    if (!this.hnswConfig) {
      throw new Error('Cannot ensure HNSW collection without hnswConfig');
    }

    await this.getOrCreateHnswIndex(collection);
  }

  /**
   * Relocate one live logical document to a fresh RecordStore chain.
   *
   * This is the first structure-aware primitive used by incremental
   * compaction. The logical document stays unchanged, while every DBMS-level
   * pointer to its record chain is updated from the old block id to the new
   * block id before the old chain is freed.
   *
   * @param collection - Collection containing the document.
   * @param id - Logical document id.
   */
  async relocateDocument(
    collection: string,
    id: string | number,
    options: RelocationOptions = {},
  ): Promise<DocumentRelocationResult> {
    const {
      collectionMeta,
      pointer: oldPointer,
      idTree,
      idBuffer,
      idMetaData,
    } = await this.findDocumentPointer(collection, id);

    const document = await this.recordStore.readRecord(oldPointer);
    if (!document) {
      throw new Error('Document not found in record store');
    }

    const encodedDocument = await this.recordStore.readRecordEncoded(oldPointer);
    if (!encodedDocument) {
      throw new Error('Encoded document not found in record store');
    }

    const newPointer =
      options.maxBlockExclusive === undefined
        ? await this.recordStore.writeRecordEncoded(encodedDocument)
        : await this.recordStore.writeRecordEncodedBelow(encodedDocument, {
            maxBlockExclusive: options.maxBlockExclusive,
          });
    if (newPointer === null) {
      return {
        oldBlockNumber: oldPointer,
        newBlockNumber: oldPointer,
        relocated: false,
      };
    }
    const newPointerBuffer = this.recordPointerBuffer(newPointer);

    if (!(await idTree.update(idBuffer, newPointerBuffer))) {
      throw new Error('Failed to update id index during document relocation');
    }
    idMetaData[0] = idTree.getRoot().getBlockNumber();

    for (const key of document.getIterableKeys()) {
      if (!(key in collectionMeta)) {
        throw new Error('Key should exist in meta, but does not');
      }
      const keyMetaData = collectionMeta[key];
      const keyRoot = keyMetaData[0];
      const keyVorm = keyMetaData[1];
      const keyValue = document.getFields()[key];
      const keyTree = await this.getOrCreateTree(collection, key, keyVorm, keyRoot);
      const keyBuffer = this.secondaryIndexKeyBuffer(keyVorm, keyValue, id);
      if (!(await keyTree.update(keyBuffer, newPointerBuffer))) {
        throw new Error(`Failed to update secondary index "${key}" during document relocation`);
      }
      keyMetaData[0] = keyTree.getRoot().getBlockNumber();
    }

    await this.relocateHnswDocumentPointer(collection, oldPointer, newPointer);
    await this.recordStore.deleteRecord(oldPointer);

    return {
      oldBlockNumber: oldPointer,
      newBlockNumber: newPointer,
      relocated: options.maxBlockExclusive === undefined ? newPointer !== oldPointer : newPointer < oldPointer,
    };
  }

  /**
   * Relocate one B+ tree node belonging to a collection index.
   *
   * DbmsBack validates collection/index metadata and keeps the cached tree root
   * in sync, while BlockNodeStorage owns the structure-specific relocation.
   *
   * @param collection - Collection containing the index.
   * @param field - Indexed field name, including "id".
   * @param blockNumber - Existing B+ tree node block to relocate.
   * @returns The fresh block number containing the relocated node.
   */
  async relocateBtreeNode(
    collection: string,
    field: string,
    blockNumber: number,
    options: RelocationOptions = {},
  ): Promise<number> {
    if (!this.hasCollectionMeta(collection)) {
      throw new Error('Collection does not exist');
    }

    const collectionMeta = this.getCollectionMeta(collection);
    const fieldMeta = collectionMeta[field];
    if (!fieldMeta) {
      throw new Error(`B+ tree index "${field}" does not exist`);
    }

    const [rootBlock, vorm] = fieldMeta;
    const storage = this.getOrCreateStorage(collection, field, vorm);
    const result = await storage.relocateNode(rootBlock, blockNumber, options);
    fieldMeta[0] = result.newRootBlock;
    this.treeCache.delete(`${collection}:${field}`);
    return result.newBlockNumber;
  }

  async listHnswRelocationTargets(collection: string): Promise<HnswRelocationTarget[]> {
    if (!this.hnswConfig) {
      throw new Error('Cannot inspect HNSW relocation targets without hnswConfig');
    }

    const hnswMeta = this.getExistingHnswMeta();
    if (!hnswMeta || !(collection in hnswMeta)) {
      return [];
    }

    const hnswIdx = await this.getOrCreateHnswIndex(collection);
    const [metaBlock] = hnswMeta[collection];
    const targets: HnswRelocationTarget[] = [
      {
        collection,
        kind: 'hnsw-meta',
        blockNumber: metaBlock,
        hnswUnitState: 'live',
      },
    ];
    targets.push(
      ...(await hnswIdx.listRelocationTargets()).map((target) => ({
        collection,
        kind: target.kind,
        nodeId: target.nodeId,
        blockNumber: target.blockNumber,
        hnswUnitState: target.hnswUnitState,
      })),
    );
    return targets;
  }

  async inspectHnswGraphStructure(collection: string): Promise<HnswGraphStructureNode[]> {
    return (await this.inspectHnswGraphStructureSnapshot(collection)).nodes;
  }

  async inspectHnswGraphStructureSnapshot(collection: string): Promise<HnswGraphStructureSnapshot> {
    if (!this.hnswConfig) {
      throw new Error('Cannot inspect HNSW graph structure without hnswConfig');
    }

    const hnswMeta = this.getExistingHnswMeta();
    if (!hnswMeta || !(collection in hnswMeta)) {
      throw new Error('HNSW index does not exist for collection');
    }

    return await (await this.getOrCreateHnswIndex(collection)).inspectGraphStructureSnapshot();
  }

  async relocateHnswUnit(target: HnswRelocationTarget): Promise<boolean> {
    if (!this.hnswConfig) {
      throw new Error('Cannot relocate HNSW unit without hnswConfig');
    }

    const hnswMeta = this.getExistingHnswMeta();
    if (!hnswMeta || !(target.collection in hnswMeta)) {
      throw new Error('HNSW index does not exist for collection');
    }

    const hnswIdx = await this.getOrCreateHnswIndex(target.collection);
    if (target.kind === 'hnsw-meta') {
      const [oldBlockNumber, vorm] = hnswMeta[target.collection];
      const newBlockNumber = await hnswIdx.relocateMetadata({ maxBlockExclusive: target.maxBlockExclusive });
      if (newBlockNumber === null) return false;
      hnswMeta[target.collection] = [newBlockNumber, vorm];
      return target.maxBlockExclusive === undefined
        ? newBlockNumber !== oldBlockNumber
        : newBlockNumber < oldBlockNumber;
    }

    const nodeId = await this.resolveHnswRelocationNodeId(target);
    if (target.kind === 'hnsw-graph') {
      const newNodeId = await hnswIdx.relocateGraphNode(nodeId, { maxBlockExclusive: target.maxBlockExclusive });
      const newBlockNumber = Math.floor(newNodeId / 4294967296);
      return (
        target.maxBlockExclusive === undefined ||
        target.blockNumber === undefined ||
        newBlockNumber < target.blockNumber
      );
    }

    const newPtr = await hnswIdx.relocateVectorForNode(nodeId, { maxBlockExclusive: target.maxBlockExclusive });
    return (
      target.maxBlockExclusive === undefined || target.blockNumber === undefined || newPtr.pageId < target.blockNumber
    );
  }

  async trimFreeTail(): Promise<number> {
    await this.commit();
    const result = await this.freeblockFile.trimFreeTail();
    return result.removedBlocks;
  }

  async getCompactionStorageStats(): Promise<FreeBlockFileStats> {
    return await this.freeblockFile.getStats();
  }

  async runIncrementalCompactionStep(policy?: IncrementalCompactionPolicy): Promise<IncrementalCompactionResult> {
    return await runIncrementalCompactionStepForSource(this, policy);
  }

  async compactIfNeeded(policy?: IncrementalCompactionPolicy): Promise<IncrementalCompactionResult | null> {
    const result = await runIncrementalCompactionCycleForSource(this, policy);
    return result.didWork || result.blocked === true ? result : null;
  }

  async listRecordRelocationTargets(limit = 16): Promise<RelocationTarget[]> {
    const targets: RelocationTarget[] = [];

    for (const collection of await this.getCollections()) {
      if (!this.hasCollectionMeta(collection)) continue;
      const collectionMeta = this.getCollectionMeta(collection);
      const idMeta = collectionMeta['id'];
      if (!idMeta) continue;

      const [root, vorm] = idMeta;
      const idTree = await this.getOrCreateTree(collection, 'id', vorm, root);
      for await (const [, pointerBuffer] of idTree.iterate()) {
        const blockNumber = pointerBuffer.readUInt32BE(0);
        const document = await this.recordStore.readRecord(blockNumber);
        if (!document) continue;
        const chain = await this.recordStore.readRecordBlockChain(blockNumber);
        targets.push({
          kind: 'record',
          collection,
          documentId: document.getId(),
          blockNumber: Math.max(...chain),
        });
      }
    }

    return targets.sort((a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0)).slice(0, Math.max(0, limit));
  }

  async listBtreeRelocationTargets(limit = 16): Promise<RelocationTarget[]> {
    const targets: RelocationTarget[] = [];

    for (const [collection, collectionMeta] of Object.entries(this.getVacuumCollectionMetaSnapshot())) {
      for (const [field, [rootBlock, vorm]] of Object.entries(collectionMeta)) {
        const storage = this.getOrCreateStorage(collection, field, vorm);
        const locations = await storage.listNodeBlocks(rootBlock);
        for (const location of locations) {
          targets.push({
            kind: location.kind,
            collection,
            field,
            blockNumber: location.blockNumber,
          });
        }
      }
    }

    return targets.sort((a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0)).slice(0, Math.max(0, limit));
  }

  async listHnswRelocationCandidateTargets(limit = 16): Promise<RelocationTarget[]> {
    if (!this.hnswConfig) {
      return [];
    }

    const hnswMeta = this.getExistingHnswMeta();
    if (!hnswMeta) {
      return [];
    }

    const targets: RelocationTarget[] = [];
    for (const collection of Object.keys(hnswMeta)) {
      for (const target of await this.listHnswRelocationTargets(collection)) {
        targets.push({
          kind: target.kind,
          collection,
          blockNumber: target.blockNumber,
          nodeId: target.nodeId,
          hnswUnitState: target.hnswUnitState,
        });
      }
    }

    return targets.sort((a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0)).slice(0, Math.max(0, limit));
  }

  private async resolveHnswRelocationNodeId(target: HnswRelocationTarget): Promise<number> {
    if (target.kind === 'hnsw-meta') {
      throw new Error('HNSW metadata relocation does not use a node id');
    }
    if (target.nodeId !== undefined) {
      return target.nodeId;
    }
    if (target.blockNumber === undefined) {
      throw new Error('HNSW relocation target requires nodeId or blockNumber');
    }

    const candidates = await this.listHnswRelocationTargets(target.collection);
    const match = candidates.find(
      (candidate) => candidate.kind === target.kind && candidate.blockNumber === target.blockNumber,
    );
    if (!match || match.nodeId === undefined) {
      throw new Error(`No ${target.kind} unit found at block ${target.blockNumber}`);
    }
    return match.nodeId;
  }

  private async findDocumentPointer(
    collection: string,
    id: string | number,
  ): Promise<{
    collectionMeta: Record<string, [number, string]>;
    pointer: number;
    idTree: BPlusTree<Buffer, Buffer, BlockLeafNode, BlockInternalNode>;
    idBuffer: Buffer;
    idMetaData: [number, string];
  }> {
    if (!this.hasCollectionMeta(collection)) {
      throw new Error('Collection does not exist');
    }
    const collectionMeta = this.getCollectionMeta(collection);
    if (!('id' in collectionMeta)) {
      throw new Error('No document with given id exists');
    }

    const idMetaData = collectionMeta['id'];
    const root = idMetaData[0];
    const vorm = idMetaData[1];
    const idBuffer = toBuffer(vorm, id);
    const idTree = await this.getOrCreateTree(collection, 'id', vorm, root);
    const pointerBuffer = await idTree.get(idBuffer);
    if (!pointerBuffer) {
      throw new Error('Document not found');
    }

    return {
      collectionMeta,
      pointer: pointerBuffer.readUInt32BE(0),
      idTree,
      idBuffer,
      idMetaData,
    };
  }

  private recordPointerBuffer(pointer: number): Buffer {
    const valueBuffer = Buffer.alloc(4);
    valueBuffer.writeUInt32BE(pointer, 0);
    return valueBuffer;
  }

  private secondaryIndexKeyBuffer(vorm: string, value: FieldValue, id: string | number): Buffer {
    const convertedValue: string | number | Buffer = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    return toBuffer(vorm, convertedValue, id);
  }

  private async relocateHnswDocumentPointer(collection: string, oldPointer: number, newPointer: number): Promise<void> {
    const hnswMeta = this.getExistingHnswMeta();
    if (!hnswMeta || !(collection in hnswMeta)) return;
    if (!this.hnswConfig) {
      throw new Error('Cannot relocate HNSW-backed document without hnswConfig');
    }

    const hnswIdx = await this.getOrCreateHnswIndex(collection);
    if (!hnswIdx.hasDocument(oldPointer)) return;
    if (!(await hnswIdx.relabelDocument(oldPointer, newPointer))) {
      throw new Error('Failed to relabel HNSW document pointer during document relocation');
    }
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
    const existingDocument = (await this.getDocument(id, collection, false)) as Document;
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
    if (!this.hasCollectionMeta(collection)) {
      throw new Error('Collection does not exist');
    }
    const collectionMeta = this.getCollectionMeta(collection);
    if (!(iterableKey in collectionMeta)) {
      throw new Error('Iterable key does not exist in collection');
    }

    const keyMetaData = collectionMeta[iterableKey];
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

  // **Public semantic-search API**

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
    const hnswMeta = this.getHnswMeta();
    if (!(collection in hnswMeta)) {
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

  /**
   * Perform an image-to-image semantic search: embed a query image with
   * `imageEmbeddingFn` and return the nearest documents.
   *
   * @param collection - Collection to search in.
   * @param queryImage - Raw image bytes (JPEG/PNG/WebP).
   * @param k          - Number of results to return.
   * @returns Up to `k` Documents ordered by similarity (closest first).
   */
  async semanticImageSearch(collection: string, queryImage: Buffer, k: number): Promise<Document[]> {
    if (!this.hnswConfig) throw new Error('Semantic search is not configured (no hnswConfig provided).');
    if (!this.hnswConfig.imageEmbeddingFn) {
      throw new Error('Image search requires imageEmbeddingFn in HnswConfig.');
    }
    const hnswMeta = this.getHnswMeta();
    if (!(collection in hnswMeta)) {
      return [];
    }

    const hnswIdx = await this.getOrCreateHnswIndex(collection);
    const queryVector = await this.hnswConfig.imageEmbeddingFn(queryImage);
    const documentLocations = await hnswIdx.search(queryVector, k);

    const results: Document[] = [];
    for (const loc of documentLocations) {
      const doc = await this.recordStore.readRecord(loc);
      if (doc) results.push(doc);
    }
    return results;
  }

  // Private HNSW helpers

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
   * Extract the raw bytes of the first image field in the document.
   * Returns `null` when the document contains no image fields.
   */
  private extractImageData(document: Document): Buffer | null {
    for (const [key, value] of Object.entries(document.getFields())) {
      if (isImageField(key) && Buffer.isBuffer(value)) {
        return value;
      }
    }
    return null;
  }

  /**
   * Return the in-memory HNSW index for `collectionName`, creating it (and
   * its backing blocks inside the shared FreeBlockFile) if it does not yet
   * exist.
   */
  private async getOrCreateHnswIndex(collectionName: string): Promise<HNSWIndex> {
    const cached = this.hnswIndexCache.get(collectionName);
    if (cached) return cached;

    const hnswMeta = this.getHnswMeta();
    let idx: HNSWIndex;

    if (hnswMeta && collectionName in hnswMeta) {
      // Blocks already exist for this collection — open them.
      idx = await this.openHnswIndex(collectionName);
    } else {
      // First time this collection is seen — allocate blocks and initialise.
      idx = await this.createHnswIndex(collectionName);
    }

    this.hnswIndexCache.set(collectionName, idx);
    return idx;
  }

  /** Create brand-new HNSW structures for `collectionName` inside the shared FBF. */
  private async createHnswIndex(collectionName: string): Promise<HNSWIndex> {
    const cfg = this.hnswConfig!;
    const M = cfg.M ?? 16;
    const maxStoredLevel = cfg.maxStoredLevel ?? 4;
    const efConstruction = cfg.efConstruction ?? 200;
    const efSearch = cfg.efSearch ?? 50;

    // Both graph storage and vector heap live inside the shared FBF.
    const graphStorage = await HNSWGraphStorage.create(this.freeblockFile, M, maxStoredLevel);
    const vectorHeap = new VectorHeapFile(this.freeblockFile, cfg.dimension);

    // Persist the metadata block number so we can reopen on next open().
    this.getHnswMeta()[collectionName] = [graphStorage.metaBlockId, 'hnsw'];

    return HNSWIndex.create(graphStorage, vectorHeap, { M, efConstruction, efSearch });
  }

  /** Open existing HNSW structures for `collectionName` from the shared FBF. */
  private async openHnswIndex(collectionName: string): Promise<HNSWIndex> {
    const cfg = this.hnswConfig!;
    // metaBlockId is stored in [0] of the tuple
    const metaBlockId = this.getHnswMeta()[collectionName][0];

    const efConstruction = cfg.efConstruction ?? 200;
    const efSearch = cfg.efSearch ?? 50;

    const graphStorage = await HNSWGraphStorage.open(this.freeblockFile, metaBlockId);
    const vectorHeap = new VectorHeapFile(this.freeblockFile, cfg.dimension);
    return HNSWIndex.open(graphStorage, vectorHeap, { efSearch, efConstruction });
  }

  /**
   * Return a snapshot of regular collection metadata for the vacuum subsystem.
   */
  getVacuumCollectionMetaSnapshot(): Record<string, Record<string, [number, string]>> {
    const result: Record<string, Record<string, [number, string]>> = {};

    for (const [key, value] of Object.entries(this.metaCache)) {
      if (key === HNSW_META_KEY || key === COMPRESSION_META_KEY) continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const collectionMeta = value as Record<string, [number, string]>;
        const copiedCollectionMeta: Record<string, [number, string]> = {};

        for (const [field, tuple] of Object.entries(collectionMeta)) {
          copiedCollectionMeta[field] = [...tuple] as [number, string];
        }

        result[key] = copiedCollectionMeta;
      }
    }

    return result;
  }

  /**
   * Return a snapshot of compression metadata for the vacuum subsystem.
   */
  getVacuumCompressionMetaSnapshot(): Record<string, FieldCompressionDefaults> {
    const result: Record<string, FieldCompressionDefaults> = {};
    for (const [collection, defaults] of Object.entries(this.getCompressionMeta())) {
      result[collection] = { ...defaults };
    }
    return result;
  }

  /**
   * Return a snapshot of HNSW metadata for the vacuum subsystem.
   */
  getVacuumHnswMetaSnapshot(): Record<string, [number, string]> {
    const result: Record<string, [number, string]> = {};
    for (const [collection, meta] of Object.entries(this.getHnswMeta())) {
      result[collection] = [...meta] as [number, string];
    }
    return result;
  }

  /**
   * Return the runtime HNSW configuration used by the vacuum subsystem.
   */
  getVacuumHnswConfig(): HnswConfig | undefined {
    return this.hnswConfig;
  }

  getVacuumDataFile(): File {
    return this.dataFile;
  }

  getVacuumLogFile(): File {
    return this.logFile;
  }

  /**
   * Rebuild this database into fresh temporary files using full vacuum compaction.
   */
  async vacuumCompactInto(
    tempDataFile: File,
    tempLogFile: File,
    onProgress?: (progress: VacuumProgress) => void,
  ): Promise<DbmsBack> {
    const result = await runVacuumCompactInto({
      source: this,
      tempDataFile,
      tempLogFile,
      validate: true,
      rebuildHnsw: true,
      onProgress,
    });
    return result.target;
  }

  //hulperfuncties voor de meta

  /**
   * Reads the meta information from the database.
   * @returns The meta information as a JSON object.
   */
  async metaReadJSON(): Promise<MetaCache> {
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
    if (!jsonString2) return {};
    return JSON.parse(jsonString2) as MetaCache;
  }

  /**
   * Writes the meta information to the database.
   * @param meta - The meta information to write as a JSON object.
   */
  async metaWriteJSON(meta: MetaCache): Promise<void> {
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

    for (let i = 0; i < amountOfBlocks; i++) {
      const oldBlockId = metaBlockIds[i];
      const lowerBlockId = await this.freeblockFile.allocateBlockBelow(oldBlockId);
      if (lowerBlockId !== null) {
        metaBlockIds[i] = lowerBlockId;
        await this.freeblockFile.freeBlock(oldBlockId);
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
