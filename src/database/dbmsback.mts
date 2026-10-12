// author: Thomas Dumon
// date: 2025-12-07

import {
  FreeBlockFile,
  MutationRecoveryRequiredError,
  type FreeBlockFileStats,
} from '../storage/blocks/freeblockfile.mjs';
import { AtomicFile, RecoveryRequiredError } from '../storage/wal/atomicfile.mjs';
import { BlockReadError } from '../storage/blocks/io.mjs';
import { type File } from '../storage/file.mjs';
import { allocateBlock } from '../storage/blocks/freelist.mjs';
import {
  Document,
  type FieldValue,
  imageMimeForField,
  isImageField,
  supportsFieldIndex,
  validateDocumentId,
  validateDocumentValues,
} from './document.mjs';
import {
  indexCacheKey,
  safeDictionary,
  semanticIndexIdentity,
  semanticIndexKey,
  type SemanticIndexKind,
} from './identity.mjs';
import {
  RecordStore,
  RecordReadError,
  type EncodedDocument,
  type RecordStorageEstimate,
  type RecordWriteOptions,
} from '../storage/records/recordstore.mjs';
import { BPlusTree } from '../indexes/btree/btree.mjs';
import { BlockNodeStorage } from '../indexes/btree/nodestorage.mjs';
import type { BlockLeafNode } from '../indexes/btree/leafnode.mjs';
import type { BlockInternalNode } from '../indexes/btree/internalnode.mjs';
import { HNSWIndex, type HnswGraphStructureNode, type HnswGraphStructureSnapshot } from '../indexes/hnsw/hnswIndex.mjs';
import { HNSWGraphStorage } from '../indexes/hnsw/hnswGraphStorage.mjs';
import { VectorHeapFile, validateVectorDimension } from '../indexes/hnsw/vectorHeapFile.mjs';
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
import { RelocationCandidates } from '../compaction/incremental/relocationcandidates.mjs';
import type {
  HnswRelocationTarget,
  IncrementalCompactionPolicy,
  IncrementalCompactionResult,
  DocumentRelocationResult,
  RelocationOptions,
  RelocationTarget,
} from '../compaction/incremental/incrementaltypes.mjs';

/**
 * Optional configuration block that enables per-collection HNSW semantic
 * search inside a `DbmsBack` / `SimpleDbms` instance.
 *
 * By default this creates one semantic index per collection. Callers can
 * optionally provide `textIndex` and `imageIndex` to maintain two indexes per
 * collection: one for text fields and one for image fields. This allows a
 * text-focused model (e.g. MiniLM, 384d) and a CLIP image model (512d) to
 * coexist without mixing incompatible vector dimensions in one HNSW graph.
 *
 * HNSW graph and vector data are stored inside the same single FreeBlockFile
 * as the rest of the database (records + B+ tree indexes), giving one unified
 * WAL domain and fully atomic commits.
 */
export type HnswIndexConfig = {
  /** Dimensionality of the vectors produced by `embeddingFn`. */
  dimension: number;
  /**
   * Async function that converts a plain-text string into a fixed-size
   * float32 embedding vector — supply any HuggingFace (or other) model here.
   */
  embeddingFn: (text: string) => Promise<Float32Array>;
  /** HNSW M parameter (max neighbours per node). Default: 16. */
  M?: number;
  /** Maximum level stored per node. Default: 4. */
  maxStoredLevel?: number;
  /** ef during index construction. Default: 200. */
  efConstruction?: number;
  /** ef during search. Default: 50. */
  efSearch?: number;
};

export type HnswImageIndexConfig = HnswIndexConfig & {
  /**
   * Async function that converts raw image bytes (JPEG/PNG/WebP) into a
   * vector in the same space as this config's `embeddingFn`.
   */
  imageEmbeddingFn: (imageData: Buffer) => Promise<Float32Array>;
};

export type HnswConfig = HnswIndexConfig & {
  /**
   * Legacy/single-index image encoder. Kept for the demos and callers that use
   * one CLIP index per collection.
   */
  imageEmbeddingFn?: (imageData: Buffer) => Promise<Float32Array>;
  /** Optional dedicated text index config, e.g. MiniLM. */
  textIndex?: HnswIndexConfig;
  /** Optional dedicated image index config, e.g. CLIP text+vision. */
  imageIndex?: HnswImageIndexConfig;
};

/** Reserved metaCache key used to track which collections have an HNSW index. */
const HNSW_META_KEY = '__hnsw__';
const COMPRESSION_META_KEY = '__compression__';
const INDEXING_META_KEY = '__indexing__';
const RESERVED_META_KEYS = new Set([HNSW_META_KEY, COMPRESSION_META_KEY, INDEXING_META_KEY]);
const SUPPORTED_COMPRESSION_ALGORITHMS: Set<CompressionAlgorithm> = new Set(COMPRESSION_ALGORITHMS);

type CachedTree = {
  storage: BlockNodeStorage;
  tree: BPlusTree<Buffer, Buffer, BlockLeafNode, BlockInternalNode>;
};

type MetaCache = Record<string, unknown>;

type HnswMeta = { version: 1; indexes: Record<string, [number, string]> };
type CompressionStorageTotals = Map<CompressionAlgorithm, CompressionStorageEstimate>;
type IndexingMeta = {
  version: 1;
  fields: Record<string, Record<string, boolean>>;
  semanticPending: string[];
};
type SemanticVector = { indexKey: string; vector: Float32Array };
export class IndexValidationError extends Error {}

export class InvalidCursorError extends IndexValidationError {
  constructor(reason: string) {
    super(`Invalid or unsupported cursor: ${reason}`);
  }
}

/** Logical position in the persisted index ordering, independent of record locations. */
export interface IndexCursorPosition {
  form: string;
  key: Buffer;
}

export interface IndexCursorEntry {
  document: Document;
  position: IndexCursorPosition;
}

/**
 * DbmsBack class
 *
 * Provides low-level operations for managing the database backend,
 * including document insertion, retrieval, deletion, and cursor-based iteration.
 */
export class DbmsBack {
  private freeblockFile: FreeBlockFile;
  private recordStore: RecordStore;
  private metaCache: MetaCache = safeDictionary();
  private mutationQueue: Promise<void> = Promise.resolve();
  private mutationStarted = false;
  private preserveRelocationCandidates = false;
  private readonly relocationCandidates = new Map<'record' | 'btree' | 'hnsw', Promise<RelocationCandidates>>();

  assertHealthy(): void {
    this.freeblockFile.assertHealthy();
  }

  get isHealthy(): boolean {
    return this.freeblockFile.isHealthy;
  }

  /** Called only after preflight, immediately before a potentially partial write. */
  private beginMutation(): void {
    this.mutationStarted = true;
    if (!this.preserveRelocationCandidates) this.relocationCandidates.clear();
  }

  private mutate<T>(operation: () => Promise<T>, preserveCandidates = false): Promise<T> {
    const result = this.mutationQueue.then(async () => {
      this.assertHealthy();
      this.mutationStarted = false;
      this.preserveRelocationCandidates = preserveCandidates;
      try {
        return await operation();
      } catch (error) {
        if (this.mutationStarted) {
          this.relocationCandidates.clear();
          this.freeblockFile.markMutationFailed(error);
        }
        try {
          this.assertHealthy();
        } catch (healthError) {
          // WAL failures already carry a recovery gate. Preserve the original
          // I/O failure for this operation; subsequent calls report recovery.
          if (healthError instanceof RecoveryRequiredError) throw error;
          throw healthError;
        }
        throw error;
      } finally {
        this.mutationStarted = false;
        this.preserveRelocationCandidates = false;
      }
    });
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private dataFile: File;
  private logFile: File;

  // Cache keys encode [collection, field] without delimiter ambiguities.
  private storageCache: Map<string, BlockNodeStorage> = new Map();

  // B+ trees use the same exact collection/field identities.
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
    this.freeblockFile = new FreeBlockFile(atomicFile, 4096);
    this.recordStore = new RecordStore(this.freeblockFile);
    this.hnswConfig = hnswConfig;
  }

  /**
   * Creates a new database backend.
   * @returns A Promise that resolves when the database backend is created.
   */
  async create(): Promise<void> {
    this.relocationCandidates.clear();
    await this.freeblockFile.create(); // must be async
    const initialMeta = Buffer.from(JSON.stringify([]));
    await this.freeblockFile.writeClientArea(initialMeta);
    this.metaCache[INDEXING_META_KEY] = {
      version: 1,
      fields: safeDictionary(),
      semanticPending: [],
    } satisfies IndexingMeta;
  }

  /**
   * Opens an existing database backend.
   * @param dataFile - The file to use for storing data.
   * @param logFile - The file to use for logging.
   * @returns A Promise that resolves to the opened DbmsBack instance.
   */
  static async open(dataFile: File, logFile: File, hnswConfig?: HnswConfig): Promise<DbmsBack> {
    const dbmsback = new DbmsBack(dataFile, logFile, hnswConfig);
    try {
      await dbmsback.freeblockFile.open();
      dbmsback.metaCache = await dbmsback.metaReadJSON();
      await dbmsback.normalizeMetadata();
      const migrating = !dbmsback.metaCache[INDEXING_META_KEY];
      await dbmsback.migrateFieldIndexes();
      const pendingBefore = dbmsback.getPendingSemanticCollections().length;

      // Re-open HNSW indices for every collection that was indexed before.
      if (hnswConfig) {
        try {
          for (const indexKey of Object.keys(dbmsback.getHnswMeta())) {
            const idx = await dbmsback.openHnswIndex(indexKey);
            dbmsback.hnswIndexCache.set(indexKey, idx);
          }
        } catch (err) {
          if (err instanceof BlockReadError || err instanceof RecordReadError || err instanceof RecoveryRequiredError)
            throw err;
          // Stored HNSW parameters don't match current config (e.g. DB was created
          // with different dimensions or M). Disable HNSW for this session so the
          // DB can still be opened for non-semantic operations.
          console.warn(
            'HNSW index could not be opened, semantic search disabled:',
            err instanceof Error ? err.message : err,
          );
          dbmsback.hnswConfig = undefined;
          for (const index of dbmsback.hnswIndexCache.values()) index.dispose();
          dbmsback.hnswIndexCache.clear();
        }
      }

      if (dbmsback.hnswConfig) {
        for (const collection of dbmsback.getPendingSemanticCollections()) {
          try {
            await dbmsback.mutate(() => dbmsback.rebuildSemanticCollection(collection));
          } catch (error) {
            if (
              error instanceof BlockReadError ||
              error instanceof RecordReadError ||
              error instanceof MutationRecoveryRequiredError ||
              error instanceof RecoveryRequiredError
            )
              throw error;
            console.warn(
              `Semantic reindex pending for "${collection}":`,
              error instanceof Error ? error.message : error,
            );
          }
        }
      }

      if (migrating || dbmsback.getPendingSemanticCollections().length < pendingBefore) await dbmsback.commit();
      return dbmsback;
    } catch (error) {
      await dbmsback.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Retrieves a list of all collection names in the database.
   * @returns A Promise that resolves to an array of collection names.
   */
  getCollections(): Promise<string[]> {
    this.assertHealthy();
    const keys = Object.keys(this.metaCache).filter((k) => !RESERVED_META_KEYS.has(k));
    return Promise.resolve(keys);
  }

  /**
   * Deletes an entire collection from the database.
   * Frees records, B+ tree nodes, and HNSW storage owned by the collection,
   * then removes collection metadata.
   * @param collection - The name of the collection to delete.
   */
  deleteCollection(collection: string): Promise<void> {
    return this.mutate(() => this.deleteCollectionInternal(collection));
  }

  private async deleteCollectionInternal(collection: string): Promise<void> {
    if (!this.hasCollectionMeta(collection)) {
      throw new Error(`Collection "${collection}" does not exist`);
    }

    const collectionMeta = { ...this.getCollectionMeta(collection) };
    this.beginMutation();

    const hnswMeta = this.getExistingHnswMeta();
    if (hnswMeta) {
      if (!this.hnswConfig) {
        for (const indexKey of this.hnswIndexKeysForCollection(collection, hnswMeta)) {
          console.warn(
            `Removing stale HNSW metadata for "${indexKey}" while deleting collection "${collection}" without active hnswConfig`,
          );
          delete hnswMeta[indexKey];
          this.hnswIndexCache.delete(indexKey);
        }
      } else {
        for (const indexKey of this.hnswIndexKeysForCollection(collection, hnswMeta)) {
          const hnswIdx = await this.getOrCreateHnswIndex(indexKey);
          await hnswIdx.dropStorage();
          hnswIdx.dispose();
          delete hnswMeta[indexKey];
          this.hnswIndexCache.delete(indexKey);
        }
      }
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
      await this.readIndexedDocument(pointer, collection);
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
    delete this.getIndexingMeta().fields[collection];
    this.getIndexingMeta().semanticPending = this.getPendingSemanticCollections().filter((name) => name !== collection);

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
      if ((JSON.parse(key) as [string, string])[0] === collection) {
        storage.dispose();
        this.storageCache.delete(key);
      }
    }
    for (const key of [...this.treeCache.keys()]) {
      if ((JSON.parse(key) as [string, string])[0] === collection) {
        this.treeCache.delete(key);
      }
    }
    for (const indexKey of this.hnswIndexKeysForCollection(collection)) {
      this.hnswIndexCache.get(indexKey)?.dispose();
      this.hnswIndexCache.delete(indexKey);
    }
  }

  /**
   * Closes the database backend.
   * @returns A Promise that resolves when the database backend is closed.
   */
  async close(): Promise<void> {
    await this.mutationQueue;
    this.relocationCandidates.clear();
    for (const index of this.hnswIndexCache.values()) index.dispose();
    this.hnswIndexCache.clear();
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
    const cacheKey = indexCacheKey(collection, field);
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
    const cacheKey = indexCacheKey(collection, field);
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
    if (RESERVED_META_KEYS.has(collection))
      throw new IndexValidationError('This collection name is reserved for database metadata.');
    const raw = this.metaCache[collection];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, [number, string]>;
    }
    const created: Record<string, [number, string]> = safeDictionary();
    this.metaCache[collection] = created;
    return created;
  }

  private hasCollectionMeta(collection: string): boolean {
    if (RESERVED_META_KEYS.has(collection)) return false;
    const raw = this.metaCache[collection];
    return !!raw && typeof raw === 'object' && !Array.isArray(raw);
  }

  /** Rehydrate only user-keyed metadata maps; their JSON representation is unchanged. */
  private async normalizeMetadata(): Promise<void> {
    this.metaCache = safeDictionary(this.metaCache);
    for (const [collection, roots] of Object.entries(this.metaCache)) {
      if (!RESERVED_META_KEYS.has(collection) && roots && typeof roots === 'object' && !Array.isArray(roots)) {
        this.metaCache[collection] = safeDictionary(roots as Record<string, [number, string]>);
      }
    }
    const compression = this.metaCache[COMPRESSION_META_KEY] as Record<string, FieldCompressionDefaults> | undefined;
    if (compression) {
      this.metaCache[COMPRESSION_META_KEY] = safeDictionary(
        Object.fromEntries(
          Object.entries(compression).map(([collection, defaults]) => [collection, safeDictionary(defaults)]),
        ),
      );
    }
    const indexing = this.metaCache[INDEXING_META_KEY] as IndexingMeta | undefined;
    if (indexing) {
      indexing.fields = safeDictionary(
        Object.fromEntries(
          Object.entries(indexing.fields).map(([collection, fields]) => [collection, safeDictionary(fields)]),
        ),
      );
    }
    const raw = this.metaCache[HNSW_META_KEY];
    if (!raw) return;
    const persisted = raw as HnswMeta;
    if (Object.hasOwn(persisted, 'version') && typeof persisted.version === 'number') {
      if (
        persisted.version !== 1 ||
        !persisted.indexes ||
        typeof persisted.indexes !== 'object' ||
        Array.isArray(persisted.indexes)
      ) {
        throw new Error('Unsupported semantic index namespace metadata.');
      }
      persisted.indexes = safeDictionary(persisted.indexes);
      for (const key of Object.keys(persisted.indexes)) semanticIndexIdentity(key);
      return;
    }
    // A suffix may belong to a qualified index or to a literal collection name.
    // Live records with matching primary references establish ownership without
    // decoding vectors. Empty graphs and unverified anchors cannot establish it.
    const indexes: HnswMeta['indexes'] = safeDictionary();
    for (const [key, root] of Object.entries(raw as Record<string, [number, string]>)) {
      const suffix = key.match(/^(.*)::(text|image)$/s);
      let identity = semanticIndexKey(key, 'default');
      if (suffix) {
        const graph = await HNSWGraphStorage.open(this.freeblockFile, root[0]);
        const owners = new Set<string>();
        for await (const node of graph.scanNodes()) {
          if (node.deleted) continue; // Historic tombstone record pointers may have been reused.
          const document = await this.recordStore.readRecord(node.docId);
          if (
            !document ||
            (await this.getDocumentBlockId(document.getCollectionName(), document.getId())) !== node.docId
          )
            throw new Error(
              `Legacy semantic index "${key}" has ambiguous collection ownership; stored data was retained.`,
            );
          owners.add(document.getCollectionName());
        }
        const [owner] = owners;
        if (owners.size !== 1 || (owner !== key && owner !== suffix[1])) {
          throw new Error(
            `Legacy semantic index "${key}" has ambiguous collection ownership; stored data was retained.`,
          );
        }
        identity = owner === key ? identity : semanticIndexKey(owner, suffix[2] as 'text' | 'image');
      }
      indexes[identity] = root;
    }
    this.metaCache[HNSW_META_KEY] = { version: 1, indexes } satisfies HnswMeta;
  }

  private getIndexingMeta(): IndexingMeta {
    return this.metaCache[INDEXING_META_KEY] as IndexingMeta;
  }

  /** Legacy records retain their representation; persisted roots determine their migrated policy. */
  private async migrateFieldIndexes(): Promise<void> {
    if (this.metaCache[INDEXING_META_KEY]) {
      if (this.getIndexingMeta().version !== 1) throw new Error('Unsupported collection indexing metadata version.');
      return;
    }
    const fields: IndexingMeta['fields'] = safeDictionary();
    const missingEntries: Array<{ collection: string; field: string; key: Buffer; pointer: number }> = [];
    const staleEntries: Array<{ collection: string; field: string; key: Buffer }> = [];
    for (const collection of this.listCollections()) {
      const roots = this.getCollectionMeta(collection);
      const config = safeDictionary(Object.fromEntries(Object.keys(roots).map((field) => [field, true])));
      config['id'] = true;
      if (roots['id']) {
        for await (const document of await this.cursor(collection, 'id')) {
          for (const field of Object.keys(document.getFields())) {
            config[field] = Object.hasOwn(roots, field);
            if (!config[field]) continue;
            const value = document.getFields()[field];
            if (this.keyForm(value, document.getId()) !== roots[field][1]) {
              throw new IndexValidationError(
                `Legacy index "${collection}.${field}" has incompatible values; migration cannot safely backfill it.`,
              );
            }
            const [root, form] = roots[field];
            const tree = await this.getOrCreateTree(collection, field, form, root);
            if (typeof value === 'string' && Buffer.byteLength(value) > 65535)
              this.validateIndexValue(field, value, document.getId());
            const key = this.secondaryIndexKeyBuffer(form, value, document.getId());
            const existing = await tree.get(key);
            const pointer = (await this.getDocumentBlockId(collection, document.getId()))!;
            if (existing === null || existing.readUInt32BE(0) !== pointer) {
              this.validateIndexValue(field, value, document.getId());
              missingEntries.push({ collection, field, key, pointer });
            }
          }
        }
      }
      for (const [field, [root, form]] of Object.entries(roots)) {
        if (field === 'id') continue;
        const tree = await this.getOrCreateTree(collection, field, form, root);
        for await (const [key, pointerBuffer] of tree.iterate()) {
          const pointer = pointerBuffer.readUInt32BE(0);
          const document = await this.recordStore.readRecord(pointer);
          const value = document?.getFields()[field];
          if (
            !document ||
            document.getCollectionName() !== collection ||
            value === undefined ||
            (await this.getDocumentBlockId(collection, document.getId())) !== pointer ||
            !supportsFieldIndex(field, value, document.getFields()) ||
            this.keyForm(value, document.getId()) !== form ||
            !key.equals(this.secondaryIndexKeyBuffer(form, value, document.getId()))
          ) {
            staleEntries.push({ collection, field, key });
          }
        }
      }
      fields[collection] = config;
    }
    // Legacy per-document predicates could have left a secondary index incomplete.
    // Validate every collection first, then remove obsolete entries and backfill missing ones.
    for (const { collection, field, key } of staleEntries) {
      const meta = this.getCollectionMeta(collection)[field];
      const tree = await this.getOrCreateTree(collection, field, meta[1], meta[0]);
      await tree.delete(key);
      meta[0] = tree.getRoot().getBlockNumber();
    }
    for (const { collection, field, key, pointer } of missingEntries) {
      const meta = this.getCollectionMeta(collection)[field];
      const tree = await this.getOrCreateTree(collection, field, meta[1], meta[0]);
      if ((await tree.get(key)) !== null) await tree.update(key, this.recordPointerBuffer(pointer));
      else await tree.insert(key, this.recordPointerBuffer(pointer));
      meta[0] = tree.getRoot().getBlockNumber();
    }
    const semanticPending = [
      ...new Set(Object.keys(this.getExistingHnswMeta() ?? {}).map((key) => this.collectionFromHnswIndexKey(key))),
    ];
    this.metaCache[INDEXING_META_KEY] = { version: 1, fields, semanticPending } satisfies IndexingMeta;
  }

  getFieldIndexConfig(collection: string): Record<string, boolean> {
    this.assertHealthy();
    if (RESERVED_META_KEYS.has(collection))
      throw new IndexValidationError('This collection name is reserved for database metadata.');
    return Object.assign(safeDictionary(this.getIndexingMeta().fields[collection]), { id: true });
  }

  private indexedFields(document: Document): string[] {
    const config = this.getFieldIndexConfig(document.getCollectionName());
    const fields = document.getFields();
    return Object.keys(fields).filter((field) => config[field] ?? supportsFieldIndex(field, fields[field], fields));
  }

  private keyForm(value: FieldValue, id: string | number): string {
    return (typeof value === 'string' ? 'S' : 'N') + (typeof id === 'string' ? 'S' : 'N');
  }

  private validateIndexValue(field: string, value: FieldValue, id: string | number): void {
    const maxBytes = Math.floor((this.getBlockSize() - 10) / 2) - 8;
    const idBytes = typeof id === 'string' ? Buffer.byteLength(id) : 8;
    const keyBytes =
      field === 'id'
        ? idBytes
        : (typeof value === 'string' ? Buffer.byteLength(value) + 2 : 8) + idBytes + (typeof id === 'string' ? 2 : 0);
    if (keyBytes > maxBytes) {
      throw new IndexValidationError(
        `Field "${field}" exceeds the maximum indexed key size (${keyBytes} bytes; limit ${maxBytes}). ${field === 'id' ? 'Use a shorter document id.' : 'Shorten the value or disable indexing for this field. Compression does not reduce index key size.'}`,
      );
    }
  }

  /** Shared preflight for public, SQL, import and web mutations, before record/index writes. */
  validateDocument(document: Document): void {
    this.assertHealthy();
    validateDocumentValues(document);
    const id = document.getId();
    this.validateIndexValue('id', id, id);
    const roots = this.metaCache[document.getCollectionName()] as Record<string, [number, string]> | undefined;
    if (roots?.['id'] && roots['id'][1] !== (typeof id === 'string' ? 'S' : 'N')) {
      throw new IndexValidationError('Document id type must match the collection primary index.');
    }
    const fields = document.getFields();
    for (const field of this.indexedFields(document)) {
      if (!supportsFieldIndex(field, fields[field], fields)) {
        throw new IndexValidationError(`Field "${field}" contains binary/image data and cannot be indexed.`);
      }
      this.validateIndexValue(field, fields[field], id);
      if (roots?.[field] && roots[field][1] !== this.keyForm(fields[field], id)) {
        throw new IndexValidationError(
          `Field "${field}" must match its indexed value type. Disable indexing before changing its type.`,
        );
      }
    }
  }

  private validatePrimaryId(collection: string, id: unknown): asserts id is string | number {
    validateDocumentId(id);
    const roots = this.hasCollectionMeta(collection) ? this.getCollectionMeta(collection) : undefined;
    const form = roots?.['id']?.[1];
    if (form && form !== (typeof id === 'string' ? 'S' : 'N')) {
      throw new IndexValidationError('Document id type must match the collection primary index.');
    }
  }

  /** Build privately, then publish a complete root. The regular WAL commit persists the change. */
  setFieldIndexed(collection: string, field: string, indexed: boolean): Promise<void> {
    return this.mutate(() => this.setFieldIndexedInternal(collection, field, indexed));
  }

  private async setFieldIndexedInternal(collection: string, field: string, indexed: boolean): Promise<void> {
    if (typeof field !== 'string' || typeof indexed !== 'boolean')
      throw new IndexValidationError('Choose a field and an Indexed setting.');
    if (indexed && isImageField(field))
      throw new IndexValidationError(`Field "${field}" contains binary/image data and cannot be indexed.`);
    if (field === 'id') {
      if (!indexed) throw new IndexValidationError('The primary id index cannot be disabled.');
      return;
    }
    const roots = this.metaCache[collection] as Record<string, [number, string]> | undefined;
    const current = this.getFieldIndexConfig(collection);
    if (current[field] === indexed) return;
    let built: CachedTree | undefined;
    let form: string | undefined;
    if (indexed && roots?.['id']) {
      // First pass validates all values; no allocation or metadata change on a validation failure.
      for await (const document of await this.cursor(collection, 'id')) {
        const fields = document.getFields();
        if (!Object.hasOwn(fields, field)) continue;
        if (!supportsFieldIndex(field, fields[field], fields))
          throw new IndexValidationError(`Field "${field}" contains binary/image data and cannot be indexed.`);
        this.validateIndexValue(field, fields[field], document.getId());
        const nextForm = this.keyForm(fields[field], document.getId());
        if (form && form !== nextForm)
          throw new IndexValidationError(`Field "${field}" has mixed value types and cannot be indexed.`);
        form = nextForm;
      }
      if (form) {
        const storage = new BlockNodeStorage(this.freeblockFile, {
          compareKeys: getCompareFunction(form),
          unpublished: true,
        });
        const previouslyStarted = this.mutationStarted;
        this.beginMutation();
        try {
          const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);
          built = { storage, tree };
          for await (const document of await this.cursor(collection, 'id')) {
            const value = document.getFields()[field];
            if (value === undefined) continue;
            const pointer = await this.getDocumentBlockId(collection, document.getId());
            await tree.insert(
              this.secondaryIndexKeyBuffer(form, value, document.getId()),
              this.recordPointerBuffer(pointer!),
            );
          }
          await storage.flushDirtyNodes();
          storage.publish();
        } catch (error) {
          try {
            await storage.discardNewTree();
            // All allocations of the unpublished tree were tracked and freed.
            this.freeblockFile.assertHealthy();
            this.mutationStarted = previouslyStarted;
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Index build and cleanup failed.');
          }
          throw error;
        }
      }
    }
    this.beginMutation();
    const collectionMeta = this.getCollectionMeta(collection);
    if (!indexed && collectionMeta[field]) {
      const [root, oldForm] = collectionMeta[field];
      const storage = this.getOrCreateStorage(collection, field, oldForm);
      const blocks = await storage.listNodeBlocks(root);
      storage.dispose();
      this.storageCache.delete(indexCacheKey(collection, field));
      this.treeCache.delete(indexCacheKey(collection, field));
      delete collectionMeta[field];
      for (const block of blocks) await this.freeblockFile.freeBlock(block.blockNumber);
    }
    if (built && form) {
      collectionMeta[field] = [built.tree.getRoot().getBlockNumber(), form];
      this.storageCache.set(indexCacheKey(collection, field), built.storage);
      this.treeCache.set(indexCacheKey(collection, field), built);
    }
    this.getIndexingMeta().fields[collection] = Object.assign(safeDictionary(current), { [field]: indexed });
  }

  /** Preserve an existing collection's primary type when vacuum copies zero documents. */
  ensurePrimaryIndex(collection: string, type: 'string' | 'number'): Promise<void> {
    return this.mutate(async () => {
      this.getFieldIndexConfig(collection);
      this.beginMutation();
      const meta = this.getCollectionMeta(collection);
      if (meta['id']) return;
      const form = type === 'number' ? 'N' : 'S';
      const storage = this.getOrCreateStorage(collection, 'id', form);
      const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);
      this.treeCache.set(indexCacheKey(collection, 'id'), { storage, tree });
      meta['id'] = [tree.getRoot().getBlockNumber(), form];
    });
  }

  private getHnswMeta(): Record<string, [number, string]> {
    const raw = this.metaCache[HNSW_META_KEY];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return (raw as HnswMeta).indexes;
    }
    const created: Record<string, [number, string]> = safeDictionary();
    this.metaCache[HNSW_META_KEY] = { version: 1, indexes: created } satisfies HnswMeta;
    return created;
  }

  private getExistingHnswMeta(): Record<string, [number, string]> | null {
    const raw = this.metaCache[HNSW_META_KEY];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return (raw as HnswMeta).indexes;
    }
    return null;
  }

  private textHnswIndexKey(collection: string): string {
    return semanticIndexKey(collection, this.hnswConfig?.textIndex ? 'text' : 'default');
  }

  private imageHnswIndexKey(collection: string): string {
    return semanticIndexKey(collection, this.hnswConfig?.imageIndex ? 'image' : 'default');
  }

  private collectionFromHnswIndexKey(indexKey: string): string {
    return semanticIndexIdentity(indexKey)[0];
  }

  private hnswIndexKeysForCollection(
    collection: string,
    meta: Record<string, [number, string]> | null = this.getExistingHnswMeta(),
  ): string[] {
    if (!meta) return [];
    return Object.keys(meta).filter((key) => this.collectionFromHnswIndexKey(key) === collection);
  }

  private textHnswConfig(): HnswIndexConfig | undefined {
    if (!this.hnswConfig) return undefined;
    return this.hnswConfig.textIndex ?? this.hnswConfig;
  }

  private imageHnswConfig(): HnswImageIndexConfig | undefined {
    if (!this.hnswConfig) return undefined;
    if (this.hnswConfig.imageIndex) return this.hnswConfig.imageIndex;
    return this.hnswConfig.imageEmbeddingFn
      ? (this.hnswConfig as HnswConfig & { imageEmbeddingFn: (imageData: Buffer) => Promise<Float32Array> })
      : undefined;
  }

  private hnswConfigForIndexKey(indexKey: string): HnswIndexConfig | HnswImageIndexConfig | undefined {
    const [, kind] = semanticIndexIdentity(indexKey);
    if (kind === 'text') return this.textHnswConfig();
    if (kind === 'image') return this.imageHnswConfig();
    return this.hnswConfig;
  }

  private getCompressionMeta(): Record<string, FieldCompressionDefaults> {
    const raw = this.metaCache[COMPRESSION_META_KEY];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, FieldCompressionDefaults>;
    }
    const created: Record<string, FieldCompressionDefaults> = safeDictionary();
    this.metaCache[COMPRESSION_META_KEY] = created;
    return created;
  }

  private getCompressionDefaults(collection: string): FieldCompressionDefaults {
    const compressionMeta = this.getCompressionMeta();
    return compressionMeta[collection] ?? safeDictionary();
  }

  setFieldCompressionDefaults(collection: string, defaults: FieldCompressionDefaults): void {
    this.assertHealthy();
    if (RESERVED_META_KEYS.has(collection))
      throw new IndexValidationError('This collection name is reserved for database metadata.');
    for (const algorithm of Object.values(defaults)) {
      if (!SUPPORTED_COMPRESSION_ALGORITHMS.has(algorithm)) {
        throw new Error(`Unsupported compression algorithm: ${algorithm}`);
      }
    }
    const compressionMeta = this.getCompressionMeta();
    compressionMeta[collection] = safeDictionary(defaults);
  }

  getFieldCompressionDefaults(collection: string): FieldCompressionDefaults {
    this.assertHealthy();
    return safeDictionary(this.getCompressionDefaults(collection));
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

    if (this.getFieldIndexConfig(request.collection ?? '')[request.field] === false || isImageField(request.field)) {
      return new Document(request.collection, '__draft__', [], [entry]);
    }

    return new Document(request.collection, '__draft__', [entry], []);
  }

  async recommendCompression(request: CompressionRecommendationRequest): Promise<CompressionRecommendation> {
    this.assertHealthy();
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
          const sample = compressionSampleFromValue(request.field, fieldValue, {
            mime: imageMimeForField(request.field, document.getFields()),
          });
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
  commit(): Promise<void> {
    return this.mutate(() => this.commitInternal(), true);
  }

  private async commitInternal(): Promise<void> {
    this.beginMutation();
    // Flush all dirty B+tree nodes to the FBF dirty-block cache before committing.
    for (const storage of this.storageCache.values()) {
      await storage.flushDirtyNodes();
    }
    await this.metaWriteJSONInternal(this.metaCache);
    await this.freeblockFile.commit();
    this.mutationStarted = false;
  }

  /**
   * Inserts a Document into the database.
   * @param document - The Document to insert.
   * @returns A Promise that resolves when the document is inserted.
   */
  insertDocument(
    document: Document,
    compressionOverrides?: FieldCompressionOverrides,
    options?: { skipSemanticIndex?: boolean },
  ): Promise<void> {
    return this.mutate(() => this.insertDocumentInternal(document, compressionOverrides, options));
  }

  private async insertDocumentInternal(
    document: Document,
    compressionOverrides?: FieldCompressionOverrides,
    options?: { skipSemanticIndex?: boolean; semanticVectors?: SemanticVector[] },
  ): Promise<void> {
    this.validateDocument(document);
    const collectionName = document.getCollectionName();
    const documentId = document.getId();
    if ((await this.getDocumentBlockId(collectionName, documentId)) !== null) {
      throw new IndexValidationError('A document with this id already exists.');
    }
    const vectors =
      options?.semanticVectors ?? (await this.prepareSemanticVectors(document, options?.skipSemanticIndex));
    const writeOptions: RecordWriteOptions = {
      compressionDefaults: this.getCompressionDefaults(collectionName),
      compressionOverrides,
    };
    // Serialize/compress before allocating records, so codec failures also leave no partial mutation.
    this.recordStore.estimateRecordStorage(document, writeOptions);
    this.beginMutation();
    const documentLocation = await this.recordStore.writeRecord(document, writeOptions);
    const collectionMeta = this.getCollectionMeta(collectionName);
    const config = this.getFieldIndexConfig(collectionName);
    const fields = document.getFields();
    for (const [field, value] of Object.entries(fields)) {
      if (!Object.hasOwn(config, field)) config[field] = supportsFieldIndex(field, value, fields);
    }
    this.getIndexingMeta().fields[collectionName] = config;
    for (const field of ['id', ...this.indexedFields(document)]) {
      const value = field === 'id' ? documentId : fields[field];
      const form = field === 'id' ? (typeof documentId === 'string' ? 'S' : 'N') : this.keyForm(value, documentId);
      let tree: BPlusTree<Buffer, Buffer, BlockLeafNode, BlockInternalNode>;
      if (collectionMeta[field]) {
        tree = await this.getOrCreateTree(collectionName, field, form, collectionMeta[field][0]);
      } else {
        const storage = this.getOrCreateStorage(collectionName, field, form);
        tree = await BPlusTree.create(storage);
        this.treeCache.set(indexCacheKey(collectionName, field), { storage, tree });
      }
      const key = field === 'id' ? toBuffer(form, documentId) : this.secondaryIndexKeyBuffer(form, value, documentId);
      await tree.insert(key, this.recordPointerBuffer(documentLocation));
      collectionMeta[field] = [tree.getRoot().getBlockNumber(), form];
    }
    if (!this.hnswConfig && this.hnswIndexKeysForCollection(collectionName).length > 0)
      this.markSemanticPending(collectionName);
    for (const { indexKey, vector } of vectors) {
      const index = await this.getOrCreateHnswIndex(indexKey);
      await index.insert(documentLocation, vector);
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
    this.assertHealthy();
    this.validatePrimaryId(collection, documentId);
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
      ? await this.readIndexedEncodedDocument(documentPointer, collection)
      : await this.readIndexedDocument(documentPointer, collection);
    const storedId = document instanceof Document ? document.getId() : document.id;
    if (!toBuffer(vorm, storedId).equals(idBuffer)) {
      throw new Error(
        `Primary index in collection "${collection}" references a different document at block ${documentPointer}`,
      );
    }
    return document;
  }

  /** An index reference is a promise of a live record, never ordinary absence. */
  private async readIndexedDocument(pointer: number, collection: string): Promise<Document> {
    this.assertHealthy();
    const document = await this.recordStore.readRecord(pointer);
    if (!document) {
      throw new Error(`Index in collection "${collection}" references missing record at block ${pointer}`);
    }
    validateDocumentId(document.getId());
    if (
      document.getCollectionName() !== collection ||
      (await this.getDocumentBlockId(collection, document.getId())) !== pointer
    ) {
      throw new Error(`Index in collection "${collection}" references a non-live document at block ${pointer}`);
    }
    return document;
  }

  private async readIndexedEncodedDocument(pointer: number, collection: string): Promise<EncodedDocument> {
    this.assertHealthy();
    const document = await this.recordStore.readRecordEncoded(pointer);
    if (!document) {
      throw new Error(`Index in collection "${collection}" references missing encoded record at block ${pointer}`);
    }
    validateDocumentId(document.id);
    if (document.collection !== collection || (await this.getDocumentBlockId(collection, document.id)) !== pointer) {
      throw new Error(`Index in collection "${collection}" references a non-live encoded document at block ${pointer}`);
    }
    return document;
  }

  /** Counts live primary references without decoding records, for vacuum completeness checks. */
  async getPrimaryReferenceCount(collection: string): Promise<number> {
    this.assertHealthy();
    if (!this.hasCollectionMeta(collection)) return 0;
    const idMeta = this.getCollectionMeta(collection)['id'];
    if (!idMeta) return 0;
    const [root, form] = idMeta;
    const tree = await this.getOrCreateTree(collection, 'id', form, root);
    let count = 0;
    for await (const [, pointer] of tree.iterate()) {
      pointer.readUInt32BE(0);
      count += 1;
    }
    return count;
  }

  /**
   * Resolves a `(collection, id)` pair to the head block ID of the
   * document's block chain. Returns `null` if no such document exists.
   * This is internal plumbing for size/metadata queries; callers that
   * just want the document should use `getDocument` instead.
   */
  async getDocumentBlockId(collection: string, documentId: number | string): Promise<number | null> {
    this.assertHealthy();
    this.validatePrimaryId(collection, documentId);
    if (!this.hasCollectionMeta(collection)) return null;
    const collectionMeta = this.getCollectionMeta(collection);
    if (!('id' in collectionMeta)) return null;
    const [root, vorm] = collectionMeta['id'];
    const idBuffer = toBuffer(vorm, documentId);
    const idTree = await this.getOrCreateTree(collection, 'id', vorm, root);
    const documentPointerBuffer = await idTree.get(idBuffer);
    if (!documentPointerBuffer) return null;
    return documentPointerBuffer.readUInt32BE(0);
  }

  /**
   * Returns the physical on-disk byte footprint of a single document:
   * `chainLength × blockSize`, walked from the document's head block.
   * Throws if the document does not exist.
   */
  async getDocumentStoredBytes(collection: string, documentId: number | string): Promise<number> {
    const blockId = await this.getDocumentBlockId(collection, documentId);
    if (blockId === null) throw new Error('Document not found');
    await this.readIndexedDocument(blockId, collection);
    return this.recordStore.getStoredByteCount(blockId);
  }

  /**
   * Returns the sum of physical block bytes used by every document in
   * the collection. Equal to `Σ (chainLength_i × blockSize)`.
   * Returns 0 for unknown collections.
   */
  async getCollectionRecordBytes(collection: string): Promise<number> {
    this.assertHealthy();
    if (!this.hasCollectionMeta(collection)) return 0;
    const collectionMeta = this.getCollectionMeta(collection);
    if (!('id' in collectionMeta)) return 0;
    const [root, vorm] = collectionMeta['id'];
    const idTree = await this.getOrCreateTree(collection, 'id', vorm, root);
    let total = 0;
    for await (const [, documentPointerBuffer] of idTree.iterate(undefined)) {
      const documentPointer = documentPointerBuffer.readUInt32BE(0);
      await this.readIndexedDocument(documentPointer, collection);
      total += await this.recordStore.getStoredByteCount(documentPointer);
    }
    return total;
  }

  /**
   * Physical block size in bytes (e.g. 4096). All on-disk reservation
   * happens in whole-block multiples of this value.
   */
  getBlockSize(): number {
    return this.recordStore.getBlockSize();
  }

  /**
   * Deletes a document from the database.
   * @param documentId - The ID of the document to delete.
   * @param collection - The collection to delete the document from.
   */
  deleteDocument(documentId: number | string, collection: string): Promise<void> {
    return this.mutate(() => this.deleteDocumentInternal(documentId, collection));
  }

  private async deleteDocumentInternal(documentId: number | string, collection: string): Promise<void> {
    this.validatePrimaryId(collection, documentId);
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
    const document = await this.readIndexedDocument(documentPointer, collection);
    const iterableKeys = Object.keys(document.getFields()).filter((key) => Object.hasOwn(collectionMeta, key));

    const hnswMeta = this.getExistingHnswMeta();
    const hnswIndexKeys = this.hnswIndexKeysForCollection(collection, hnswMeta);
    const collectionHasHnsw = hnswIndexKeys.length > 0;

    // Delete from id B+ tree
    this.beginMutation();
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
      const keyBuffer = this.secondaryIndexKeyBuffer(keyVorm, keyValue, documentId);
      await keyTree.delete(keyBuffer);
      // verwijder document-pointer uit B+ tree
      //BPLUSTREE DELETE (keyRoot, (Key, id) )
      //update meta met nieuwe root als die veranderd is
      keyMetaData[0] = keyTree.getRoot().getBlockNumber();
    }

    let retainedRecordForSemanticTombstone = collectionHasHnsw && !this.hnswConfig;

    if (this.hnswConfig) {
      for (const indexKey of hnswIndexKeys) {
        const hnswIdx = await this.getOrCreateHnswIndex(indexKey);
        await hnswIdx.delete(documentPointer);
        retainedRecordForSemanticTombstone =
          hnswIdx.hasRetainedDocument(documentPointer) || retainedRecordForSemanticTombstone;
      }
    }

    if (collectionHasHnsw && !this.hnswConfig) this.markSemanticPending(collection);

    // Physical record pointers remain the identity of retained HNSW nodes.
    // Keep their record chains allocated, including already tombstoned entries
    // and offline deletions awaiting a semantic rebuild. Full vacuum reclaims
    // these chains by copying only documents still visible in the primary tree.
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
  tombstoneSemanticEntry(documentId: number | string, collection: string): Promise<boolean> {
    return this.mutate(() => this.tombstoneSemanticEntryInternal(documentId, collection));
  }

  private async tombstoneSemanticEntryInternal(documentId: number | string, collection: string): Promise<boolean> {
    this.validatePrimaryId(collection, documentId);
    if (!this.hnswConfig) {
      throw new Error('Cannot tombstone semantic entry without hnswConfig');
    }

    const hnswMeta = this.getExistingHnswMeta();
    const hnswIndexKeys = this.hnswIndexKeysForCollection(collection, hnswMeta);
    if (hnswIndexKeys.length === 0) return false;

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
    let tombstoned = false;
    await this.readIndexedDocument(documentPointer, collection);
    this.beginMutation();
    for (const indexKey of hnswIndexKeys) {
      const hnswIdx = await this.getOrCreateHnswIndex(indexKey);
      tombstoned = (await hnswIdx.tombstone(documentPointer)) || tombstoned;
    }
    return tombstoned;
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
  ensureHnswCollection(collection: string): Promise<void> {
    return this.mutate(() => this.ensureHnswCollectionInternal(collection));
  }

  private async ensureHnswCollectionInternal(collection: string): Promise<void> {
    if (RESERVED_META_KEYS.has(collection))
      throw new IndexValidationError('This collection name is reserved for database metadata.');
    if (!this.hnswConfig) {
      throw new Error('Cannot ensure HNSW collection without hnswConfig');
    }
    if (this.hnswConfig.textIndex || this.hnswConfig.imageIndex) {
      if (this.textHnswConfig()) await this.getOrCreateHnswIndex(this.textHnswIndexKey(collection));
      if (this.imageHnswConfig()) await this.getOrCreateHnswIndex(this.imageHnswIndexKey(collection));
      return;
    }

    await this.getOrCreateHnswIndex(semanticIndexKey(collection, 'default'));
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
  relocateDocument(
    collection: string,
    id: string | number,
    options: RelocationOptions = {},
  ): Promise<DocumentRelocationResult> {
    return this.mutate(() => this.relocateDocumentInternal(collection, id, options), true);
  }

  private async relocateDocumentInternal(
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

    const document = await this.readIndexedDocument(oldPointer, collection);
    const encodedDocument = await this.readIndexedEncodedDocument(oldPointer, collection);
    this.beginMutation();

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

    for (const key of Object.keys(document.getFields()).filter((key) => Object.hasOwn(collectionMeta, key))) {
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

    const candidates = this.relocationCandidates.get('record');
    if (candidates) {
      const chain = await this.recordStore.readRecordBlockChain(newPointer);
      const target: RelocationTarget = { kind: 'record', collection, documentId: id, blockNumber: Math.max(...chain) };
      (await candidates).replace(target, target);
    }

    return {
      oldBlockNumber: oldPointer,
      newBlockNumber: newPointer,
      relocated: newPointer !== oldPointer,
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
  relocateBtreeNode(
    collection: string,
    field: string,
    blockNumber: number,
    options: RelocationOptions = {},
  ): Promise<number> {
    return this.mutate(() => this.relocateBtreeNodeInternal(collection, field, blockNumber, options), true);
  }

  private async relocateBtreeNodeInternal(
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
    this.beginMutation();
    const result = await storage.relocateNode(rootBlock, blockNumber, options);
    fieldMeta[0] = result.newRootBlock;
    this.treeCache.delete(indexCacheKey(collection, field));
    const candidates = this.relocationCandidates.get('btree');
    if (candidates) {
      const previous: RelocationTarget = { kind: result.kind, collection, field, blockNumber };
      (await candidates).replace(previous, { ...previous, blockNumber: result.newBlockNumber });
    }
    return result.newBlockNumber;
  }

  async listHnswRelocationTargets(collection: string): Promise<HnswRelocationTarget[]> {
    return this.mutate(async () => {
      if (!this.hnswConfig) throw new Error('Cannot inspect HNSW relocation targets without hnswConfig');
      const meta = this.getExistingHnswMeta();
      const targets: HnswRelocationTarget[] = [];
      for (const indexKey of this.hnswIndexKeysForCollection(collection)) {
        const [, indexKind] = semanticIndexIdentity(indexKey);
        const index = await this.getOrCreateHnswIndex(indexKey);
        targets.push({
          collection,
          indexKind,
          kind: 'hnsw-meta',
          blockNumber: meta![indexKey][0],
          hnswUnitState: 'live',
        });
        targets.push(...(await index.listRelocationTargets()).map((target) => ({ ...target, collection, indexKind })));
      }
      return targets;
    }, true);
  }

  async inspectHnswGraphStructure(
    collection: string,
    indexKind?: SemanticIndexKind,
  ): Promise<HnswGraphStructureNode[]> {
    return (await this.inspectHnswGraphStructureSnapshot(collection, indexKind)).nodes;
  }

  async inspectHnswGraphStructureSnapshot(
    collection: string,
    indexKind?: SemanticIndexKind,
  ): Promise<HnswGraphStructureSnapshot> {
    this.assertHealthy();
    if (!this.hnswConfig) {
      throw new Error('Cannot inspect HNSW graph structure without hnswConfig');
    }

    const hnswMeta = this.getExistingHnswMeta();
    const indexKey = this.hnswInspectionKey(collection, indexKind);
    if (!hnswMeta || !Object.hasOwn(hnswMeta, indexKey)) {
      throw new Error('HNSW index does not exist for collection');
    }

    return await (await this.getOrCreateHnswIndex(indexKey)).inspectGraphStructureSnapshot();
  }

  private hnswInspectionKey(collection: string, indexKind?: SemanticIndexKind): string {
    return semanticIndexKey(collection, indexKind ?? (this.hnswConfig?.textIndex ? 'text' : 'default'));
  }

  relocateHnswUnit(target: HnswRelocationTarget): Promise<boolean> {
    return this.mutate(() => this.relocateHnswUnitInternal(target), true);
  }

  private async relocateHnswUnitInternal(target: HnswRelocationTarget): Promise<boolean> {
    if (!this.hnswConfig) {
      throw new Error('Cannot relocate HNSW unit without hnswConfig');
    }

    const hnswMeta = this.getExistingHnswMeta();
    const indexKey = this.hnswInspectionKey(target.collection, target.indexKind);
    if (!hnswMeta || !Object.hasOwn(hnswMeta, indexKey)) {
      throw new Error('HNSW index does not exist for collection');
    }

    const hnswIdx = await this.getOrCreateHnswIndex(indexKey);
    if (target.kind === 'hnsw-meta') {
      const [oldBlockNumber, vorm] = hnswMeta[indexKey];
      this.beginMutation();
      const newBlockNumber = await hnswIdx.relocateMetadata({ maxBlockExclusive: target.maxBlockExclusive });
      if (newBlockNumber === null) return false;
      hnswMeta[indexKey] = [newBlockNumber, vorm];
      await this.replaceHnswRelocationCandidate(
        { ...target, blockNumber: oldBlockNumber },
        { ...target, blockNumber: newBlockNumber },
      );
      return target.maxBlockExclusive === undefined
        ? newBlockNumber !== oldBlockNumber
        : newBlockNumber < oldBlockNumber;
    }

    const nodeId = await this.resolveHnswRelocationNodeId(target);
    const previous = await hnswIdx.getRelocationTargetsForNode(nodeId);
    this.beginMutation();
    if (target.kind === 'hnsw-graph') {
      const newNodeId = await hnswIdx.relocateGraphNode(nodeId, { maxBlockExclusive: target.maxBlockExclusive });
      const newBlockNumber = Math.floor(newNodeId / 4294967296);
      for (const unit of previous) {
        await this.replaceHnswRelocationCandidate(
          { ...unit, collection: target.collection, indexKind: target.indexKind },
          {
            ...unit,
            collection: target.collection,
            indexKind: target.indexKind,
            nodeId: newNodeId,
            blockNumber: unit.kind === 'hnsw-graph' ? newBlockNumber : unit.blockNumber,
          },
        );
      }
      return (
        target.maxBlockExclusive === undefined ||
        target.blockNumber === undefined ||
        newBlockNumber < target.blockNumber
      );
    }

    const newPtr = await hnswIdx.relocateVectorForNode(nodeId, { maxBlockExclusive: target.maxBlockExclusive });
    const vector = previous.find((unit) => unit.kind === 'hnsw-vector')!;
    await this.replaceHnswRelocationCandidate(
      { ...vector, collection: target.collection, indexKind: target.indexKind },
      { ...vector, collection: target.collection, indexKind: target.indexKind, blockNumber: newPtr.pageId },
    );
    return (
      target.maxBlockExclusive === undefined || target.blockNumber === undefined || newPtr.pageId < target.blockNumber
    );
  }

  async trimFreeTail(): Promise<number> {
    return this.mutate(async () => {
      await this.commitInternal();
      this.beginMutation();
      const result = await this.freeblockFile.trimFreeTail();
      return result.removedBlocks;
    }, true);
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
    return this.listRelocationCandidates('record', limit);
  }

  async listBtreeRelocationTargets(limit = 16): Promise<RelocationTarget[]> {
    return this.listRelocationCandidates('btree', limit);
  }

  async listHnswRelocationCandidateTargets(limit = 16): Promise<RelocationTarget[]> {
    return this.listRelocationCandidates('hnsw', limit);
  }

  private listRelocationCandidates(kind: 'record' | 'btree' | 'hnsw', limit: number): Promise<RelocationTarget[]> {
    return this.mutate(async () => {
      if (!(limit > 0)) return [];
      return (await this.getRelocationCandidates(kind)).top(limit);
    }, true);
  }

  private async getRelocationCandidates(kind: 'record' | 'btree' | 'hnsw'): Promise<RelocationCandidates> {
    let inventory = this.relocationCandidates.get(kind);
    if (!inventory) {
      const collect =
        kind === 'record'
          ? this.collectRecordRelocationCandidates()
          : kind === 'btree'
            ? this.collectBtreeRelocationCandidates()
            : this.collectHnswRelocationCandidates();
      inventory = collect.then((targets) => new RelocationCandidates(targets));
      this.relocationCandidates.set(kind, inventory);
    }
    try {
      return await inventory;
    } catch (error) {
      if (this.relocationCandidates.get(kind) === inventory) this.relocationCandidates.delete(kind);
      throw error;
    }
  }

  private async replaceHnswRelocationCandidate(
    previous: HnswRelocationTarget,
    target: HnswRelocationTarget,
  ): Promise<void> {
    const inventory = this.relocationCandidates.get('hnsw');
    if (!inventory) return;
    const indexKind = semanticIndexIdentity(this.hnswInspectionKey(target.collection, target.indexKind))[1];
    (await inventory).replace(
      { ...previous, indexKind },
      {
        kind: target.kind,
        collection: target.collection,
        indexKind,
        nodeId: target.nodeId,
        blockNumber: target.blockNumber,
        hnswUnitState: target.hnswUnitState ?? 'live',
      },
    );
  }

  private async collectRecordRelocationCandidates(): Promise<RelocationTarget[]> {
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
        const document = await this.readIndexedDocument(blockNumber, collection);
        const chain = await this.recordStore.readRecordBlockChain(blockNumber);
        targets.push({
          kind: 'record',
          collection,
          documentId: document.getId(),
          blockNumber: Math.max(...chain),
        });
      }
    }

    return targets;
  }

  private async collectBtreeRelocationCandidates(): Promise<RelocationTarget[]> {
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

    return targets;
  }

  private async collectHnswRelocationCandidates(): Promise<RelocationTarget[]> {
    this.assertHealthy();
    if (!this.hnswConfig) {
      return [];
    }

    const hnswMeta = this.getExistingHnswMeta();
    if (!hnswMeta) {
      return [];
    }

    const targets: RelocationTarget[] = [];
    for (const [indexKey, [metaBlock]] of Object.entries(hnswMeta)) {
      const [collection, indexKind] = semanticIndexIdentity(indexKey);
      const index = await this.getOrCreateHnswIndex(indexKey);
      targets.push({ kind: 'hnsw-meta', collection, indexKind, blockNumber: metaBlock, hnswUnitState: 'live' });
      for (const target of await index.listRelocationTargets()) {
        targets.push({
          kind: target.kind,
          collection,
          indexKind,
          blockNumber: target.blockNumber,
          nodeId: target.nodeId,
          hnswUnitState: target.hnswUnitState,
        });
      }
    }

    return targets;
  }

  private async resolveHnswRelocationNodeId(target: HnswRelocationTarget): Promise<number> {
    if (target.kind === 'hnsw-meta') {
      throw new Error('HNSW metadata relocation does not use a node id');
    }
    if (target.nodeId === undefined && target.blockNumber === undefined) {
      throw new Error('HNSW relocation target requires nodeId or blockNumber');
    }

    const indexKey = this.hnswInspectionKey(target.collection, target.indexKind);
    const matches = (candidate: HnswRelocationTarget): boolean =>
      candidate.collection === target.collection &&
      candidate.kind === target.kind &&
      (target.nodeId === undefined || candidate.nodeId === target.nodeId) &&
      (target.blockNumber === undefined || candidate.blockNumber === target.blockNumber) &&
      this.hnswInspectionKey(candidate.collection, candidate.indexKind) === indexKey;
    let match: HnswRelocationTarget | undefined;
    if (target.nodeId !== undefined) {
      const index = await this.getOrCreateHnswIndex(indexKey);
      const units = await index.getRelocationTargetsForNode(target.nodeId);
      match = units
        .map((unit) => ({ ...unit, collection: target.collection, indexKind: target.indexKind }))
        .find(matches);
    } else {
      const indexKind = semanticIndexIdentity(indexKey)[1];
      match = (await this.getRelocationCandidates('hnsw')).atLocation({ ...target, indexKind }) as
        | HnswRelocationTarget
        | undefined;
    }
    if (!match || match.nodeId === undefined) {
      if (target.nodeId !== undefined)
        throw new Error(`No ${target.kind} unit with node ${target.nodeId} belongs to this semantic index`);
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
    this.validatePrimaryId(collection, id);
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
    const indexKeys = this.hnswIndexKeysForCollection(collection, hnswMeta);
    if (indexKeys.length === 0) return;
    if (!this.hnswConfig) {
      throw new Error('Cannot relocate HNSW-backed document without hnswConfig');
    }

    for (const indexKey of indexKeys) {
      const hnswIdx = await this.getOrCreateHnswIndex(indexKey);
      if (!hnswIdx.hasDocument(oldPointer)) continue;
      if (!(await hnswIdx.relabelDocument(oldPointer, newPointer))) {
        throw new Error(
          `Failed to relabel HNSW document pointer ${oldPointer} -> ${newPointer} in ${indexKey} during document relocation`,
        );
      }
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
  editDocumentByID(collection: string, id: string | number, field: string, newValue: FieldValue): Promise<void> {
    return this.mutate(() => this.editDocumentByIDInternal(collection, id, field, newValue));
  }

  private async editDocumentByIDInternal(
    collection: string,
    id: string | number,
    field: string,
    newValue: FieldValue,
  ): Promise<void> {
    const existingDocument = (await this.getDocument(id, collection, false)) as Document;
    let processedValue = newValue;
    if (typeof newValue === 'string' && isImageField(field, existingDocument.getFields())) {
      processedValue = Buffer.from(newValue, 'base64');
    }
    const newDocumentObj = existingDocument.cloneWithUpdatedField(field, processedValue);

    if (
      existingDocument.getId() !== newDocumentObj.getId() ||
      existingDocument.getCollectionName() !== newDocumentObj.getCollectionName()
    ) {
      throw new Error('Cannot change document ID or collection name during edit.');
    }

    await this.replaceDocumentByIDInternal(collection, id, newDocumentObj, undefined, true);
  }

  /**
   * Replace a document's body in one shot. The `id` is preserved (the
   * provided document's id must match the existing one). All non-id
   * fields are replaced with the new document — fields that disappear
   * from the new payload are dropped from the store.
   *
   * Internally this is still a delete-then-insert against the same
   * collection (so index entries are kept in sync and the HNSW vector
   * is re-embedded exactly once), but exposes a single round-trip from
   * the API layer instead of N per-field calls.
   */
  replaceDocumentByID(
    collection: string,
    id: string | number,
    document: Document,
    compression?: FieldCompressionOverrides,
    preserveCompression = false,
  ): Promise<void> {
    return this.mutate(() =>
      this.replaceDocumentByIDInternal(collection, id, document, compression, preserveCompression),
    );
  }

  private async replaceDocumentByIDInternal(
    collection: string,
    id: string | number,
    newDocument: Document,
    compression?: FieldCompressionOverrides,
    preserveCompression = false,
  ): Promise<void> {
    this.validatePrimaryId(collection, id);
    this.validateDocument(newDocument);
    if (!this.hasCollectionMeta(collection)) {
      throw new Error('Collection does not exist');
    }
    if (newDocument.getCollectionName() !== collection) {
      throw new Error('Cannot change collection name during replace.');
    }
    if (newDocument.getId() !== id) {
      throw new Error('Cannot change document ID during replace.');
    }
    // Confirm the existing document is there; otherwise treat it as
    // a not-found error rather than a silent insert.
    const existing = await this.getDocumentBlockId(collection, id);
    if (existing === null) {
      throw new Error('Document not found');
    }
    const stored = await this.readIndexedEncodedDocument(existing, collection);
    if (stored.id !== newDocument.getId()) throw new Error('Cannot change document ID type during replace.');
    if (preserveCompression) {
      compression = {
        ...Object.fromEntries(
          [...stored.iterableEntries, ...stored.nonIterableEntries].map((entry) => [entry.key, entry.compression]),
        ),
        ...compression,
      };
    }

    const vectors = await this.prepareSemanticVectors(newDocument);
    this.recordStore.estimateRecordStorage(newDocument, {
      compressionDefaults: this.getCompressionDefaults(collection),
      compressionOverrides: compression,
    });
    await this.deleteDocumentInternal(id, collection);
    await this.insertDocumentInternal(newDocument, compression, { semanticVectors: vectors });
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
    const entries = await this.iterateCursorEntries(collection, iterableKey, value);
    return (async function* () {
      for await (const entry of entries) yield entry.document;
    })();
  }

  /** Iterate strictly after a complete logical key, or from the beginning. */
  cursorWithPosition(
    collection: string,
    iterableKey: string,
    after?: IndexCursorPosition,
  ): Promise<AsyncIterable<IndexCursorEntry>> {
    return this.iterateCursorEntries(collection, iterableKey, undefined, after);
  }

  private async iterateCursorEntries(
    collection: string,
    iterableKey: string,
    value?: string | number | Buffer,
    after?: IndexCursorPosition,
  ): Promise<AsyncIterable<IndexCursorEntry>> {
    this.assertHealthy();
    if (iterableKey === 'id' && value !== undefined) this.validatePrimaryId(collection, value);
    if (!this.hasCollectionMeta(collection)) {
      if (after !== undefined) throw new InvalidCursorError('collection no longer exists');
      throw new Error('Collection does not exist');
    }
    const collectionMeta = this.getCollectionMeta(collection);
    if (!(iterableKey in collectionMeta)) {
      if (after !== undefined) throw new InvalidCursorError('index no longer exists');
      // A policy can be configured before the first document creates its primary tree.
      if (iterableKey === 'id' && !collectionMeta['id']) return (async function* () {})();
      throw new Error('Iterable key does not exist in collection');
    }

    const keyMetaData = collectionMeta[iterableKey];
    const keyRoot = keyMetaData[0];
    const keyVorm = keyMetaData[1];

    if (after !== undefined) {
      if (after.form !== keyVorm) throw new InvalidCursorError('index key type has changed');
      validateCompleteCursorKey(after.key, keyVorm);
      if (after.key.length > Math.floor((this.getBlockSize() - 10) / 2) - 8) {
        throw new InvalidCursorError('index key exceeds the supported size');
      }
    }

    const keyTree = await this.getOrCreateTree(collection, iterableKey, keyVorm, keyRoot);

    const startKeyBuffer = after?.key ?? (value !== undefined ? toBuffer(keyVorm, value) : undefined);
    const asyncGenerator = keyTree.iterate(startKeyBuffer);
    const compare = getCompareFunction(keyVorm);

    const documentGenerator = async function* (this: DbmsBack) {
      for await (const [key, documentPointerBuffer] of asyncGenerator) {
        // The B+ tree seek is inclusive. Exclude the saved key only when it is
        // actually encountered; if it was deleted, keep the first successor.
        if (after !== undefined && compare(key, after.key) <= 0) continue;
        const documentPointer = documentPointerBuffer.readUInt32BE(0);
        const document = await this.readIndexedDocument(documentPointer, collection);
        if (iterableKey === 'id' && !key.equals(toBuffer(keyVorm, document.getId()))) {
          throw new Error(
            `Primary index in collection "${collection}" references a different document at block ${documentPointer}`,
          );
        }
        yield { document, position: { form: keyVorm, key: Buffer.from(key) } };
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
    this.assertHealthy();
    if (this.getPendingSemanticCollections().includes(collection))
      throw new Error(
        `Semantic reindex pending for \"${collection}\". Reopen with the original working embedding configuration to finish migration.`,
      );
    if (!this.hnswConfig) throw new Error('Semantic search is not configured (no hnswConfig provided).');

    const textConfig = this.textHnswConfig();
    if (!textConfig) return [];

    const hnswMeta = this.getExistingHnswMeta();
    const indexKey = this.textHnswIndexKey(collection);
    if (!hnswMeta || !(indexKey in hnswMeta)) return [];

    const hnswIdx = await this.getOrCreateHnswIndex(indexKey);
    const queryVector = await textConfig.embeddingFn(query);
    const documentLocations = await hnswIdx.search(queryVector, k);

    const results: Document[] = [];
    for (const loc of documentLocations) {
      results.push(await this.readIndexedDocument(loc, collection));
    }
    return results;
  }

  async semanticImageTextSearch(collection: string, query: string, k: number): Promise<Document[]> {
    this.assertHealthy();
    if (this.getPendingSemanticCollections().includes(collection))
      throw new Error(
        `Semantic reindex pending for \"${collection}\". Reopen with the original working embedding configuration to finish migration.`,
      );
    if (!this.hnswConfig) throw new Error('Semantic search is not configured (no hnswConfig provided).');
    const imageConfig = this.imageHnswConfig();
    if (!imageConfig) {
      throw new Error('Text-to-image search requires an image index config with CLIP text and image encoders.');
    }

    const hnswMeta = this.getExistingHnswMeta();
    const indexKey = this.imageHnswIndexKey(collection);
    if (!hnswMeta || !(indexKey in hnswMeta)) return [];

    const hnswIdx = await this.getOrCreateHnswIndex(indexKey);
    const queryVector = await imageConfig.embeddingFn(query);
    const documentLocations = await hnswIdx.search(queryVector, k);

    const results: Document[] = [];
    for (const loc of documentLocations) {
      results.push(await this.readIndexedDocument(loc, collection));
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
    this.assertHealthy();
    if (this.getPendingSemanticCollections().includes(collection))
      throw new Error(
        `Semantic reindex pending for \"${collection}\". Reopen with the original working embedding configuration to finish migration.`,
      );
    if (!this.hnswConfig) throw new Error('Semantic search is not configured (no hnswConfig provided).');
    const imageConfig = this.imageHnswConfig();
    if (!imageConfig) {
      throw new Error('Image search requires imageEmbeddingFn in HnswConfig.');
    }

    const hnswMeta = this.getExistingHnswMeta();
    const indexKey = this.imageHnswIndexKey(collection);
    if (!hnswMeta || !(indexKey in hnswMeta)) return [];

    const hnswIdx = await this.getOrCreateHnswIndex(indexKey);
    const queryVector = await imageConfig.imageEmbeddingFn(queryImage);
    const documentLocations = await hnswIdx.search(queryVector, k);

    const results: Document[] = [];
    for (const loc of documentLocations) {
      results.push(await this.readIndexedDocument(loc, collection));
    }
    return results;
  }

  // Private HNSW helpers

  /**
   * Encode all non-`_`-prefixed string field values as labelled text.
   * Field names carry important meaning in schema-less documents; e.g.
   * `role: engineer` is more useful to an embedding model than just
   * `engineer`. Returns `null` if the document contains no embeddable text.
   */
  private extractText(document: Document): string | null {
    const parts: string[] = [];
    const fields = document.getFields();
    for (const [key, value] of Object.entries(fields)) {
      if (!isImageField(key, fields) && typeof value === 'string' && !this.isImageMimeSidecar(key, fields)) {
        parts.push(`${key}: ${value}`);
      }
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }

  private isImageMimeSidecar(field: string, fields: Record<string, unknown>): boolean {
    return Object.keys(fields).some((key) => field === `_${key}_mime` && imageMimeForField(key, fields) !== null);
  }

  getPendingSemanticCollections(): string[] {
    this.assertHealthy();
    return [...this.getIndexingMeta().semanticPending];
  }

  private markSemanticPending(collection: string): void {
    if (!this.getIndexingMeta().semanticPending.includes(collection))
      this.getIndexingMeta().semanticPending.push(collection);
  }

  private async prepareSemanticVectors(
    document: Document,
    skip = false,
    rebuilding = false,
  ): Promise<SemanticVector[]> {
    if (
      !this.hnswConfig ||
      skip ||
      (!rebuilding && this.getPendingSemanticCollections().includes(document.getCollectionName()))
    )
      return [];
    const collection = document.getCollectionName();
    const vectors: SemanticVector[] = [];
    const images = this.extractImageData(document);
    const single = !this.hnswConfig.textIndex && !this.hnswConfig.imageIndex;
    const imageConfig = this.imageHnswConfig();
    if (single && images.length > 0 && imageConfig) {
      validateVectorDimension(imageConfig.dimension, this.getBlockSize());
      const vector = await this.embedImages(imageConfig, images);
      if (vector) vectors.push({ indexKey: semanticIndexKey(collection, 'default'), vector });
    } else {
      const text = this.extractText(document);
      const config = this.textHnswConfig();
      if (text !== null && config) {
        validateVectorDimension(config.dimension, this.getBlockSize());
        vectors.push({ indexKey: this.textHnswIndexKey(collection), vector: await config.embeddingFn(text) });
      }
      if (!single && imageConfig && images.length > 0) {
        validateVectorDimension(imageConfig.dimension, this.getBlockSize());
        const vector = await this.embedImages(imageConfig, images);
        if (vector) vectors.push({ indexKey: this.imageHnswIndexKey(collection), vector });
      }
    }
    for (const item of vectors) {
      const config = this.hnswConfigForIndexKey(item.indexKey)!;
      if (item.vector.length !== config.dimension || Array.from(item.vector).some((value) => !Number.isFinite(value))) {
        throw new Error(`Invalid embedding for "${item.indexKey}": expected ${config.dimension} finite components.`);
      }
    }
    return vectors;
  }

  /** One-time, retryable replacement. Old semantic storage stays live until every new vector is built. */
  private async rebuildSemanticCollection(collection: string): Promise<void> {
    const staged = new Map<string, { index: HNSWIndex; root: number }>();
    const oldKeys = this.hnswIndexKeysForCollection(collection);
    const previouslyStarted = this.mutationStarted;
    let allocating = false;
    let inserting = false;
    try {
      if (this.getCollectionMeta(collection)['id']) {
        for await (const document of await this.cursor(collection, 'id')) {
          const pointer = await this.getDocumentBlockId(collection, document.getId());
          for (const { indexKey, vector } of await this.prepareSemanticVectors(document, false, true)) {
            let target = staged.get(indexKey);
            if (!target) {
              const config = this.hnswConfigForIndexKey(indexKey)!;
              const heap = new VectorHeapFile(this.freeblockFile, config.dimension);
              this.beginMutation();
              allocating = true;
              const graph = await HNSWGraphStorage.create(
                this.freeblockFile,
                config.M ?? 16,
                config.maxStoredLevel ?? 4,
                config.dimension,
              );
              const index = HNSWIndex.create(graph, heap, {
                M: config.M ?? 16,
                efConstruction: config.efConstruction ?? 200,
                efSearch: config.efSearch ?? 50,
              });
              target = { index, root: graph.metaBlockId };
              staged.set(indexKey, target);
              allocating = false;
            }
            inserting = true;
            await target.index.insert(pointer!, vector);
            inserting = false;
          }
        }
      }
    } catch (error) {
      for (const { index } of staged.values()) {
        await index.dropStorage();
        index.dispose();
      }
      // A failed structural insertion can own allocations not yet linked into
      // the graph; dropping registered nodes cannot prove complete restoration.
      if (!allocating && !inserting) this.mutationStarted = previouslyStarted;
      throw error;
    }
    this.beginMutation();
    for (const indexKey of oldKeys) {
      const index = await this.getOrCreateHnswIndex(indexKey);
      await index.dropStorage();
      index.dispose();
      delete this.getHnswMeta()[indexKey];
      this.hnswIndexCache.delete(indexKey);
    }
    for (const [indexKey, { index, root }] of staged) {
      this.getHnswMeta()[indexKey] = [root, 'hnsw'];
      this.hnswIndexCache.set(indexKey, index);
    }
    this.getIndexingMeta().semanticPending = this.getPendingSemanticCollections().filter((name) => name !== collection);
  }

  /**
   * Extract the raw bytes of every image field in the document.
   */
  private extractImageData(document: Document): Buffer[] {
    const images: Buffer[] = [];
    const fields = document.getFields();
    for (const [key, value] of Object.entries(fields)) {
      // Image fields are semantic candidates by schema. The configured image
      // embedding function decides whether a byte payload is decodable; this
      // keeps synthetic test embedders and future non-CLIP encoders usable.
      if (isImageField(key, fields) && Buffer.isBuffer(value)) {
        images.push(value);
      }
    }
    return images;
  }

  private async embedImages(config: HnswImageIndexConfig, images: Buffer[]): Promise<Float32Array | null> {
    const vectors = (
      await Promise.all(
        images.map(async (image, idx) => {
          try {
            return await config.imageEmbeddingFn(image);
          } catch (err) {
            console.warn(`[HNSW] image embedding failed for image ${idx} (${image.length} bytes):`, err);
            return null;
          }
        }),
      )
    ).filter((vector): vector is Float32Array => vector !== null);
    if (vectors.length === 0) return null;
    if (vectors.length === 1) return vectors[0];

    const combined = new Float32Array(config.dimension);
    for (const vector of vectors) {
      for (let i = 0; i < combined.length; i++) combined[i] += vector[i] ?? 0;
    }
    for (let i = 0; i < combined.length; i++) combined[i] /= vectors.length;
    return this.l2Normalize(combined);
  }

  private l2Normalize(vector: Float32Array): Float32Array {
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0) return vector;
    for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    return vector;
  }

  /**
   * Return the in-memory HNSW index for `collectionName`, creating it (and
   * its backing blocks inside the shared FreeBlockFile) if it does not yet
   * exist.
   */
  private async getOrCreateHnswIndex(indexKey: string): Promise<HNSWIndex> {
    const cached = this.hnswIndexCache.get(indexKey);
    if (cached) return cached;

    const hnswMeta = this.getHnswMeta();
    let idx: HNSWIndex;

    if (hnswMeta && indexKey in hnswMeta) {
      // Blocks already exist for this index — open them.
      idx = await this.openHnswIndex(indexKey);
    } else {
      // First time this index is seen — allocate blocks and initialise.
      idx = await this.createHnswIndex(indexKey);
    }

    this.hnswIndexCache.set(indexKey, idx);
    return idx;
  }

  /** Create brand-new HNSW structures for `indexKey` inside the shared FBF. */
  private async createHnswIndex(indexKey: string): Promise<HNSWIndex> {
    const cfg = this.hnswConfigForIndexKey(indexKey);
    if (!cfg) throw new Error(`No HNSW config available for index "${indexKey}"`);
    const M = cfg.M ?? 16;
    const maxStoredLevel = cfg.maxStoredLevel ?? 4;
    const efConstruction = cfg.efConstruction ?? 200;
    const efSearch = cfg.efSearch ?? 50;
    const vectorHeap = new VectorHeapFile(this.freeblockFile, cfg.dimension);
    this.beginMutation();

    // Both graph storage and vector heap live inside the shared FBF.
    const graphStorage = await HNSWGraphStorage.create(this.freeblockFile, M, maxStoredLevel, cfg.dimension);

    // Persist the metadata block number so we can reopen on next open().
    this.getHnswMeta()[indexKey] = [graphStorage.metaBlockId, 'hnsw'];

    return HNSWIndex.create(graphStorage, vectorHeap, { M, efConstruction, efSearch });
  }

  /** Open existing HNSW structures for `indexKey` from the shared FBF. */
  private async openHnswIndex(indexKey: string): Promise<HNSWIndex> {
    const cfg = this.hnswConfigForIndexKey(indexKey);
    if (!cfg) throw new Error(`No HNSW config available for index "${indexKey}"`);
    // metaBlockId is stored in [0] of the tuple
    const metaBlockId = this.getHnswMeta()[indexKey][0];

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
    this.assertHealthy();
    const result: Record<string, Record<string, [number, string]>> = safeDictionary();

    for (const [key, value] of Object.entries(this.metaCache)) {
      if (RESERVED_META_KEYS.has(key)) continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const collectionMeta = value as Record<string, [number, string]>;
        const copiedCollectionMeta: Record<string, [number, string]> = safeDictionary();

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
    this.assertHealthy();
    const result: Record<string, FieldCompressionDefaults> = safeDictionary();
    for (const [collection, defaults] of Object.entries(this.getCompressionMeta())) {
      result[collection] = safeDictionary(defaults);
    }
    return result;
  }

  /**
   * Return a snapshot of HNSW metadata for the vacuum subsystem.
   */
  getVacuumHnswMetaSnapshot(): Record<string, [number, string]> {
    this.assertHealthy();
    const result: Record<string, [number, string]> = safeDictionary();
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
    return this.mutate(async () => {
      const result = await runVacuumCompactInto(
        {
          source: this,
          tempDataFile,
          tempLogFile,
          validate: true,
          rebuildHnsw: true,
          onProgress,
        },
        () => this.commitInternal(),
      );
      return result.target;
    });
  }

  /**
   * Return the names of all collections in the database.
   */
  listCollections(): string[] {
    this.assertHealthy();
    return Object.keys(this.metaCache).filter((k) => !RESERVED_META_KEYS.has(k) && this.hasCollectionMeta(k));
  }

  /**
   * Return field names and inferred types for a collection, derived from the
   * B+ tree metadata.
   *
   * The "vorm" encoding: for the 'id' field it is a single char ('S' or 'N');
   * for other indexed fields it is two chars where the first is the field type.
   * Booleans are stored as 'N' (numbers) so they appear as 'number' here -
   * sample-based refinement can correct that.
   */
  describeCollection(collection: string): { name: string; type: 'string' | 'number' }[] {
    this.assertHealthy();
    if (!this.hasCollectionMeta(collection)) return [];
    const meta = this.getCollectionMeta(collection);
    const fields: { name: string; type: 'string' | 'number' }[] = [];

    for (const [fieldName, [, vorm]] of Object.entries(meta)) {
      if (fieldName === 'id') {
        fields.push({ name: 'id', type: vorm === 'N' ? 'number' : 'string' });
      } else {
        const fieldTypeChar = vorm.charAt(0);
        fields.push({ name: fieldName, type: fieldTypeChar === 'N' ? 'number' : 'string' });
      }
    }

    return fields;
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
  metaWriteJSON(meta: MetaCache): Promise<void> {
    return this.mutate(() => this.metaWriteJSONInternal(meta));
  }

  private async metaWriteJSONInternal(meta: MetaCache): Promise<void> {
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
    this.beginMutation();

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

/** Reject partial or malformed positions before invoking B+ tree key comparators. */
function validateCompleteCursorKey(key: Buffer, form: string): void {
  if (!Buffer.isBuffer(key)) throw new InvalidCursorError('missing index key');
  let offset = 0;
  const readNumber = () => {
    if (offset + 8 > key.length || !Number.isFinite(key.readDoubleBE(offset))) {
      throw new InvalidCursorError('invalid numeric key component');
    }
    offset += 8;
  };
  const readString = (lengthPrefixed: boolean) => {
    let length = key.length - offset;
    if (lengthPrefixed) {
      if (offset + 2 > key.length) throw new InvalidCursorError('incomplete string key component');
      length = key.readUInt16BE(offset);
      offset += 2;
    }
    if (offset + length > key.length) throw new InvalidCursorError('incomplete string key component');
    const bytes = key.subarray(offset, offset + length);
    if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
      throw new InvalidCursorError('invalid UTF-8 key component');
    }
    offset += length;
  };
  if (form === 'S') readString(false);
  else if (form === 'N') readNumber();
  else if (['SS', 'SN', 'NS', 'NN'].includes(form)) {
    for (const component of form) {
      if (component === 'S') readString(true);
      else readNumber();
    }
  } else throw new InvalidCursorError('unsupported index key type');
  if (offset !== key.length) throw new InvalidCursorError('unexpected trailing key bytes');
}

/** Gets the existing index comparison function for the specified key form. */
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
      if (a.length < 16 || b.length < 16) return 0;
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
