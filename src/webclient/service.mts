// @author Alexandre-Gatien Bienfet
// @date 2026-03-31

import * as fs from 'node:fs/promises';
import { SimpleDbms, type HnswConfig } from '../dbms/simpledbms.mjs';
import { RealFile } from '../core/file.mjs';

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

  /**
   * Connect to an existing database or create a new one if the
   * file does not exist yet.
   */
  async connect(filepath: string): Promise<string> {
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
    const logFile = new RealFile(`${filepath}.log`);

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
  }

  /**
   * Force-create a new database, deleting any existing files first.
   */
  async create(filepath: string): Promise<string> {
    await this.closeInternal();

    await deleteIfExists(filepath);
    await deleteIfExists(`${filepath}.log`);

    const dataFile = new RealFile(filepath);
    const logFile = new RealFile(`${filepath}.log`);
    const hnswConfig = await this.getHnswConfig();

    this.dbms = await SimpleDbms.create(dataFile, logFile, hnswConfig);
    await this.dbms.commit();
    this.currentFilepath = filepath;
    return 'Created new database';
  }

  /** Disconnect from the current database. */
  async disconnect(): Promise<void> {
    await this.closeInternal();
  }

  /**
   * Reset the database by dropping all data and re-creating from scratch.
   */
  async reset(): Promise<void> {
    const filepath = this.currentFilepath;
    if (!filepath) throw new Error('No filepath available');

    await this.closeInternal();

    await deleteIfExists(filepath);
    await deleteIfExists(`${filepath}.log`);

    const dataFile = new RealFile(filepath);
    const logFile = new RealFile(`${filepath}.log`);
    const hnswConfig = await this.getHnswConfig();

    this.dbms = await SimpleDbms.create(dataFile, logFile, hnswConfig);
    await this.dbms.commit();
    this.currentFilepath = filepath;
  }

  // ── Collections ──────────────────────────────────────────────

  /** Return the list of collection names. */
  async getCollections(): Promise<string[]> {
    this.ensureConnected();
    return this.dbms!.getCollections();
  }

  /** Delete an entire collection. */
  async deleteCollection(collection: string): Promise<void> {
    this.ensureConnected();
    await this.dbms!.deleteCollection(collection);
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
  }

  /** Insert a document into a collection. */
  async insertDocument(
    collection: string,
    document: unknown,
    compression?: import('../dbms/compression.mts').FieldCompressionOverrides,
  ): Promise<void> {
    this.ensureConnected();
    await this.dbms!.insertDocumentObject(collection, document, { compression });
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

  private ensureConnected(): void {
    if (!this.dbms) throw new Error('No database connected');
  }

  private async closeInternal(): Promise<void> {
    if (this.dbms) {
      await this.dbms.close();
      this.dbms = null;
      this.currentFilepath = null;
    }
  }
}
