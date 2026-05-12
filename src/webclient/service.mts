// @author Alexandre-Gatien Bienfet
// @date 2026-03-31

import * as fs from 'node:fs/promises';
import { SimpleDbms, type HnswConfig } from '../dbms/simpledbms.mjs';
import { RealFile } from '../core/file.mjs';
import type { IncrementalCompactionPolicy, IncrementalCompactionResult } from '../compaction/compaction.mjs';

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
  private incrementalCompactionEnabled = false;
  private incrementalCompactionQueued = false;
  private incrementalCompactionActive = false;
  private incrementalCompactionTimer: ReturnType<typeof setInterval> | null = null;
  private incrementalCompactionLastRunAt: Date | null = null;
  private incrementalCompactionLastDurationMs: number | null = null;
  private incrementalCompactionLastError: string | null = null;
  private incrementalCompactionLastResult: IncrementalCompactionResult | null = null;

  private readonly incrementalCompactionIntervalMs = 5_000;
  private readonly incrementalCompactionPolicy: IncrementalCompactionPolicy = {
    maxAmplification: 1.6,
    softAmplification: 1.45,
    targetBatchDocuments: 4,
    targetBatchUnits: 2,
    maxStepsPerRun: 4,
  };

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
        this.onDatabaseOpened();
        return 'Connected to existing database';
      }

      this.dbms = await SimpleDbms.create(dataFile, logFile, hnswConfig);
      await this.dbms.commit();
      this.currentFilepath = filepath;
      this.onDatabaseOpened();
      return 'Created new database';
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
    await this.runExclusive('disconnect', async () => {
      await this.closeInternal();
    });
  }

  /**
   * Reset the database by dropping all data and re-creating from scratch.
   */
  async reset(): Promise<void> {
    await this.runExclusive('reset', async () => {
      const filepath = this.currentFilepath;
      if (!filepath) throw new Error('No filepath available');

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
    return {
      connected: this.isConnected,
      filepath: this.currentFilepath,
      busyOperation: this.busyOperation,
      size: this.currentFilepath ? await this.readSizeInfo(this.currentFilepath) : null,
      incrementalCompaction: this.getIncrementalCompactionStatus(),
    };
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

  /**
   * Rebuild the current database into fresh files, then swap those files into
   * the current database path and reopen the compacted database.
   */
  async vacuum(): Promise<VacuumSummary> {
    return this.runExclusive('vacuum', async () => {
      this.ensureConnected();
      const filepath = this.currentFilepath;
      if (!filepath) throw new Error('No filepath available');

      const logPath = this.logFilepath(filepath);
      const stamp = `${process.pid.toString()}-${Date.now().toString()}`;
      const tempPath = `${filepath}.vacuum-${stamp}.tmp`;
      const tempLogPath = `${logPath}.vacuum-${stamp}.tmp`;
      const backupPath = `${filepath}.vacuum-${stamp}.bak`;
      const backupLogPath = `${logPath}.vacuum-${stamp}.bak`;
      const hnswConfig = await this.getHnswConfig();
      const before = await this.readSizeInfo(filepath);
      const start = Date.now();

      let compacted: SimpleDbms | null = null;

      try {
        compacted = await this.dbms!.vacuumCompactInto(new RealFile(tempPath), new RealFile(tempLogPath));

        await this.dbms!.close();
        this.dbms = null;
        await compacted.close();
        compacted = null;

        const dataBackedUp = await renameIfExists(filepath, backupPath);
        const logBackedUp = await renameIfExists(logPath, backupLogPath);

        try {
          await fs.rename(tempPath, filepath);
          await fs.rename(tempLogPath, logPath);
          this.dbms = await SimpleDbms.open(new RealFile(filepath), new RealFile(logPath), hnswConfig);
          this.currentFilepath = filepath;
        } catch (error) {
          await deleteIfExists(filepath);
          await deleteIfExists(logPath);
          if (dataBackedUp) await fs.rename(backupPath, filepath);
          if (logBackedUp) await fs.rename(backupLogPath, logPath);
          this.dbms = await SimpleDbms.open(new RealFile(filepath), new RealFile(logPath), hnswConfig);
          this.currentFilepath = filepath;
          throw error;
        }

        await deleteIfExists(backupPath);
        await deleteIfExists(backupLogPath);

        const after = await this.readSizeInfo(filepath);
        return {
          filepath,
          before,
          after,
          bytesSaved: before.totalBytes - after.totalBytes,
          durationMs: Date.now() - start,
        };
      } catch (error) {
        if (compacted) {
          await compacted.close().catch((closeError: unknown) => {
            console.error('Failed to close compacted database after vacuum error:', closeError);
          });
        }
        if (!this.dbms && this.currentFilepath) {
          this.dbms = await SimpleDbms.open(new RealFile(this.currentFilepath), new RealFile(logPath), hnswConfig);
        }
        throw error;
      } finally {
        await deleteIfExists(tempPath);
        await deleteIfExists(tempLogPath);
      }
    });
  }

  // ── Collections ──────────────────────────────────────────────

  /** Return the list of collection names. */
  async getCollections(): Promise<string[]> {
    return this.runExclusive('get-collections', async () => {
      this.ensureConnected();
      return this.dbms!.getCollections();
    });
  }

  /** Delete an entire collection. */
  async deleteCollection(collection: string): Promise<void> {
    await this.runExclusive('delete-collection', async () => {
      this.ensureConnected();
      await this.dbms!.deleteCollection(collection);
      await this.dbms!.commit();
    });
    if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();
  }

  // ── Documents ────────────────────────────────────────────────

  /**
   * Query documents from a collection.
   *
   * Future: this method could accept a query-language string
   * and parse it into the appropriate cursor parameters.
   */
  async getDocuments(
    collection: string,
    iterableKey: string = 'id',
    value?: string,
    limit: number = 100,
  ): Promise<string[]> {
    return this.runExclusive('get-documents', async () => {
      this.ensureConnected();

      const documents: string[] = [];
      const cursor = this.dbms!.cursor(collection, iterableKey, value);

      let count = 0;
      for await (const doc of cursor) {
        documents.push(doc);
        count++;
        if (count >= limit) break;
      }

      return documents;
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
      await this.dbms!.insertDocumentObject(collection, document, { compression });
      await this.dbms!.commit();
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

  /** Delete a document from a collection. */
  async deleteDocument(collection: string, id: string): Promise<void> {
    await this.runExclusive('delete-document', async () => {
      this.ensureConnected();
      await this.dbms!.deleteDocumentById(collection, id);
      await this.dbms!.commit();
    });
    if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();
  }

  /** Edit a single field in a document by ID. */
  async editDocument(collection: string, id: string, field: string, value: unknown): Promise<void> {
    await this.runExclusive('edit-document', async () => {
      this.ensureConnected();
      await this.dbms!.editDocument(collection, id, field, value as Parameters<SimpleDbms['editDocument']>[3]);
      await this.dbms!.commit();
    });
    if (this.incrementalCompactionEnabled) this.scheduleIncrementalCompaction();
  }

  /** Semantic text-to-text or text-to-image search */
  async semanticSearch(collection: string, query: string, limit: number): Promise<string[]> {
    return this.runExclusive('semantic-search', async () => {
      this.ensureConnected();
      return this.dbms!.semanticSearch(collection, query, limit);
    });
  }

  /** Semantic image-to-image search */
  async semanticImageSearch(collection: string, queryImage: Buffer, limit: number): Promise<string[]> {
    return this.runExclusive('semantic-image-search', async () => {
      this.ensureConnected();
      return this.dbms!.semanticImageSearch(collection, queryImage, limit);
    });
  }

  // ── Internal helpers ─────────────────────────────────────────

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
    void this.runExclusive('incremental-compaction', async () => {
      this.incrementalCompactionQueued = false;
      if (!this.incrementalCompactionEnabled || !this.dbms) return;

      this.incrementalCompactionActive = true;
      const start = Date.now();
      try {
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
    }).catch((error: unknown) => {
      this.incrementalCompactionQueued = false;
      this.incrementalCompactionActive = false;
      this.incrementalCompactionLastError = String(error);
      console.error('Incremental compaction failed:', error);
    });
  }

  private async runExclusive<T>(operation: string, task: () => Promise<T>): Promise<T> {
    const previous = this.operationChain.catch(() => undefined);
    let release!: () => void;
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

  private async readSizeInfo(filepath: string): Promise<DatabaseSizeInfo> {
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
  }
}
