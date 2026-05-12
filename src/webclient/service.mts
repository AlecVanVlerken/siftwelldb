// @author Alexandre-Gatien Bienfet
// @date 2026-03-31

import * as fs from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import {
  SimpleDbms,
  type CompressionProfileSummary,
  type CompressionRecommendation,
  type CompressionRecommendationItem,
  type CompressionRecommendationRequest,
  type HnswConfig,
} from '../dbms/simpledbms.mjs';
import { listAvailableCompressionProfiles } from '../dbms/compression-advisor.mjs';
import { type CompressionAlgorithm } from '../dbms/compression.mjs';
import { isImageField } from '../dbms/document.mjs';
import { generateWikiArticles } from '../dbms/lab-fixtures/wiki.mjs';
import { RealFile } from '../core/file.mjs';
import { fetchPageCursor } from '../largedatasets/pagination.mjs';
import { searchWordIndex, searchContentIndex } from '../largedatasets/wordindex.mjs';

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
  recommendation: CompressionRecommendation;
  forcedGzipBytesSaved: number | null;
};

export type DatabaseSizeInfo = {
  dataFileBytes: number;
  logFileBytes: number;
  totalBytes: number;
};

export type DatabaseStatus = {
  connected: boolean;
  filepath: string | null;
  busyOperation: string | null;
  size: DatabaseSizeInfo | null;
};

export type VacuumSummary = {
  filepath: string;
  before: DatabaseSizeInfo;
  after: DatabaseSizeInfo;
  bytesSaved: number;
  durationMs: number;
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
 * @author Alexandre-Gatien Bienfet
 */
export class DatabaseService {
  private dbms: SimpleDbms | null = null;
  private currentFilepath: string | null = null;
  private operationChain: Promise<void> = Promise.resolve();
  private currentOperation: string | null = null;

  // HNSW semantic search config
  private hnswConfigPromise: Promise<HnswConfig> | null = null;

  private getHnswConfig(): Promise<HnswConfig> {
    if (!this.hnswConfigPromise) {
      this.hnswConfigPromise = (async () => {
        const MODEL_ID = 'Xenova/clip-vit-base-patch32';
        const CLIP_DIM = 512;

        console.log('Lazy loading huggingface transformers for semantic search...');
        const { AutoTokenizer, AutoProcessor, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, RawImage } =
          await import('@huggingface/transformers');

        console.log('Loading CLIP tokenizer & text model...');
        const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
        const textModel = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'fp32' });

        console.log('Loading CLIP processor & vision model...');
        const processor = await AutoProcessor.from_pretrained(MODEL_ID);
        const visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'fp32' });

        function l2Normalize(v: Float32Array): Float32Array {
          let norm = 0;
          for (const val of v) norm += val * val;
          norm = Math.sqrt(norm);
          if (norm === 0) return v;
          for (let i = 0; i < v.length; i++) v[i] /= norm;
          return v;
        }

        const embeddingFn = async (text: string): Promise<Float32Array> => {
          const inputs = tokenizer(text, { padding: true, truncation: true });
          const { text_embeds } = (await textModel(inputs)) as { text_embeds: { data: ArrayLike<number> } };
          return l2Normalize(new Float32Array(text_embeds.data));
        };

        const imageEmbeddingFn = async (imageData: Buffer): Promise<Float32Array> => {
          const blob = new Blob([new Uint8Array(imageData)]);
          const image = await RawImage.fromBlob(blob);
          const inputs = await processor(image);
          const { image_embeds } = (await visionModel(inputs)) as { image_embeds: { data: ArrayLike<number> } };
          return l2Normalize(new Float32Array(image_embeds.data));
        };

        console.log('CLIP models loaded successfully.');
        return {
          dimension: CLIP_DIM,
          embeddingFn,
          imageEmbeddingFn,
          M: 16,
          efConstruction: 100,
          efSearch: 50,
        };
      })();
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

      // Load HNSW config first (this can take a long time loading CLIP models).
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
        return 'Connected to existing database';
      } else {
        this.dbms = await SimpleDbms.create(dataFile, logFile, hnswConfig);
        await this.dbms.commit();
        this.currentFilepath = filepath;
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
    });
  }

  /** Return connection and file-size information for the current database. */
  async getStatus(): Promise<DatabaseStatus> {
    return {
      connected: this.isConnected,
      filepath: this.currentFilepath,
      busyOperation: this.busyOperation,
      size: this.currentFilepath ? await this.databaseSizeInfo(this.currentFilepath) : null,
    };
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

        const after = await this.databaseSizeInfo(filepath);
        return {
          filepath,
          before,
          after,
          bytesSaved: before.totalBytes - after.totalBytes,
          durationMs: performance.now() - started,
        };
      } catch (error) {
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
    this.ensureConnected();
    const all = await this.dbms!.getCollections();
    return all.filter((c) => !c.startsWith('_'));
  }

  /** Delete an entire collection. */
  async deleteCollection(collection: string): Promise<void> {
    this.ensureConnected();
    await this.dbms!.deleteCollection(collection);
  }

  listCompressionProfiles(): CompressionProfileSummary[] {
    return this.dbms ? this.dbms.listCompressionProfiles() : listAvailableCompressionProfiles();
  }

  getCompressionDefaults(collection: string): Record<string, CompressionAlgorithm> {
    this.ensureConnected();
    return this.dbms!.getFieldCompressionDefaults(collection);
  }

  async recommendCompression(request: CompressionRecommendationRequest): Promise<CompressionRecommendation> {
    this.ensureConnected();
    return this.dbms!.recommendCompression(request);
  }

  /**
   * Rebuild the deterministic Wikipedia-style Compression Lab collection.
   */
  async seedWikiLab(options: { count?: number } = {}): Promise<{ collection: string; inserted: number }> {
    this.ensureConnected();

    const collection = 'wiki_lab';
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

    return { collection, inserted: articles.length };
  }

  /**
   * Build a read-only Compression Lab report for a collection.
   */
  async recommendCollectionLab(request: {
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
      const recommendation = await this.dbms!.recommendCompression({
        collection: request.collection,
        field,
        workload,
        sampleSize,
      });
      bundles.push({
        field,
        recommendation,
        forcedGzipBytesSaved: isImageField(field) ? this.estimateForcedGzipBytesSaved(field, documents) : null,
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
    this.ensureConnected();

    const report = await this.recommendCollectionLab(request);
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
  }

  // ── Documents ────────────────────────────────────────────────

  /** Fetch a cursor-paginated page of documents from a collection. */
  async getDocuments(
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
  }

  /** Find all articles whose body contains a word via the persistent content index. */
  async contentSearch(
    collection: string,
    word: string,
    limit: number,
    offset: number,
  ): Promise<{ documents: string[]; total: number; hasMore: boolean }> {
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
  }

  /** Insert a document into a collection. */
  async insertDocument(
    collection: string,
    document: unknown,
    compression?: import('../dbms/compression.mts').FieldCompressionOverrides,
  ): Promise<void> {
    this.ensureConnected();
    await this.dbms!.insertDocumentObject(collection, document, {
      compression,
      indexPredicate: collection === 'wiki_lab' ? (field) => field === 'title' : undefined,
    });
    await this.dbms!.commit();
  }

  /** Retrieve a specific document by its ID. */
  async getDocumentById(collection: string, id: string, options?: { encoded?: boolean }): Promise<string> {
    this.ensureConnected();
    return this.dbms!.getDocumentById(collection, id, options);
  }

  /** Delete a document from a collection. */
  async deleteDocument(collection: string, id: string): Promise<void> {
    this.ensureConnected();
    await this.dbms!.deleteDocumentById(collection, id);
    await this.dbms!.commit();
  }

  /** Edit a single field in a document by ID. */
  async editDocument(collection: string, id: string, field: string, value: unknown): Promise<void> {
    this.ensureConnected();
    await this.dbms!.editDocument(collection, id, field, value as Parameters<SimpleDbms['editDocument']>[3]);
    await this.dbms!.commit();
  }

  /** Semantic text-to-text or text-to-image search */
  async semanticSearch(collection: string, query: string, limit: number): Promise<string[]> {
    this.ensureConnected();
    return this.dbms!.semanticSearch(collection, query, limit);
  }

  /** Semantic image-to-image search */
  async semanticImageSearch(collection: string, queryImage: Buffer, limit: number): Promise<string[]> {
    this.ensureConnected();
    return this.dbms!.semanticImageSearch(collection, queryImage, limit);
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

        if (policy === 'gzip-everything' && isImageField(bundle.field) && bundle.forcedGzipBytesSaved !== null) {
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
        return isImageField(bundle.field) ? 'none' : 'gzip';
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

  private ensureConnected(): void {
    if (!this.dbms) throw new Error('No database connected');
  }

  private async runExclusive<T>(operation: string, task: () => Promise<T>): Promise<T> {
    const previous = this.operationChain.catch(() => undefined);
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.operationChain = previous.then(() => current);

    await previous;
    this.currentOperation = operation;
    try {
      return await task();
    } finally {
      this.currentOperation = null;
      release();
    }
  }

  private logFilepath(filepath: string): string {
    return `${filepath}.log`;
  }

  private async databaseSizeInfo(filepath: string): Promise<DatabaseSizeInfo> {
    const dataFileBytes = await sizeOrZero(filepath);
    const logFileBytes = await sizeOrZero(this.logFilepath(filepath));
    return {
      dataFileBytes,
      logFileBytes,
      totalBytes: dataFileBytes + logFileBytes,
    };
  }

  private async closeInternal(): Promise<void> {
    if (this.dbms) {
      await this.dbms.close();
      this.dbms = null;
      this.currentFilepath = null;
    }
  }
}
