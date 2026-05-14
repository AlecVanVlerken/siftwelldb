// @author Alexandre-Gatien Bienfet
// @date 2026-03-31

import * as fs from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  SimpleDbms,
  type HnswConfig,
  type CompressionProfileSummary,
  type CompressionRecommendation,
  type CompressionRecommendationItem,
  type CompressionRecommendationRequest,
} from '../dbms/simpledbms.mjs';
import { listAvailableCompressionProfiles } from '../dbms/compression-advisor.mjs';
import { type CompressionAlgorithm } from '../dbms/compression.mjs';
import { imageMimeForField, isImageField } from '../dbms/document.mjs';
import { generateWikiArticles } from '../dbms/lab-fixtures/wiki.mjs';
import { RealFile } from '../core/file.mjs';
import type { IncrementalCompactionPolicy, IncrementalCompactionResult } from '../compaction/compaction.mjs';
import { fetchPageCursor } from '../largedatasets/pagination.mjs';
import { searchWordIndex, searchContentIndex } from '../largedatasets/wordindex.mjs';
import { QueryLanguage, type QueryResultRow } from '../dbms/querylanguage/querylanguage.mjs';
import { getClipHnswConfig } from './clipHnswConfig.mjs';
import { generateDemoEmployees, generateSemanticKnowledgeDemoDocuments } from './demoData.mjs';

export type LabPolicyKey = 'none-uniform' | 'gzip-uniform' | 'zstd-uniform' | 'gzip-everything' | 'advisor-mix';

export type LabPolicyTotals = {
  totalBytes: number;
  totalBlocks: number;
  blocksSavedVsRaw: number;
  writeCostMs: number;
  readAmplification: number;
};

export type LabFieldReport = {
  field: string;
  recommended: CompressionAlgorithm;
  summary: string;
  rationale: string;
  detectedProfile: CompressionProfileSummary;
  activeProfile: CompressionProfileSummary;
  avgBytes: number | null;
  presenceRate: number;
  documentsScanned: number;
  ranking: Array<{
    algorithm: CompressionAlgorithm;
    score: number;
    blocksSaved: number;
    bytesSaved: number;
    writeCostMs: number;
  }>;
};

export type LabReport = {
  collection: string;
  workload: number;
  sampleSize: number;
  baseline: {
    totalBytes: number;
    totalBlocks: number;
    blockSize: number | null;
    dataBytesPerBlock: number | null;
  };
  perField: LabFieldReport[];
  policies: Record<LabPolicyKey, LabPolicyTotals>;
};

type LabRecommendationBundle = {
  field: string;
  isImage: boolean;
  recommendation: CompressionRecommendation;
  forcedGzipBytesSaved: number | null;
};

export type QueryExecutionResult = {
  rows: QueryResultRow[];
  rowCount: number;
  kind: 'select' | 'insert' | 'update' | 'delete' | 'explain';
  elapsedMs: number;
};

/**
 * Delete a file if it exists (ignores the error if not found).
 *
 * @param {string} filePath The path to the file to delete.
 * @returns {Promise<void>}
 *
 * @author Alexandre-Gatien Bienfet
 */
async function deleteIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // File doesn't exist — that's fine
  }
}

async function renameIfExists(source: string, target: string): Promise<boolean> {
  try {
    await fs.rename(source, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function sizeOrZero(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

export type DatabaseSizeInfo = {
  dataFileBytes: number;
  logFileBytes: number;
  totalBytes: number;
  activeDataBytes?: number;
  freeDataBytes?: number;
  amplification?: number;
  totalBlocks?: number;
  usedBlocks?: number;
  freeBlocks?: number;
  freeTailBlocks?: number;
};

export type DatabaseStatus = {
  connected: boolean;
  filepath: string | null;
  busyOperation: string | null;
  size: DatabaseSizeInfo | null;
  incrementalCompaction: IncrementalCompactionStatus;
  semanticIndexes: string[];
};

export type IncrementalCompactionStatus = {
  enabled: boolean;
  queued: boolean;
  running: boolean;
  intervalMs: number;
  policy: IncrementalCompactionPolicy;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastResult: IncrementalCompactionResult | null;
};

export type VacuumSummary = {
  filepath: string;
  before: DatabaseSizeInfo;
  after: DatabaseSizeInfo;
  bytesSaved: number;
  durationMs: number;
};

export type DatabaseServiceOptions = {
  hnswConfig?: HnswConfig | (() => HnswConfig | Promise<HnswConfig>);
  incrementalCompactionIntervalMs?: number;
  incrementalCompactionPolicy?: IncrementalCompactionPolicy;
};

const DEFAULT_INCREMENTAL_COMPACTION_INTERVAL_MS = 5_000;

const DEFAULT_INCREMENTAL_COMPACTION_POLICY: IncrementalCompactionPolicy = {
  maxAmplification: 1.6,
  softAmplification: 1.45,
  targetBatchDocuments: 4,
  targetBatchUnits: 2,
  maxStepsPerRun: 4,
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function rankingItem(
  recommendation: CompressionRecommendation,
  algorithm: CompressionAlgorithm,
): CompressionRecommendationItem {
  const item = recommendation.ranking.find((entry) => entry.algorithm === algorithm);
  if (!item) throw new Error(`Compression ranking missing algorithm: ${algorithm}`);
  return item;
}

/**
 * Manages the lifecycle of a SimpleDbms instance and exposes
 * high-level operations on collections and documents.
 * All database interaction from the HTTP layer should go through
 * this service.
 *
 * Every database the service opens is wired up with the selected
 * `HnswConfig`, so semantic search works on the first insert without
 * any "rebuild index" dance. The embedding weights themselves are
 * loaded lazily on the first embedding call, so opening a database is
 * still cheap.
 *
 * @author Alexandre-Gatien Bienfet
 */
export type CollectionStorage = {
  collection: string;
  documentCount: number;
  blockSize: number;
  recordBytes: number;
  /** Methodology used per category. Each entry describes what was measured and what was excluded. */
  notes: { records: string; indexes: string };
};

export class DatabaseService {
  private dbms: SimpleDbms | null = null;
  private currentFilepath: string | null = null;
  private operationChain: Promise<void> = Promise.resolve();
  private readonly exclusiveContext = new AsyncLocalStorage<symbol>();
  private currentOperation: string | null = null;
  private incrementalCompactionEnabled = false;
  private incrementalCompactionQueued = false;
  private incrementalCompactionActive = false;
  private incrementalCompactionTimer: ReturnType<typeof setInterval> | null = null;
  private incrementalCompactionLastRunAt: Date | null = null;
  private incrementalCompactionLastDurationMs: number | null = null;
  private incrementalCompactionLastError: string | null = null;
  private incrementalCompactionLastResult: IncrementalCompactionResult | null = null;

  private readonly incrementalCompactionIntervalMs: number;
  private readonly incrementalCompactionPolicy: IncrementalCompactionPolicy;

  // HNSW semantic search config
  private hnswConfigPromise: Promise<HnswConfig> | null = null;
  private readonly providedHnswConfig?: HnswConfig | (() => HnswConfig | Promise<HnswConfig>);
  /** Per-collection cache of `getCollectionRecordBytes`. Invalidated on inserts/edits/deletes. */
  private recordBytesCache: Map<string, number> = new Map();

  constructor(options: DatabaseServiceOptions = {}) {
    this.providedHnswConfig = options.hnswConfig;
    this.incrementalCompactionIntervalMs =
      options.incrementalCompactionIntervalMs ?? DEFAULT_INCREMENTAL_COMPACTION_INTERVAL_MS;
    this.incrementalCompactionPolicy = options.incrementalCompactionPolicy ?? DEFAULT_INCREMENTAL_COMPACTION_POLICY;
  }

  private getHnswConfig(): Promise<HnswConfig> {
    if (!this.hnswConfigPromise) {
      if (this.providedHnswConfig) {
        this.hnswConfigPromise =
          typeof this.providedHnswConfig === 'function'
            ? Promise.resolve(this.providedHnswConfig())
            : Promise.resolve(this.providedHnswConfig);
        return this.hnswConfigPromise;
      }

      this.hnswConfigPromise = Promise.resolve(getClipHnswConfig());
    }
    return this.hnswConfigPromise;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  /** True when a database is currently connected. */
  get isConnected(): boolean {
    return this.dbms !== null;
  }

  /** The filepath of the currently connected database, or null. */
  get filepath(): string | null {
    return this.currentFilepath;
  }

  /** The operation currently holding exclusive DB access, if any. */
  get busyOperation(): string | null {
    return this.currentOperation;
  }

  /**
   * Connect to an existing database or create a new one if the
   * file does not exist yet.
   */
  async connect(filepath: string): Promise<string> {
    return this.runExclusive('connect', async () => {
      await this.closeInternal();

      const hnswConfig = await this.getHnswConfig();

      // Check file existence right before opening to avoid race conditions
      // (e.g. file state changing during the slow HNSW model loading above).
      let fileExists = false;
      try {
        await fs.access(filepath);
        fileExists = true;
      } catch {
        fileExists = false;
      }

      const dataFile = new RealFile(filepath);
      const logFile = new RealFile(this.logFilepath(filepath));

      if (fileExists) {
        this.dbms = await SimpleDbms.open(dataFile, logFile, hnswConfig);
        this.currentFilepath = filepath;
        this.onDatabaseOpened();
        return 'Connected to existing database';
      } else {
        this.dbms = await SimpleDbms.create(dataFile, logFile, hnswConfig);
        await this.dbms.commit();
        this.currentFilepath = filepath;
        this.onDatabaseOpened();
        return 'Created new database';
      }
    });
  }

  /**
   * Force-create a new database, deleting any existing files first.
   */
  async create(filepath: string): Promise<string> {
    return this.runExclusive('create', async () => {
      await this.closeInternal();

      await deleteIfExists(filepath);
      await deleteIfExists(this.logFilepath(filepath));

      const dataFile = new RealFile(filepath);
      const logFile = new RealFile(this.logFilepath(filepath));
      const hnswConfig = await this.getHnswConfig();

      this.dbms = await SimpleDbms.create(dataFile, logFile, hnswConfig);
      await this.dbms.commit();
      this.currentFilepath = filepath;
      this.onDatabaseOpened();
      return 'Created new database';
    });
  }

  /** Disconnect from the current database. */
  async disconnect(): Promise<void> {
    await this.runExclusive('disconnect', async () => this.closeInternal());
  }

  /**
   * Reset the database by dropping all data and re-creating from scratch.
   */
  async reset(): Promise<void> {
    const filepath = this.currentFilepath;
    if (!filepath) throw new Error('No filepath available');

    await this.runExclusive('reset', async () => {
      await this.closeInternal();

      await deleteIfExists(filepath);
      await deleteIfExists(this.logFilepath(filepath));

      const dataFile = new RealFile(filepath);
      const logFile = new RealFile(this.logFilepath(filepath));
      const hnswConfig = await this.getHnswConfig();

      this.dbms = await SimpleDbms.create(dataFile, logFile, hnswConfig);
      await this.dbms.commit();
      this.currentFilepath = filepath;
      this.onDatabaseOpened();
    });
  }

  /** Return connection and file-size information for the current database. */
  async getStatus(): Promise<DatabaseStatus> {
    return this.runExclusive('status', async () => ({
      connected: this.isConnected,
      filepath: this.currentFilepath,
      busyOperation: this.busyOperation,
      size: this.currentFilepath ? await this.databaseSizeInfo(this.currentFilepath) : null,
      incrementalCompaction: this.getIncrementalCompactionStatus(),
      semanticIndexes: this.dbms ? this.dbms.getHnswIndexKeys() : [],
    }));
  }

  setIncrementalCompactionEnabled(enabled: boolean): IncrementalCompactionStatus {
    this.incrementalCompactionEnabled = enabled;
    this.incrementalCompactionLastError = null;
    console.log(`[compaction] auto compact ${enabled ? 'enabled' : 'disabled'}`);

    if (enabled) {
      this.startIncrementalCompactionTimer();
      this.scheduleIncrementalCompaction();
    } else {
      this.incrementalCompactionQueued = false;
      this.stopIncrementalCompactionTimer();
    }

    return this.getIncrementalCompactionStatus();
  }

  async runIncrementalCompactionStep(): Promise<IncrementalCompactionStatus> {
    return this.runExclusive('incremental-compaction', async () => {
      this.ensureConnected();
      const start = Date.now();
      this.incrementalCompactionActive = true;
      this.incrementalCompactionQueued = false;
      console.log('[compaction] manual incremental step started');
      try {
        const result = await this.dbms!.runIncrementalCompactionStep(this.incrementalCompactionPolicy);
        this.incrementalCompactionLastRunAt = new Date();
        this.incrementalCompactionLastDurationMs = Date.now() - start;
        this.incrementalCompactionLastResult = result;
        this.incrementalCompactionLastError = null;
        this.incrementalCompactionActive = false;
        console.log(
          `[compaction] manual incremental step complete in ${this.incrementalCompactionLastDurationMs}ms: ${JSON.stringify(result)}`,
        );
        return this.getIncrementalCompactionStatus();
      } catch (error) {
        this.incrementalCompactionLastError = String(error);
        console.error('[compaction] manual incremental step failed:', error);
        throw error;
      } finally {
        this.incrementalCompactionActive = false;
      }
    });
  }

  /**
   * Rebuild the current database into fresh files and swap them into place.
   */
  async vacuum(): Promise<VacuumSummary> {
    return this.runExclusive('vacuum', async () => {
      this.ensureConnected();
      const filepath = this.currentFilepath;
      if (!filepath) throw new Error('No filepath available');

      const logPath = this.logFilepath(filepath);
      const before = await this.databaseSizeInfo(filepath);
      const stamp = Date.now().toString(36);
      const tempPath = `${filepath}.vacuum-${stamp}.tmp`;
      const tempLogPath = `${logPath}.vacuum-${stamp}.tmp`;
      const backupPath = `${filepath}.vacuum-${stamp}.bak`;
      const backupLogPath = `${logPath}.vacuum-${stamp}.bak`;
      const started = performance.now();
      let compacted: SimpleDbms | null = null;
      console.log(`[compaction] manual full vacuum started for ${filepath}`);

      try {
        compacted = await this.dbms!.vacuumCompactInto(new RealFile(tempPath), new RealFile(tempLogPath));
        await compacted.close();
        compacted = null;

        await this.closeInternal();

        const dataBackedUp = await renameIfExists(filepath, backupPath);
        const logBackedUp = await renameIfExists(logPath, backupLogPath);

        try {
          await fs.rename(tempPath, filepath);
          if (!(await renameIfExists(tempLogPath, logPath))) {
            await fs.writeFile(logPath, '');
          }
        } catch (error) {
          if (dataBackedUp) await renameIfExists(backupPath, filepath);
          if (logBackedUp) await renameIfExists(backupLogPath, logPath);
          throw error;
        }

        await deleteIfExists(backupPath);
        await deleteIfExists(backupLogPath);
        await deleteIfExists(tempPath);
        await deleteIfExists(tempLogPath);

        const hnswConfig = await this.getHnswConfig();
        this.dbms = await SimpleDbms.open(new RealFile(filepath), new RealFile(logPath), hnswConfig);
        this.currentFilepath = filepath;
        this.onDatabaseOpened();

        const after = await this.databaseSizeInfo(filepath);
        const summary = {
          filepath,
          before,
          after,
          bytesSaved: before.totalBytes - after.totalBytes,
          durationMs: performance.now() - started,
        };
        console.log(
          `[compaction] manual full vacuum complete in ${summary.durationMs.toFixed(0)}ms: saved ${summary.bytesSaved} bytes (${before.totalBytes} -> ${after.totalBytes})`,
        );
        return summary;
      } catch (error) {
        console.error('[compaction] manual full vacuum failed:', error);
        if (compacted) {
          try {
            await compacted.close();
          } catch (closeError) {
            console.error('Failed to close compacted database after vacuum error:', closeError);
          }
        }
        await deleteIfExists(tempPath);
        await deleteIfExists(tempLogPath);
        throw error;
      }
    });
  }

  // ── Collections ──────────────────────────────────────────────

  /** Return the list of collection names, hiding internal _-prefixed ones. */
  async getCollections(): Promise<string[]> {
    return this.runExclusive('list-collections', async () => this.getCollectionsUnlocked());
  }

  private async getCollectionsUnlocked(): Promise<string[]> {
    this.ensureConnected();
    const all = await this.dbms!.getCollections();
    return all.filter((c) => !c.startsWith('_'));
  }

  /** Delete an entire collection. */
  async deleteCollection(collection: string): Promise<void> {
    await this.runExclusive('delete-collection', async () => {
      this.ensureConnected();
      await this.dbms!.deleteCollection(collection);
      await this.dbms!.commit();
    });
    this.recordBytesCache.delete(collection);
    if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();
  }

  listCompressionProfiles(): CompressionProfileSummary[] {
    return this.dbms ? this.dbms.listCompressionProfiles() : listAvailableCompressionProfiles();
  }

  async getCompressionDefaults(collection: string): Promise<Record<string, CompressionAlgorithm>> {
    return this.runExclusive('compression-defaults', async () => {
      this.ensureConnected();
      return this.dbms!.getFieldCompressionDefaults(collection);
    });
  }

  async recommendCompression(request: CompressionRecommendationRequest): Promise<CompressionRecommendation> {
    return this.runExclusive('compression-recommendation', async () => {
      this.ensureConnected();
      return this.dbms!.recommendCompression(request);
    });
  }

  /**
   * Rebuild the deterministic Wikipedia-style Compression Lab collection.
   */
  async seedWikiLab(options: { count?: number } = {}): Promise<{ collection: string; inserted: number }> {
    const collection = 'wiki_lab';
    let inserted = 0;

    await this.runExclusive('seed-wiki-lab', async () => {
      this.ensureConnected();

      try {
        await this.dbms!.deleteCollection(collection);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('does not exist')) {
          throw error;
        }
      }

      const articles = generateWikiArticles({ count: options.count });
      for (const article of articles) {
        await this.dbms!.insertDocumentObject(collection, article, {
          skipSemanticIndex: true,
          indexPredicate: (field) => field === 'title',
        });
      }
      await this.dbms!.commit();
      inserted = articles.length;
    });
    if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();

    return { collection, inserted };
  }

  /**
   * Build a read-only Compression Lab report for a collection.
   */
  async recommendCollectionLab(request: {
    collection: string;
    workload?: number;
    sampleSize?: number;
  }): Promise<LabReport> {
    return this.runExclusive('compression-lab-report', async () => this.recommendCollectionLabUnlocked(request));
  }

  private async recommendCollectionLabUnlocked(request: {
    collection: string;
    workload?: number;
    sampleSize?: number;
  }): Promise<LabReport> {
    this.ensureConnected();

    const workload = clamp01(request.workload ?? 0);
    const sampleSize = Math.max(1, Math.floor(request.sampleSize ?? 100));
    const documents = await this.loadLabDocuments(request.collection, sampleSize);
    if (documents.length === 0) {
      throw new Error(`Collection "${request.collection}" has no documents`);
    }

    const fields = Object.keys(documents[0]).filter(
      (field) => field !== 'id' && field !== '_order_' && !field.startsWith('_layout_'),
    );
    if (fields.length === 0) {
      throw new Error(`Collection "${request.collection}" has no recommendable fields`);
    }

    const bundles: LabRecommendationBundle[] = [];
    for (const field of fields) {
      const isImage = this.isLabImageField(field, documents);
      const recommendation = await this.dbms!.recommendCompression({
        collection: request.collection,
        field,
        workload,
        sampleSize,
      });
      bundles.push({
        field,
        isImage,
        recommendation,
        forcedGzipBytesSaved: isImage ? this.estimateForcedGzipBytesSaved(field, documents) : null,
      });
    }

    const baseline = this.labBaseline(bundles);
    const policies = this.aggregateLabPolicies(bundles, baseline);

    return {
      collection: request.collection,
      workload,
      sampleSize,
      baseline,
      perField: bundles.map(({ field, recommendation }) => this.toLabFieldReport(field, recommendation)),
      policies,
    };
  }

  /**
   * Persist the current lab advisor policy as field compression defaults.
   * The policy affects future writes only; existing records are not rewritten.
   */
  async applyCollectionLabAdvice(request: {
    collection: string;
    workload?: number;
    sampleSize?: number;
  }): Promise<{ collection: string; defaults: Record<string, CompressionAlgorithm>; fields: number }> {
    return this.runExclusive('compression-lab-apply-advice', async () => {
      this.ensureConnected();

      const report = await this.recommendCollectionLabUnlocked(request);
      const defaults: Record<string, CompressionAlgorithm> = {};
      for (const field of report.perField) {
        defaults[field.field] = field.recommended;
      }

      this.dbms!.setFieldCompressionDefaults(request.collection, defaults);
      await this.dbms!.commit();

      return {
        collection: request.collection,
        defaults,
        fields: Object.keys(defaults).length,
      };
    });
  }

  /**
   * On-disk byte footprint of a single document, walked from the
   * document's head block: `chainLength × blockSize`. Excludes any
   * index entries shared across the collection.
   */
  async getDocumentStoredBytes(collection: string, id: string): Promise<number> {
    this.ensureConnected();
    return this.dbms!.getDocumentStoredBytes(collection, id);
  }

  /**
   * Per-collection storage breakdown. Currently accounts for the
   * record-block chains accurately; B+ tree and HNSW index blocks
   * are not yet enumerable through the public API and are surfaced
   * via the `notes.indexes` message so the UI can be honest about it.
   * The records figure is cached and invalidated on writes.
   */
  async getCollectionStorage(collection: string): Promise<CollectionStorage> {
    return this.runExclusive('collection-storage', async () => this.getCollectionStorageUnlocked(collection));
  }

  private async getCollectionStorageUnlocked(collection: string): Promise<CollectionStorage> {
    this.ensureConnected();
    const blockSize = this.dbms!.getBlockSize();
    const cached = this.recordBytesCache.get(collection);
    let recordBytes: number;
    if (cached !== undefined) {
      recordBytes = cached;
    } else {
      recordBytes = await this.dbms!.getCollectionRecordBytes(collection);
      this.recordBytesCache.set(collection, recordBytes);
    }
    const docs = await this.getDocumentsUnlocked(collection, 'id', undefined, 100000);
    return {
      collection,
      documentCount: docs.documents.length,
      blockSize,
      recordBytes,
      notes: {
        records: `Sum of (chainLength × blockSize) across all documents in this collection. Block size is ${blockSize} bytes.`,
        indexes: 'B+ tree indexes and the HNSW vector index are not yet accounted for in this number.',
      },
    };
  }

  // ── Documents ────────────────────────────────────────────────

  /** Fetch a cursor-paginated page of documents from a collection. */
  async getDocuments(
    collection: string,
    iterableKey: string = 'id',
    cursor?: string,
    limit: number = 50,
  ): Promise<{ documents: string[]; hasMore: boolean; nextCursor?: string | number }> {
    return this.runExclusive('get-documents', async () =>
      this.getDocumentsUnlocked(collection, iterableKey, cursor, limit),
    );
  }

  private async getDocumentsUnlocked(
    collection: string,
    iterableKey: string = 'id',
    cursor?: string,
    limit: number = 50,
  ): Promise<{ documents: string[]; hasMore: boolean; nextCursor?: string | number }> {
    this.ensureConnected();
    const page = await fetchPageCursor(this.dbms!, { collection, iterableKey, limit, afterCursor: cursor });
    return { documents: page.data, hasMore: page.hasMore, nextCursor: page.nextCursor };
  }

  /** Find all articles containing a word via the persistent word index. */
  async wordSearch(
    collection: string,
    word: string,
    limit: number,
    offset: number,
  ): Promise<{ documents: string[]; total: number; hasMore: boolean }> {
    return this.runExclusive('word-search', async () => {
      this.ensureConnected();
      const { docIds, total, hasMore } = await searchWordIndex(this.dbms!, word, limit, offset);
      const documents: string[] = [];
      for (const id of docIds) {
        try {
          documents.push(await this.dbms!.getDocumentById(collection, id));
        } catch {
          // Article deleted after indexing — skip silently
        }
      }
      return { documents, total, hasMore };
    });
  }

  /** Find all articles whose body contains a word via the persistent content index. */
  async contentSearch(
    collection: string,
    word: string,
    limit: number,
    offset: number,
  ): Promise<{ documents: string[]; total: number; hasMore: boolean }> {
    return this.runExclusive('content-search', async () => {
      this.ensureConnected();
      const { docIds, total, hasMore } = await searchContentIndex(this.dbms!, word, limit, offset);
      const documents: string[] = [];
      for (const id of docIds) {
        try {
          documents.push(await this.dbms!.getDocumentById(collection, id));
        } catch {
          // Article deleted after indexing — skip silently
        }
      }
      return { documents, total, hasMore };
    });
  }

  /** Insert a document into a collection. */
  async insertDocument(
    collection: string,
    document: unknown,
    compression?: import('../dbms/compression.mts').FieldCompressionOverrides,
  ): Promise<void> {
    await this.runExclusive('insert-document', async () => {
      this.ensureConnected();
      await this.dbms!.insertDocumentObject(collection, document, {
        compression,
        indexPredicate: collection === 'wiki_lab' ? (field) => field === 'title' : undefined,
      });
      await this.dbms!.commit();
    });
    this.recordBytesCache.delete(collection);
    if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();
  }

  /** Retrieve a specific document by its ID. */
  async getDocumentById(collection: string, id: string, options?: { encoded?: boolean }): Promise<string> {
    return this.runExclusive('get-document', async () => {
      this.ensureConnected();
      return this.dbms!.getDocumentById(collection, id, options);
    });
  }

  /**
   * Delete a document from a collection.
   *
   * For HNSW-backed collections this is a logical delete at the GUI layer: the
   * DBMS removes normal lookup paths and tombstones the semantic entry, while
   * full vacuum later removes the retained tombstone storage.
   */
  async deleteDocument(collection: string, id: string): Promise<void> {
    await this.runExclusive('delete-document', async () => {
      this.ensureConnected();
      await this.dbms!.deleteDocumentById(collection, id);
      await this.dbms!.commit();
    });
    this.recordBytesCache.delete(collection);
    if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();
  }

  /** Edit a single field in a document by ID. */
  async editDocument(collection: string, id: string, field: string, value: unknown): Promise<void> {
    await this.runExclusive('edit-document', async () => {
      this.ensureConnected();
      await this.dbms!.editDocument(collection, id, field, value as Parameters<SimpleDbms['editDocument']>[3]);
      await this.dbms!.commit();
    });
    this.recordBytesCache.delete(collection);
    if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();
  }

  /**
   * Replace an entire document by ID. Wire-compatible single round-trip
   * for the data-tab edit drawer — the underlying engine still does a
   * delete + reinsert atomically.
   */
  async replaceDocument(
    collection: string,
    id: string,
    newDocument: unknown,
    compression?: import('../dbms/compression.mts').FieldCompressionOverrides,
  ): Promise<void> {
    await this.runExclusive('replace-document', async () => {
      this.ensureConnected();
      await this.dbms!.replaceDocument(collection, id, newDocument, { compression });
      await this.dbms!.commit();
    });
    this.recordBytesCache.delete(collection);
    if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();
  }

  /**
   * Execute a SQL-like statement through the embedded query language.
   *
   * Supports SELECT, INSERT, UPDATE, and DELETE. For mutating statements
   * the result rows are `{id}` per affected document so `rowCount` is
   * meaningful. The database is committed once at the end so a single
   * statement either fully lands on disk or doesn't.
   */
  async query(sql: string): Promise<QueryExecutionResult> {
    return this.runExclusive('query', async () => {
      this.ensureConnected();
      const ql = new QueryLanguage(this.dbms!);
      const parsed = ql.parse(sql);
      const start = Date.now();
      const rows = await ql.execute(sql);
      const elapsedMs = Date.now() - start;
      if (parsed.kind === 'insert' || parsed.kind === 'update' || parsed.kind === 'delete') {
        await this.dbms!.commit();
        this.recordBytesCache.clear();
      }
      return { rows, rowCount: rows.length, kind: parsed.kind, elapsedMs };
    });
  }

  /**
   * Seed the connected database with the built-in employee demo dataset.
   * If the `employees` collection already contains rows, this is a no-op.
   */
  async seedDemoEmployees(count: number = 200): Promise<{ collection: string; inserted: number; skipped: boolean }> {
    return this.runExclusive('seed-demo-employees', async () => {
      this.ensureConnected();
      console.log(`[seed] employees started count=${count.toString()}`);

      try {
        const existing = await this.getDocumentsUnlocked('employees', 'id', undefined, 1);
        if (existing.documents.length > 0) {
          console.log('[seed] employees skipped: collection already has rows');
          return { collection: 'employees', inserted: 0, skipped: true };
        }
      } catch {
        // Missing collection is expected for a fresh demo database.
      }

      const employees = generateDemoEmployees(count);
      for (const employee of employees) {
        await this.dbms!.insertDocumentObject('employees', employee);
      }
      await this.dbms!.commit();
      this.recordBytesCache.delete('employees');
      console.log(`[seed] employees complete inserted=${employees.length.toString()}`);
      return { collection: 'employees', inserted: employees.length, skipped: false };
    });
  }

  async seedSemanticKnowledgeDemo(): Promise<{ collection: string; inserted: number; skipped: boolean }> {
    return this.runExclusive('seed-semantic-knowledge', async () => {
      this.ensureConnected();
      const collection = 'knowledge';
      console.log('[seed] semantic knowledge started');

      try {
        const existing = await this.getDocumentsUnlocked(collection, 'id', undefined, 1);
        if (existing.documents.length > 0) {
          console.log('[seed] semantic knowledge skipped: collection already has rows');
          return { collection, inserted: 0, skipped: true };
        }
      } catch {
        // Missing collection is expected for a fresh demo database.
      }

      const documents = generateSemanticKnowledgeDemoDocuments();
      for (const document of documents) {
        await this.dbms!.insertDocumentObject(collection, document);
      }
      await this.dbms!.commit();
      this.recordBytesCache.delete(collection);
      if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();
      console.log(`[seed] semantic knowledge complete inserted=${documents.length.toString()}`);
      return { collection, inserted: documents.length, skipped: false };
    });
  }

  async seedSemanticImageDemo(): Promise<{ collection: string; inserted: number; skipped: boolean; source: string }> {
    return this.runExclusive('seed-semantic-images', async () => {
      this.ensureConnected();
      const collection = 'photos';
      console.log('[seed] semantic images started');

      try {
        const existing = await this.getDocumentsUnlocked(collection, 'id', undefined, 1);
        if (existing.documents.length > 0) {
          console.log('[seed] semantic images skipped: collection already has rows');
          return { collection, inserted: 0, skipped: true, source: 'existing collection' };
        }
      } catch {
        // Missing collection is expected for a fresh demo database.
      }

      const imageFiles = await this.semanticDemoImageFiles();
      for (const file of imageFiles) {
        const buffer = await fs.readFile(file.path);
        await this.dbms!.insertDocumentObject(collection, {
          id: file.id,
          label: file.label,
          image: buffer.toString('base64'),
          _image_mime: this.imageMimeFromPath(file.path),
        });
      }
      await this.dbms!.commit();
      this.recordBytesCache.delete(collection);
      if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();
      console.log(`[seed] semantic images complete inserted=${imageFiles.length.toString()}`);
      return {
        collection,
        inserted: imageFiles.length,
        skipped: false,
        source: imageFiles.length === 1 ? imageFiles[0].path : path.dirname(imageFiles[0].path),
      };
    });
  }

  /**
   * Semantic text-to-text search.
   *
   * The storage layer filters tombstoned entries, and the service keeps this
   * read serialized with delete/compaction/vacuum so result mapping cannot
   * race a tombstone write or HNSW unit relocation.
   */
  async semanticSearch(collection: string, query: string, limit: number): Promise<string[]> {
    return this.runExclusive('semantic-search', async () => {
      this.ensureConnected();
      return this.dbms!.semanticSearch(collection, query, limit);
    });
  }

  /** CLIP text-to-image search against image-only semantic vectors. */
  async semanticImageTextSearch(collection: string, query: string, limit: number): Promise<string[]> {
    return this.runExclusive('semantic-image-text-search', async () => {
      this.ensureConnected();
      return this.dbms!.semanticImageTextSearch(collection, query, limit);
    });
  }

  /** Semantic image-to-image search. */
  async semanticImageSearch(collection: string, queryImage: Buffer, limit: number): Promise<string[]> {
    return this.runExclusive('semantic-image-search', async () => {
      this.ensureConnected();
      return this.dbms!.semanticImageSearch(collection, queryImage, limit);
    });
  }

  /** Returns the underlying SimpleDbms instance (throws if not connected). */
  get rawDbms(): SimpleDbms {
    this.ensureConnected();
    return this.dbms!;
  }

  // ── Internal helpers ─────────────────────────────────────────

  private async loadLabDocuments(collection: string, limit: number): Promise<Array<Record<string, unknown>>> {
    const rawDocuments = await this.getDocuments(collection, 'id', undefined, limit);
    return rawDocuments.documents.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  private estimateForcedGzipBytesSaved(field: string, documents: Array<Record<string, unknown>>): number {
    let saved = 0;
    for (const document of documents) {
      const value = document[field];
      if (typeof value !== 'string' || value.length === 0) continue;
      const raw = Buffer.from(value, 'base64');
      const compressed = gzipSync(raw);
      const actualSaved = raw.toString('base64').length - compressed.toString('base64').length;
      // The lab sabotage policy intentionally models forcing gzip onto JPEG
      // payloads even when the storage layer would normally reject regressions.
      saved += Math.min(actualSaved, -Math.ceil(raw.length * 0.03));
    }
    return saved;
  }

  private isLabImageField(field: string, documents: Array<Record<string, unknown>>): boolean {
    return isImageField(field) || documents.some((document) => imageMimeForField(field, document) !== null);
  }

  private labBaseline(bundles: LabRecommendationBundle[]): LabReport['baseline'] {
    let totalBytes = 0;
    let totalBlocks = 0;
    let blockSize: number | null = null;
    let dataBytesPerBlock: number | null = null;

    for (const { recommendation } of bundles) {
      const estimate = rankingItem(recommendation, 'none').storageEstimate;
      if (!estimate) continue;
      if (estimate.rawSerializedBytes > totalBytes) totalBytes = estimate.rawSerializedBytes;
      if (estimate.rawBlocks > totalBlocks) totalBlocks = estimate.rawBlocks;
      blockSize = recommendation.analysis.blockSize ?? blockSize;
      dataBytesPerBlock = recommendation.analysis.dataBytesPerBlock ?? dataBytesPerBlock;
    }

    if (totalBytes === 0 || totalBlocks === 0) {
      throw new Error('Compression Lab could not compute a raw storage baseline');
    }

    return {
      totalBytes: blockSize === null ? totalBytes : totalBlocks * blockSize,
      totalBlocks,
      blockSize,
      dataBytesPerBlock,
    };
  }

  private aggregateLabPolicies(
    bundles: LabRecommendationBundle[],
    baseline: LabReport['baseline'],
  ): Record<LabPolicyKey, LabPolicyTotals> {
    const policies: LabPolicyKey[] = ['none-uniform', 'gzip-uniform', 'zstd-uniform', 'gzip-everything', 'advisor-mix'];
    const totals = {} as Record<LabPolicyKey, LabPolicyTotals>;

    for (const policy of policies) {
      let bytesSaved = 0;
      let blocksSaved = 0;
      let writeCostMs = 0;

      for (const bundle of bundles) {
        const algorithm = this.policyAlgorithm(policy, bundle);
        const item = rankingItem(bundle.recommendation, algorithm);
        const estimate = item.storageEstimate;
        if (!estimate) continue;

        if (policy === 'gzip-everything' && bundle.isImage && bundle.forcedGzipBytesSaved !== null) {
          bytesSaved += bundle.forcedGzipBytesSaved;
          if (baseline.dataBytesPerBlock && bundle.forcedGzipBytesSaved < 0) {
            blocksSaved -= Math.ceil(Math.abs(bundle.forcedGzipBytesSaved) / baseline.dataBytesPerBlock);
          } else if (baseline.dataBytesPerBlock) {
            blocksSaved += Math.floor(bundle.forcedGzipBytesSaved / baseline.dataBytesPerBlock);
          }
        } else {
          bytesSaved += estimate.rawSerializedBytes - estimate.compressedSerializedBytes;
          blocksSaved += estimate.blocksSaved;
        }

        writeCostMs += estimate.writeCost;
      }

      const totalBlocks = Math.max(1, baseline.totalBlocks - blocksSaved);
      const totalBytes =
        baseline.blockSize === null ? Math.max(1, baseline.totalBytes - bytesSaved) : totalBlocks * baseline.blockSize;
      totals[policy] = {
        totalBytes,
        totalBlocks,
        blocksSavedVsRaw: baseline.totalBlocks - totalBlocks,
        writeCostMs,
        readAmplification: baseline.totalBlocks === 0 ? 1 : totalBlocks / baseline.totalBlocks,
      };
    }

    return totals;
  }

  private policyAlgorithm(policy: LabPolicyKey, bundle: LabRecommendationBundle): CompressionAlgorithm {
    switch (policy) {
      case 'none-uniform':
        return 'none';
      case 'gzip-uniform':
        return bundle.isImage ? 'none' : 'gzip';
      case 'zstd-uniform':
        return 'zstd';
      case 'gzip-everything':
        return 'gzip';
      case 'advisor-mix':
        return bundle.recommendation.recommended;
    }
  }

  private toLabFieldReport(field: string, recommendation: CompressionRecommendation): LabFieldReport {
    return {
      field,
      recommended: recommendation.recommended,
      summary: recommendation.summary,
      rationale: rankingItem(recommendation, recommendation.recommended).rationale,
      detectedProfile: recommendation.detectedProfile,
      activeProfile: recommendation.activeProfile,
      avgBytes: recommendation.analysis.avgBytes,
      presenceRate: recommendation.analysis.fieldPresenceRate,
      documentsScanned: recommendation.analysis.documentsScanned,
      ranking: recommendation.ranking.map((item) => ({
        algorithm: item.algorithm,
        score: item.score,
        blocksSaved: item.storageEstimate?.blocksSaved ?? 0,
        bytesSaved: item.storageEstimate
          ? item.storageEstimate.rawSerializedBytes - item.storageEstimate.compressedSerializedBytes
          : 0,
        writeCostMs: item.storageEstimate?.writeCost ?? 0,
      })),
    };
  }

  private async semanticDemoImageFiles(): Promise<Array<{ id: string; label: string; path: string }>> {
    const imageDir = path.resolve('demo-db/images');
    const fallback = path.resolve('rabbit.jpg');
    try {
      const entries = await fs.readdir(imageDir);
      const images = entries
        .filter((entry) => /\.(jpe?g|png|webp)$/i.test(entry))
        .sort()
        .map((entry) => ({
          id: entry,
          label: entry.replace(/\.(jpe?g|png|webp)$/i, '').replace(/_/g, ' '),
          path: path.join(imageDir, entry),
        }));
      if (images.length > 0) return images;
    } catch {
      // The standalone image demo cache is optional for the webclient seed.
    }

    await fs.access(fallback);
    return [{ id: 'rabbit.jpg', label: 'rabbit', path: fallback }];
  }

  private imageMimeFromPath(filePath: string): string {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    return 'image/jpeg';
  }

  private ensureConnected(): void {
    if (!this.dbms) throw new Error('No database connected');
  }

  private getIncrementalCompactionStatus(): IncrementalCompactionStatus {
    return {
      enabled: this.incrementalCompactionEnabled,
      queued: this.incrementalCompactionQueued,
      running: this.incrementalCompactionActive || this.currentOperation === 'incremental-compaction',
      intervalMs: this.incrementalCompactionIntervalMs,
      policy: this.incrementalCompactionPolicy,
      lastRunAt: this.incrementalCompactionLastRunAt?.toISOString() ?? null,
      lastDurationMs: this.incrementalCompactionLastDurationMs,
      lastError: this.incrementalCompactionLastError,
      lastResult: this.incrementalCompactionLastResult,
    };
  }

  private onDatabaseOpened(): void {
    if (!this.incrementalCompactionEnabled) return;
    this.startIncrementalCompactionTimer();
    this.scheduleIncrementalCompaction();
  }

  private startIncrementalCompactionTimer(): void {
    if (this.incrementalCompactionTimer) return;

    console.log(`[compaction] auto compact timer started (${this.incrementalCompactionIntervalMs}ms interval)`);
    this.incrementalCompactionTimer = setInterval(() => {
      this.scheduleIncrementalCompaction();
    }, this.incrementalCompactionIntervalMs);
    this.incrementalCompactionTimer.unref?.();
  }

  private stopIncrementalCompactionTimer(): void {
    if (!this.incrementalCompactionTimer) return;
    clearInterval(this.incrementalCompactionTimer);
    this.incrementalCompactionTimer = null;
    console.log('[compaction] auto compact timer stopped');
  }

  private scheduleIncrementalCompaction(): void {
    if (!this.incrementalCompactionEnabled) return;
    if (!this.isConnected) return;
    if (this.incrementalCompactionQueued || this.incrementalCompactionActive) return;

    this.incrementalCompactionQueued = true;
    void this.runExclusive('incremental-compaction', async () => {
      this.incrementalCompactionQueued = false;
      if (!this.incrementalCompactionEnabled || !this.dbms) return;

      this.incrementalCompactionActive = true;
      const start = Date.now();
      try {
        // Incremental compaction can relocate HNSW graph/vector units,
        // including tombstoned routing artifacts. Keep it behind the same
        // service gate as semantic search and document writes so the GUI never
        // observes a half-relocated semantic index.
        console.log('[compaction] auto incremental check started');
        const result = await this.dbms.compactIfNeeded(this.incrementalCompactionPolicy);
        if (result !== null) {
          this.incrementalCompactionLastRunAt = new Date();
          this.incrementalCompactionLastDurationMs = Date.now() - start;
          this.incrementalCompactionLastResult = result;
          console.log(
            `[compaction] auto incremental step complete in ${this.incrementalCompactionLastDurationMs}ms: ${JSON.stringify(result)}`,
          );
        } else {
          console.log(`[compaction] auto incremental check complete in ${Date.now() - start}ms: no work needed`);
        }
        this.incrementalCompactionLastError = null;
      } finally {
        this.incrementalCompactionActive = false;
      }
    }).catch((error: unknown) => {
      this.incrementalCompactionQueued = false;
      this.incrementalCompactionActive = false;
      this.incrementalCompactionLastError = String(error);
      console.error('Incremental compaction failed:', error);
    });
  }

  private async runExclusive<T>(operation: string, task: () => Promise<T>): Promise<T> {
    if (this.exclusiveContext.getStore()) {
      return await task();
    }

    const previous = this.operationChain.catch(() => undefined);
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.operationChain = previous.then(() => current);

    await previous;
    this.currentOperation = operation;
    const token = Symbol(operation);
    try {
      return await this.exclusiveContext.run(token, task);
    } finally {
      this.currentOperation = null;
      release();
    }
  }

  async runExclusiveOperation<T>(operation: string, task: () => Promise<T>): Promise<T> {
    return this.runExclusive(operation, task);
  }

  private logFilepath(filepath: string): string {
    return `${filepath}.log`;
  }

  private async databaseSizeInfo(filepath: string): Promise<DatabaseSizeInfo> {
    const dataFileBytes = await sizeOrZero(filepath);
    const logFileBytes = await sizeOrZero(this.logFilepath(filepath));
    const info: DatabaseSizeInfo = {
      dataFileBytes,
      logFileBytes,
      totalBytes: dataFileBytes + logFileBytes,
    };

    if (this.dbms) {
      const stats = await this.dbms.getCompactionStorageStats().catch(() => null);
      if (stats) {
        info.activeDataBytes = stats.usedBlocks * stats.blockSize;
        info.freeDataBytes = stats.freeBlocks * stats.blockSize;
        info.amplification = stats.usedBlocks > 0 ? stats.totalBlocks / stats.usedBlocks : 1;
        info.totalBlocks = stats.totalBlocks;
        info.usedBlocks = stats.usedBlocks;
        info.freeBlocks = stats.freeBlocks;
        info.freeTailBlocks = stats.freeTailBlocks;
      }
    }

    return info;
  }

  private async closeInternal(): Promise<void> {
    if (this.dbms) {
      await this.dbms.close();
      this.dbms = null;
      this.currentFilepath = null;
    }
    this.incrementalCompactionQueued = false;
    this.incrementalCompactionActive = false;
    this.stopIncrementalCompactionTimer();
    this.recordBytesCache.clear();
  }
}
