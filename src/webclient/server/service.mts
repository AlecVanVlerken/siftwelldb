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
} from '../../database/simpledbms.mjs';
import { listAvailableCompressionProfiles } from '../../database/compression-advisor.mjs';
import {
  COMPRESSION_ALGORITHMS,
  type CompressionAlgorithm,
  type FieldCompressionDefaults,
  type FieldCompressionOverrides,
} from '../../database/compression.mjs';
import { imageMimeForField, isImageField } from '../../database/document.mjs';
import { generateWikiArticles } from '../fixtures/wiki.mjs';
import { RealFile } from '../../storage/file.mjs';
import type { IncrementalCompactionPolicy, IncrementalCompactionResult } from '../../compaction/compaction.mjs';
import { fetchPageCursor } from '../../database/pagination.mjs';
import { searchWordIndex, searchContentIndex } from '../../indexes/text/wordindex.mjs';
import { QueryLanguage, type QueryResultRow } from '../../query/querylanguage.mjs';
import { QueryMutationError } from '../../query/executor.mjs';
import { compareValues } from '../../query/expressions.mjs';
import { getClipHnswConfig } from './embedding-config.mjs';
import { generateDemoEmployees, generateSemanticKnowledgeDemoDocuments } from './demo-data.mjs';
import {
  assertNoVacuumArtifacts,
  finishVacuumReplacement,
  installVacuumReplacement,
  prepareVacuumReplacement,
  recoverVacuumReplacement,
  vacuumPaths,
} from './vacuum-recovery.mjs';

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
 * Sort comparator for the data-grid sort feature.
 *
 * Delegates to {@link compareValues} when the two values share a comparable
 * type and falls back to a deterministic string-coerced comparison when the
 * types differ. This is intentionally more lenient than the query engine's
 * ORDER BY (which surfaces type mismatches as errors): the data grid must
 * still produce a stable, predictable order over heterogeneous documents.
 *
 * Null and undefined always sort first in ascending order — the caller
 * flips the sign when descending is requested.
 */
function compareDataGridValues(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  try {
    return compareValues(a, b);
  } catch {
    const as = typeof a === 'string' ? a : JSON.stringify(a);
    const bs = typeof b === 'string' ? b : JSON.stringify(b);
    if (as < bs) return -1;
    if (as > bs) return 1;
    return 0;
  }
}

async function deleteIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
  /** Physical database data-file bytes. The WAL is reported separately. */
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
  semanticReindexPending: string[];
};

export class DatabaseInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseInputError';
  }
}

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
  indexedFields: string[];
  fieldIndexes: Record<string, boolean>;
  /** Methodology used per category. Each entry describes what was measured and what was excluded. */
  notes: { records: string; indexes: string };
};

export class DatabaseService {
  private dbms: SimpleDbms | null = null;
  private currentFilepath: string | null = null;
  private operationChain: Promise<void> = Promise.resolve();
  private readonly exclusiveContext = new AsyncLocalStorage<symbol>();
  private activeExclusiveToken: symbol | null = null;
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
  private documentCountCache: Map<string, number> = new Map();

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

      await recoverVacuumReplacement(filepath, () => this.verifyVacuumFiles(filepath));

      // Check file existence right before opening to avoid race conditions
      // (e.g. file state changing during the slow HNSW model loading above).
      let fileExists = false;
      try {
        await fs.access(filepath);
        fileExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      const dataFile = new RealFile(filepath);
      const logFile = new RealFile(this.logFilepath(filepath));

      if (fileExists) {
        this.dbms = await this.openDatabaseFiles(dataFile, logFile, hnswConfig);
        this.currentFilepath = filepath;
        this.onDatabaseOpened();
        return 'Connected to existing database';
      } else {
        // A WAL without its data file is recovery evidence, never a fresh DB.
        try {
          await fs.access(this.logFilepath(filepath));
          throw new Error('Database data file is missing but its WAL exists. Existing files were retained.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        this.dbms = await this.openDatabaseFiles(dataFile, logFile, hnswConfig, true);
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

      await assertNoVacuumArtifacts(filepath);
      await deleteIfExists(filepath);
      await deleteIfExists(this.logFilepath(filepath));

      const dataFile = new RealFile(filepath);
      const logFile = new RealFile(this.logFilepath(filepath));
      const hnswConfig = await this.getHnswConfig();

      this.dbms = await this.openDatabaseFiles(dataFile, logFile, hnswConfig, true);
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
    await this.runExclusive('reset', async () => {
      const filepath = this.currentFilepath;
      if (!filepath) throw new Error('No filepath available');
      await this.closeInternal();

      await assertNoVacuumArtifacts(filepath);
      await deleteIfExists(filepath);
      await deleteIfExists(this.logFilepath(filepath));

      const dataFile = new RealFile(filepath);
      const logFile = new RealFile(this.logFilepath(filepath));
      const hnswConfig = await this.getHnswConfig();

      this.dbms = await this.openDatabaseFiles(dataFile, logFile, hnswConfig, true);
      this.currentFilepath = filepath;
      this.onDatabaseOpened();
    });
  }

  /** Return connection and file-size information for the current database. */
  async getStatus(): Promise<DatabaseStatus> {
    return this.runExclusive('database-status', async () => ({
      connected: this.isConnected,
      filepath: this.currentFilepath,
      busyOperation: null,
      size: this.currentFilepath ? await this.databaseSizeInfo(this.currentFilepath) : null,
      incrementalCompaction: this.getIncrementalCompactionStatus(),
      semanticIndexes: this.dbms ? this.dbms.getHnswIndexKeys() : [],
      semanticReindexPending: this.dbms ? this.dbms.getPendingSemanticCollections() : [],
    }));
  }

  setIncrementalCompactionEnabled(enabled: boolean): IncrementalCompactionStatus {
    this.incrementalCompactionEnabled = enabled;
    this.incrementalCompactionLastError = null;

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

      try {
        const result = await this.dbms!.runIncrementalCompactionStep(this.incrementalCompactionPolicy);
        this.incrementalCompactionLastRunAt = new Date();
        this.incrementalCompactionLastDurationMs = Date.now() - start;
        this.incrementalCompactionLastResult = result;
        this.incrementalCompactionLastError = null;
        this.incrementalCompactionActive = false;

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

      const before = await this.databaseSizeInfo(filepath);
      await assertNoVacuumArtifacts(filepath);
      const paths = vacuumPaths(filepath);
      const tempDataFile = new RealFile(paths.tempData);
      const tempLogFile = new RealFile(paths.tempLog);
      const started = performance.now();
      let compacted: SimpleDbms | null = null;
      let originalClosed = false;
      let preparationAttempted = false;

      try {
        compacted = await this.dbms!.vacuumCompactInto(tempDataFile, tempLogFile);
        await compacted.close();
        compacted = null;

        await this.closeInternal();
        originalClosed = true;

        preparationAttempted = true;
        const manifest = await prepareVacuumReplacement(paths);
        await installVacuumReplacement(paths);

        const hnswConfig = await this.getHnswConfig();
        this.dbms = await this.openDatabaseFiles(new RealFile(filepath), new RealFile(paths.log), hnswConfig);
        this.currentFilepath = filepath;

        const after = await this.databaseSizeInfo(filepath);
        // Do not expose a writable DB until the verified decision and cleanup
        // are complete: later writes would invalidate recovery fingerprints.
        await finishVacuumReplacement(paths, manifest);
        this.onDatabaseOpened();
        const summary = {
          filepath,
          before,
          after,
          bytesSaved: before.totalBytes - after.totalBytes,
          durationMs: performance.now() - started,
        };

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
        // The engine can fail while copying, before returning a target instance.
        // Retain access to both raw handles so those temporary files can still close.
        await Promise.allSettled([tempDataFile.close(), tempLogFile.close()]);
        if (originalClosed) {
          try {
            await this.closeInternal();
            const reopen = async () => {
              this.dbms = await this.openDatabaseFiles(
                new RealFile(filepath),
                new RealFile(paths.log),
                await this.getHnswConfig(),
              );
            };
            if (preparationAttempted) {
              await recoverVacuumReplacement(filepath, () => this.verifyVacuumFiles(filepath));
              await reopen();
            } else {
              await deleteIfExists(paths.tempData);
              await deleteIfExists(paths.tempLog);
              await reopen();
            }
            this.currentFilepath = filepath;
            this.onDatabaseOpened();
          } catch (restoreError) {
            await this.closeInternal().catch(() => undefined);
            throw new AggregateError(
              [error, restoreError],
              'Vacuum failed and recovery could not complete. Recovery files were retained; the database is disconnected.',
            );
          }
        }
        await deleteIfExists(paths.tempData);
        await deleteIfExists(paths.tempLog);
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
  async deleteCollection(collection: string, afterDelete?: () => Promise<void>): Promise<void> {
    await this.runExclusive('delete-collection', async () => {
      this.ensureConnected();
      await this.dbms!.deleteCollection(collection);
      await this.dbms!.commit();
      this.invalidateCollectionStorage(collection);
      if (afterDelete) await afterDelete();
    });
    if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();
  }

  listCompressionProfiles(): CompressionProfileSummary[] {
    return this.dbms ? this.dbms.listCompressionProfiles() : listAvailableCompressionProfiles();
  }

  async getCompressionDefaults(collection: string): Promise<Record<string, CompressionAlgorithm>> {
    return this.runExclusive('compression-defaults', () => {
      this.ensureConnected();
      return Promise.resolve(this.dbms!.getFieldCompressionDefaults(collection));
    });
  }

  async setCompressionDefaults(collection: string, defaults: FieldCompressionDefaults): Promise<void> {
    await this.runExclusive('compression-defaults', async () => {
      this.ensureConnected();
      if (!(await this.dbms!.getCollections()).includes(collection)) {
        throw new DatabaseInputError('Collection does not exist');
      }
      if (
        defaults === null ||
        typeof defaults !== 'object' ||
        Array.isArray(defaults) ||
        Object.entries(defaults).some(
          ([field, codec]) =>
            !field.trim() ||
            field === 'id' ||
            field === '_order_' ||
            field.startsWith('_layout_') ||
            !COMPRESSION_ALGORITHMS.includes(codec),
        )
      ) {
        throw new DatabaseInputError('Invalid compression defaults');
      }
      this.dbms!.setFieldCompressionDefaults(collection, defaults);
      await this.dbms!.commit();
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
      for (const field of Object.keys(articles[0] ?? {})) {
        if (field !== 'id') await this.dbms!.setFieldIndexed(collection, field, field === 'title');
      }
      for (const article of articles) {
        await this.dbms!.insertDocumentObject(collection, article, {
          skipSemanticIndex: true,
        });
      }
      await this.dbms!.commit();
      inserted = articles.length;
      this.invalidateCollectionStorage(collection);
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

    const fields = [...new Set(documents.flatMap((document) => Object.keys(document)))].filter(
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
    return this.runExclusive('document-storage', async () => {
      this.ensureConnected();
      return this.dbms!.getDocumentStoredBytes(collection, id);
    });
  }

  async getDocumentMetadata(
    collection: string,
    id: string,
  ): Promise<{ storedSize: number; blockSize: number; compressions: Record<string, string> }> {
    return this.runExclusive('document-metadata', async () => {
      this.ensureConnected();
      const storedSize = await this.dbms!.getDocumentStoredBytes(collection, id);
      const encoded = JSON.parse(await this.dbms!.getDocumentById(collection, id, { encoded: true })) as Record<
        string,
        unknown
      >;
      const compressions: Record<string, string> = {};
      for (const [key, value] of Object.entries(encoded)) {
        if (key === 'id' || value === null || typeof value !== 'object' || !('payloadBase64' in value)) continue;
        const compression = (value as { compression?: string }).compression;
        if (compression && compression !== 'none') compressions[key] = compression;
      }
      return { storedSize, blockSize: this.dbms!.getBlockSize(), compressions };
    });
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
    const documentCount = await this.getDocumentCountUnlocked(collection);
    return {
      collection,
      documentCount,
      blockSize,
      recordBytes,
      indexedFields: this.dbms!.describeCollection(collection).map((field) => field.name),
      fieldIndexes: this.dbms!.getFieldIndexConfig(collection),
      notes: {
        records: `Sum of (chainLength × blockSize) across all documents in this collection. Block size is ${blockSize} bytes.`,
        indexes: 'B+ tree indexes and the HNSW vector index are not yet accounted for in this number.',
      },
    };
  }

  // ── Documents ────────────────────────────────────────────────

  /**
   * Fetch a cursor-paginated page of documents from a collection.
   *
   * When `sortBy` is provided, the page is returned sorted by that field
   * using {@link compareValues} (numbers numerically, strings by code point,
   * booleans by 0/1, nulls first in ascending order). Sorting performs a full
   * scan and uses offset pagination; cursor pagination follows index order.
   */
  async getDocuments(
    collection: string,
    iterableKey: string = 'id',
    cursor?: string,
    limit: number = 50,
    sortBy?: string,
    sortDir: 'asc' | 'desc' = 'asc',
    offset?: number,
  ): Promise<{ documents: string[]; total: number; hasMore: boolean; nextCursor?: string | number }> {
    return this.runExclusive('get-documents', async () =>
      this.getDocumentsUnlocked(collection, iterableKey, cursor, limit, sortBy, sortDir, offset),
    );
  }

  private async getDocumentsUnlocked(
    collection: string,
    iterableKey: string = 'id',
    cursor?: string,
    limit: number = 50,
    sortBy?: string,
    sortDir: 'asc' | 'desc' = 'asc',
    offset?: number,
  ): Promise<{ documents: string[]; total: number; hasMore: boolean; nextCursor?: string | number }> {
    this.ensureConnected();

    if (sortBy) {
      return this.scanAndSortDocuments(collection, sortBy, sortDir, limit, offset ?? 0);
    }

    const total = await this.getDocumentCountUnlocked(collection);
    if (offset !== undefined) {
      const documents: string[] = [];
      let seen = 0;
      for await (const json of this.dbms!.cursor(collection, iterableKey)) {
        if (seen++ < offset) continue;
        documents.push(json);
        if (documents.length > limit) break;
      }
      const hasMore = documents.length > limit;
      return { documents: documents.slice(0, limit), total, hasMore, nextCursor: undefined };
    }

    const page = await fetchPageCursor(this.dbms!, { collection, iterableKey, limit, afterCursor: cursor });
    return { documents: page.data, total, hasMore: page.hasMore, nextCursor: page.nextCursor };
  }

  private async getDocumentCountUnlocked(collection: string): Promise<number> {
    const cached = this.documentCountCache.get(collection);
    if (cached !== undefined) return cached;
    let count = 0;
    const iterator = this.dbms!.cursor(collection, 'id')[Symbol.asyncIterator]();
    while (!(await iterator.next()).done) count++;
    this.documentCountCache.set(collection, count);
    return count;
  }

  /**
   * Full-scan the collection over the primary id index, parse each document,
   * and return up to `limit` JSON strings sorted by `sortBy` using the same
   * deterministic comparator the query engine uses for ORDER BY.
   *
   * Sorting is in-memory because a generic data-grid sort cannot assume
   * an index exists. Limiting after the sort keeps the result well-defined
   * even when the limit truncates equal-keyed runs.
   */
  private async scanAndSortDocuments(
    collection: string,
    sortBy: string,
    sortDir: 'asc' | 'desc',
    limit: number,
    offset: number,
  ): Promise<{ documents: string[]; total: number; hasMore: boolean; nextCursor?: string | number }> {
    const direction = sortDir === 'desc' ? -1 : 1;
    const all: { json: string; key: unknown }[] = [];
    for await (const jsonStr of this.dbms!.cursor(collection, 'id')) {
      let key: unknown = null;
      try {
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        key = parsed[sortBy];
      } catch {
        // Treat unparseable docs as nulls for a deterministic order.
      }
      all.push({ json: jsonStr, key });
    }
    all.sort((a, b) => direction * compareDataGridValues(a.key, b.key));
    this.documentCountCache.set(collection, all.length);
    return {
      documents: all.slice(offset, offset + limit).map((entry) => entry.json),
      total: all.length,
      hasMore: offset + limit < all.length,
      nextCursor: undefined,
    };
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
        } catch (error) {
          // Article deleted after indexing — skip silently
          if (!(error instanceof Error) || !error.message.startsWith('Document not found')) throw error;
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
        } catch (error) {
          // Article deleted after indexing — skip silently
          if (!(error instanceof Error) || !error.message.startsWith('Document not found')) throw error;
        }
      }
      return { documents, total, hasMore };
    });
  }

  /** Insert a document into a collection. */
  async insertDocument(collection: string, document: unknown, compression?: FieldCompressionOverrides): Promise<void> {
    await this.runExclusive('insert-document', async () => {
      this.ensureConnected();
      this.validateIndexedKeys(collection, document);
      await this.dbms!.insertDocumentObject(collection, document, {
        compression,
      });
      await this.dbms!.commit();
      this.invalidateCollectionStorage(collection);
    });
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
      this.invalidateCollectionStorage(collection);
    });
    if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();
  }

  /** Mutate an explicit selection or all documents without routing through SQL. */
  async mutateDocuments(
    collection: string,
    selection: { all: true } | { ids: Array<string | number> },
    edit?: { field: string; value: unknown },
  ): Promise<{ affected: number }> {
    const result = await this.runExclusive('bulk-documents', async () => {
      this.ensureConnected();
      if (edit && (!edit.field.trim() || edit.field === 'id')) {
        throw new DatabaseInputError('Choose a field other than the primary ID');
      }
      const ids: Array<string | number> = [];
      if ('all' in selection) {
        for await (const json of this.dbms!.cursor(collection, 'id')) {
          ids.push((JSON.parse(json) as { id: string | number }).id);
        }
      } else {
        ids.push(...new Set(selection.ids));
      }
      // Validate every target before starting mutations, including unloaded rows.
      for (const id of ids) {
        const document = JSON.parse(await this.dbms!.getDocumentById(collection, id)) as Record<string, unknown>;
        if (edit) {
          if (!Object.prototype.hasOwnProperty.call(document, edit.field)) {
            throw new DatabaseInputError(`Field ${edit.field} is missing on document ${id}`);
          }
          this.validateIndexedKeys(collection, { ...document, [edit.field]: edit.value });
        }
      }
      try {
        for (const id of ids) {
          if (edit) {
            await this.dbms!.editDocument(
              collection,
              id,
              edit.field,
              edit.value as Parameters<SimpleDbms['editDocument']>[3],
            );
          } else {
            await this.dbms!.deleteDocumentById(collection, id);
          }
        }
        await this.dbms!.commit();
        return { affected: ids.length };
      } finally {
        this.invalidateCollectionStorage(collection);
      }
    });
    if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();
    return result;
  }

  /** Edit a single field in a document by ID. */
  async editDocument(collection: string, id: string, field: string, value: unknown): Promise<void> {
    await this.runExclusive('edit-document', async () => {
      this.ensureConnected();
      const existing = JSON.parse(await this.dbms!.getDocumentById(collection, id)) as Record<string, unknown>;
      this.validateIndexedKeys(collection, { ...existing, [field]: value });
      await this.dbms!.editDocument(collection, id, field, value as Parameters<SimpleDbms['editDocument']>[3]);
      await this.dbms!.commit();
      this.invalidateCollectionStorage(collection);
    });
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
    compression?: FieldCompressionOverrides,
  ): Promise<void> {
    await this.runExclusive('replace-document', async () => {
      this.ensureConnected();
      this.validateIndexedKeys(collection, newDocument);
      await this.dbms!.replaceDocument(collection, id, newDocument, { compression });
      await this.dbms!.commit();
      this.invalidateCollectionStorage(collection);
    });
    if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();
  }

  /**
   * Execute a SQL-like statement through the embedded query language.
   *
   * Supports SELECT, INSERT, UPDATE, and DELETE. For mutating statements
   * the result rows are `{id}` per affected document so `rowCount` is
   * meaningful. Successful mutating statements commit once at the end.
   */
  async query(sql: string): Promise<QueryExecutionResult> {
    return this.runExclusive('query', async () => {
      this.ensureConnected();
      const start = performance.now();
      const ql = new QueryLanguage(this.dbms!);
      const parsed = ql.parse(sql);
      let rows: QueryResultRow[];
      try {
        rows = await ql.executeParsed(parsed);
      } catch (error) {
        if (error instanceof QueryMutationError) {
          this.recordBytesCache.clear();
          this.documentCountCache.clear();
          this.setIncrementalCompactionEnabled(false);
        }
        throw error;
      }
      if (parsed.kind === 'insert' || parsed.kind === 'update' || parsed.kind === 'delete') {
        this.recordBytesCache.clear();
        this.documentCountCache.clear();
        try {
          await this.dbms!.commit();
        } catch (error) {
          this.setIncrementalCompactionEnabled(false);
          throw new QueryMutationError(
            `${parsed.kind} commit`,
            rows.map((row) => row['id'] as string | number),
            error,
          );
        }
        if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();
      }
      return {
        rows,
        rowCount: rows.length,
        kind: parsed.kind,
        elapsedMs: Math.round((performance.now() - start) * 100) / 100,
      };
    });
  }

  /**
   * Seed the connected database with the built-in employee demo dataset.
   * If the `employees` collection already contains rows, this is a no-op.
   */
  async seedDemoEmployees(count: number = 200): Promise<{ collection: string; inserted: number; skipped: boolean }> {
    return this.runExclusive('seed-demo-employees', async () => {
      this.ensureConnected();

      try {
        const existing = await this.getDocumentsUnlocked('employees', 'id', undefined, 1);
        if (existing.documents.length > 0) {
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
      this.invalidateCollectionStorage('employees');

      return { collection: 'employees', inserted: employees.length, skipped: false };
    });
  }

  async seedSemanticKnowledgeDemo(): Promise<{ collection: string; inserted: number; skipped: boolean }> {
    return this.runExclusive('seed-semantic-knowledge', async () => {
      this.ensureConnected();
      const collection = 'knowledge';

      try {
        const existing = await this.getDocumentsUnlocked(collection, 'id', undefined, 1);
        if (existing.documents.length > 0) {
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
      this.invalidateCollectionStorage(collection);
      if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();

      return { collection, inserted: documents.length, skipped: false };
    });
  }

  async seedSemanticImageDemo(): Promise<{ collection: string; inserted: number; skipped: boolean; source: string }> {
    return this.runExclusive('seed-semantic-images', async () => {
      this.ensureConnected();
      const collection = 'photos';

      try {
        const existing = await this.getDocumentsUnlocked(collection, 'id', undefined, 1);
        if (existing.documents.length > 0) {
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
      this.invalidateCollectionStorage(collection);
      if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();

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
    return this.runExclusive('semantic-photo-search', async () => {
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
    // Lab report/apply callers already own the database operation queue.
    const rawDocuments = await this.getDocumentsUnlocked(collection, 'id', undefined, limit);
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
    const imageDir = path.resolve(import.meta.dirname, '../../../examples/assets/images');
    const fallback = path.resolve(import.meta.dirname, '../../../examples/assets/rabbit.jpg');
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
      running: this.incrementalCompactionActive,
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

    this.incrementalCompactionTimer = setInterval(() => {
      this.scheduleIncrementalCompaction();
    }, this.incrementalCompactionIntervalMs);
    this.incrementalCompactionTimer.unref?.();
  }

  private stopIncrementalCompactionTimer(): void {
    if (!this.incrementalCompactionTimer) return;
    clearInterval(this.incrementalCompactionTimer);
    this.incrementalCompactionTimer = null;
  }

  private scheduleIncrementalCompaction(): void {
    if (!this.incrementalCompactionEnabled) return;
    if (!this.isConnected) return;
    if (this.incrementalCompactionQueued || this.incrementalCompactionActive) return;

    this.incrementalCompactionQueued = true;
    // Background work must queue even when it was scheduled from a foreground
    // operation or a timer that inherited that operation's async context.
    void this.exclusiveContext
      .exit(() =>
        this.runExclusive('incremental-compaction', async () => {
          this.incrementalCompactionQueued = false;
          if (!this.incrementalCompactionEnabled || !this.dbms) return;

          this.incrementalCompactionActive = true;
          const start = Date.now();
          try {
            // Incremental compaction can relocate HNSW graph/vector units,
            // including tombstoned routing artifacts. Keep it behind the same
            // service gate as semantic search and document writes so the GUI never
            // observes a half-relocated semantic index.
            const result = await this.dbms.compactIfNeeded(this.incrementalCompactionPolicy);
            if (result !== null) {
              this.incrementalCompactionLastRunAt = new Date();
              this.incrementalCompactionLastDurationMs = Date.now() - start;
              this.incrementalCompactionLastResult = result;
            }
            this.incrementalCompactionLastError = null;
          } finally {
            this.incrementalCompactionActive = false;
          }
        }),
      )
      .catch((error: unknown) => {
        this.incrementalCompactionQueued = false;
        this.incrementalCompactionActive = false;
        this.incrementalCompactionLastError = String(error);
        console.error('Incremental compaction failed:', error);
      });
  }

  private async runExclusive<T>(operation: string, task: () => Promise<T>): Promise<T> {
    if (this.activeExclusiveToken !== null && this.exclusiveContext.getStore() === this.activeExclusiveToken) {
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
    this.activeExclusiveToken = token;
    try {
      return await this.exclusiveContext.run(token, task);
    } finally {
      this.activeExclusiveToken = null;
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
      totalBytes: dataFileBytes,
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
    this.incrementalCompactionLastRunAt = null;
    this.incrementalCompactionLastDurationMs = null;
    this.incrementalCompactionLastError = null;
    this.incrementalCompactionLastResult = null;
    this.stopIncrementalCompactionTimer();
    this.recordBytesCache.clear();
    this.documentCountCache.clear();
  }

  private invalidateCollectionStorage(collection: string): void {
    this.recordBytesCache.delete(collection);
    this.documentCountCache.delete(collection);
  }

  private validateIndexedKeys(collection: string, document: unknown): void {
    try {
      this.dbms!.validateDocument(collection, document);
    } catch (error) {
      throw new DatabaseInputError(error instanceof Error ? error.message : String(error));
    }
  }

  async getFieldIndexConfig(collection: string): Promise<Record<string, boolean>> {
    return this.runExclusive('get-field-indexes', () => {
      this.ensureConnected();
      return Promise.resolve(this.dbms!.getFieldIndexConfig(collection));
    });
  }

  async setFieldIndexed(collection: string, field: string, indexed: boolean): Promise<Record<string, boolean>> {
    return this.runExclusive('set-field-index', async () => {
      this.ensureConnected();
      await this.dbms!.setFieldIndexed(collection, field, indexed);
      await this.dbms!.commit();
      this.invalidateCollectionStorage(collection);
      return this.dbms!.getFieldIndexConfig(collection);
    });
  }

  private async openDatabaseFiles(
    dataFile: RealFile,
    logFile: RealFile,
    hnswConfig: Parameters<typeof SimpleDbms.open>[2],
    create = false,
  ): Promise<SimpleDbms> {
    let database: SimpleDbms | null = null;
    try {
      database = create
        ? await SimpleDbms.create(dataFile, logFile, hnswConfig)
        : await SimpleDbms.open(dataFile, logFile, hnswConfig);
      if (create) await database.commit();
      return database;
    } catch (error) {
      // Opening can fail after only one file handle was acquired.
      await Promise.allSettled([dataFile.close(), logFile.close()]);
      throw error;
    }
  }

  /** Verify recovery without semantic reindexing changing the fingerprinted generation. */
  private async verifyVacuumFiles(filepath: string): Promise<void> {
    const database = await this.openDatabaseFiles(
      new RealFile(filepath),
      new RealFile(this.logFilepath(filepath)),
      undefined,
    );
    try {
      for (const collection of database.listCollections()) {
        for (const field of database.describeCollection(collection)) {
          for await (const document of database.cursor(collection, field.name)) {
            // Exhaust required records and index pages; a corrupt live reference must abort cleanup.
            void document;
          }
        }
      }
    } finally {
      await database.close();
    }
  }
}
