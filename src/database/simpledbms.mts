// author: Thomas Dumon
// date: 2025-12-07

import { DbmsBack, type HnswConfig, type IndexCursorPosition } from './dbmsback.mjs';

/**
 * Configuration for HNSW semantic search.
 *
 * Pass to {@link SimpleDbms.create} / {@link SimpleDbms.open} to enable
 * semantic search on a database. The config is **not** persisted — you must
 * supply the same config (same model, same `dimension`) on every open.
 *
 * ## Properties
 *
 * | Property            | Required | Description |
 * |---------------------|----------|-------------|
 * | `dimension`         | yes      | Number of floats the model outputs (e.g. 384 or 512). |
 * | `embeddingFn`       | yes      | `(text: string) => Promise<Float32Array>` — text encoder. |
 * | `imageEmbeddingFn`  | no       | `(imageData: Buffer) => Promise<Float32Array>` — image encoder. Both functions **must** output the same `dimension`. |
 * | `M`                 | no       | Max neighbours per HNSW node (default 16). |
 * | `efConstruction`    | no       | ef during index build (default 200). |
 * | `efSearch`          | no       | ef during search queries (default 50). |
 *
 * ---
 *
 * ## Text-only example (MiniLM, 384-d)
 *
 * ```ts
 * import { pipeline } from '@huggingface/transformers';
 *
 * const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
 *
 * const hnswConfig: HnswConfig = {
 *   dimension: 384,
 *   embeddingFn: async (text) => {
 *     const out = await extractor(text, { pooling: 'mean', normalize: true });
 *     return new Float32Array(out.data);
 *   },
 * };
 *
 * const db = await SimpleDbms.create(dataFile, logFile, hnswConfig);
 * await db.insertDocument('articles', JSON.stringify({ id: '1', title: 'Neural networks' }));
 * await db.commit();
 *
 * const results = await db.semanticSearch('articles', 'deep learning', 5);
 * ```
 *
 * ---
 *
 * ## Text + Image example (CLIP, 512-d)
 *
 * CLIP has two separate encoders (text + vision) that produce vectors in the
 * **same** 512-d space, enabling cross-modal search (text query → image results).
 *
 * ```ts
 * import {
 *   AutoTokenizer, AutoProcessor,
 *   CLIPTextModelWithProjection, CLIPVisionModelWithProjection, RawImage,
 * } from '@huggingface/transformers';
 *
 * const MODEL = 'Xenova/clip-vit-base-patch32';
 * const tokenizer   = await AutoTokenizer.from_pretrained(MODEL);
 * const textModel   = await CLIPTextModelWithProjection.from_pretrained(MODEL, { dtype: 'fp32' });
 * const processor   = await AutoProcessor.from_pretrained(MODEL);
 * const visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: 'fp32' });
 *
 * const hnswConfig: HnswConfig = {
 *   dimension: 512,
 *   embeddingFn: async (text) => {
 *     const inputs = tokenizer(text, { padding: true, truncation: true });
 *     const { text_embeds } = await textModel(inputs);
 *     return new Float32Array(text_embeds.data);       // 512 floats
 *   },
 *   imageEmbeddingFn: async (buf) => {
 *     const image = await RawImage.fromBlob(new Blob([buf]));
 *     const inputs = await processor(image);
 *     const { image_embeds } = await visionModel(inputs);
 *     return new Float32Array(image_embeds.data);      // 512 floats
 *   },
 * };
 * ```
 *
 * ---
 *
 * ## How image documents work
 *
 * 1. **Field naming convention** — Any field whose name ends in `.jpeg`,
 *    `.jpg`, `.png` or `.webp` is treated as an image field.
 *
 * 2. **Inserting** — Pass the raw image bytes as a **base64 string** inside
 *    the JSON document. The DBMS decodes it to a `Buffer` automatically.
 *    ```ts
 *    await db.insertDocument('photos', JSON.stringify({
 *      id: 'cat-01',
 *      'photo.jpeg': fs.readFileSync('cat.jpg').toString('base64'),
 *    }));
 *    ```
 *
 * 3. **Storage** — Internally the `Buffer` is persisted to disk as base64
 *    inside a `{ __bin: "..." }` JSON wrapper in the RecordStore. It is
 *    stored in the same WAL-backed FreeBlockFile as all other data.
 *
 * 4. **B+ tree indexing** — Image fields are **excluded** from the B+ tree
 *    (indexing raw binary blobs is meaningless for key lookups).
 *
 * 5. **HNSW embedding** — On insert, the DBMS checks if the document
 *    contains an image field. If yes (and `imageEmbeddingFn` is provided),
 *    the image bytes are embedded with the **vision encoder**. Otherwise
 *    string fields are embedded with the **text encoder**. Both produce
 *    vectors in the same space so they share one HNSW index.
 *
 * 6. **Searching** — Use {@link SimpleDbms.semanticSearch} with a text query
 *    to find matching images (text → image). Use
 *    {@link SimpleDbms.semanticImageSearch} with a `Buffer` to find visually
 *    similar images (image → image).
 *
 * 7. **Reading back** — `getDocumentById` and search results return the
 *    image as a base64 string in JSON, identical to the insertion format.
 *
 * 8. **Image format** — JPEG, PNG and WebP all work. The actual pixel format
 *    does not affect search quality; CLIP decodes any of them to pixels
 *    internally before computing the embedding.
 *
 * ---
 *
 * **Important:**
 * - `dimension` must exactly match the number of floats your model outputs.
 * - Pass the **same** `HnswConfig` to both `create()` and every subsequent
 *   `open()` call — the config is not persisted on disk.
 * - A single `commit()` atomically persists records, B+ tree indexes, and
 *   HNSW vectors together via the WAL.
 */
export type { HnswConfig };
export { MutationRecoveryRequiredError } from '../storage/blocks/freeblockfile.mjs';
export type {
  CompressionRecommendation,
  CompressionRecommendationItem,
  CompressionRecommendationRequest,
  CompressionStorageEstimate,
  CompressionRecommendationWeights,
} from './compression-advisor.mjs';
export type { CompressionProfileSummary } from './compression-profiles.mjs';
import { type File } from '../storage/file.mjs';
import {
  documentToJSON,
  parseRawDocument,
  validateUnicodeString,
  type Document,
  type FieldValue,
  type RawId,
} from './document.mjs';
import { JSONtoDocument } from './document.mjs';
import { type FieldCompressionDefaults, type FieldCompressionOverrides } from './compression.mjs';
import {
  listAvailableCompressionProfiles,
  type CompressionRecommendation,
  type CompressionRecommendationRequest,
} from './compression-advisor.mjs';
import { type CompressionProfileSummary } from './compression-profiles.mjs';
import { type EncodedDocument } from '../storage/records/recordstore.mjs';
import type {
  IncrementalCompactionPolicy,
  IncrementalCompactionResult,
  VacuumProgress,
} from '../compaction/compaction.mjs';

/**
 * SimpleDbms class
 *
 * Provides a high-level interface for interacting with the database management system.
 * Supports operations such as creating/opening a database, inserting, retrieving,
 * and deleting documents, as well as cursor-based iteration over documents.
 */
export class SimpleDbms {
  private dbmsback: DbmsBack;
  private reopening: Promise<void> | undefined;

  /**
   * Private constructor for the SimpleDbms class.
   * @param dbmsback - The DbmsBack instance to use for backend operations.
   */
  private constructor(
    dbmsback: DbmsBack,
    private readonly hnswConfig = dbmsback.getVacuumHnswConfig(),
  ) {
    this.dbmsback = dbmsback;
  }

  /**
   * Creates a new instance of the SimpleDbms class.
   * @param dataFile   - The data file to use for the database.
   * @param logFile    - The log file to use for the database.
   * @param hnswConfig - Optional. Supply an {@link HnswConfig} to enable
   *   HNSW semantic search. See the `HnswConfig` documentation for a
   *   full usage example.
   * @returns A Promise that resolves to a new instance of the SimpleDbms class.
   */
  static async create(dataFile: File, logFile: File, hnswConfig?: HnswConfig): Promise<SimpleDbms> {
    const dbmsback = new DbmsBack(dataFile, logFile, hnswConfig);
    await dbmsback.create();
    return new SimpleDbms(dbmsback, hnswConfig);
  }

  /**
   * Opens an existing instance of the SimpleDbms class.
   * @param dataFile   - The data file to use for the database.
   * @param logFile    - The log file to use for the database.
   * @param hnswConfig - Optional. Must be the same config (same `embeddingFn`
   *   and `dimension`) that was used when the database was created. Required
   *   if you want to call `semanticSearch()` on the reopened instance.
   * @returns A Promise that resolves to a new instance of the SimpleDbms class.
   */
  static async open(dataFile: File, logFile: File, hnswConfig?: HnswConfig): Promise<SimpleDbms> {
    const dbmsback = await DbmsBack.open(dataFile, logFile, hnswConfig);
    return new SimpleDbms(dbmsback, hnswConfig);
  }

  /**
   * Reopens an existing instance of the SimpleDbms class.
   * @param datafile - The data file to use for the database.
   * @param logfile - The log file to use for the database.
   */
  async reopen(datafile: File, logfile: File): Promise<void> {
    const perform = async (): Promise<void> => {
      await this.dbmsback.close();
      this.dbmsback = await DbmsBack.open(datafile, logfile, this.hnswConfig);
    };
    const reopening = this.reopening ? this.reopening.then(perform, perform) : perform();
    this.reopening = reopening;
    const clear = (): void => {
      if (this.reopening === reopening) this.reopening = undefined;
    };
    void reopening.then(clear, clear);
    await reopening;
  }

  /**
   * Retrieves a list of all collection names in the database.
   * @returns A Promise that resolves to an array of collection names.
   */
  async getCollections(): Promise<string[]> {
    return this.dbmsback.getCollections();
  }

  /**
   * Deletes a collection from the database and commits the change.
   * @param collection - The name of the collection to delete.
   */
  async deleteCollection(collection: string): Promise<void> {
    await this.dbmsback.deleteCollection(collection);
    await this.dbmsback.commit();
  }

  /**
   * Closes the database management system.
   * @returns A Promise that resolves when the database is closed.
   */
  async close(): Promise<void> {
    if (this.reopening) await this.reopening.catch(() => undefined);
    await this.dbmsback.close();
  }

  /**
   * Inserts a document into the specified collection.
   *
   * The document is a JSON string with at least an `id` field. Regular fields
   * (string, number, boolean) follow the collection's Indexed settings and
   * default to indexed in the B+ tree. Fields whose names
   * end in `.jpeg`, `.jpg`, `.png` or `.webp` are treated as image fields:
   * pass the raw bytes as a **base64 string** and the DBMS stores them as a
   * `Buffer` internally. Image fields are excluded from B+ tree indexes but
   * embedded into HNSW when `imageEmbeddingFn` is configured.
   *
   * @param collection   - The collection to insert into.
   * @param documentJSON - JSON string, e.g.
   *   `'{"id":"dog","photo.jpeg":"<base64>"}'`
   */
  async insertDocument(
    collection: string,
    documentJSON: string,
    options?: { compression?: FieldCompressionOverrides; skipSemanticIndex?: boolean },
  ): Promise<void> {
    const documentObj = JSONtoDocument(documentJSON, collection);
    return this.dbmsback.insertDocument(documentObj, options?.compression, {
      skipSemanticIndex: options?.skipSemanticIndex,
    });
  }

  /**
   * Insert a document from a pre-parsed object (avoids JSONtoDocument regex issues).
   * Use this when the document is already a JS object (e.g. from the web API).
   */
  async insertDocumentObject(
    collection: string,
    document: unknown,
    options?: {
      compression?: FieldCompressionOverrides;
      skipSemanticIndex?: boolean;
    },
  ): Promise<void> {
    const documentObj = parseRawDocument(collection, document);
    return this.dbmsback.insertDocument(documentObj, options?.compression, {
      skipSemanticIndex: options?.skipSemanticIndex,
    });
  }

  /**
   * Retrieves a document by its ID from the specified collection.
   * @param collection - The name of the collection to retrieve the document from.
   * @param id - The ID of the document to retrieve.
   * @returns A Promise that resolves to the JSON representation of the document.
   */
  async getDocumentById(collection: string, id: string | number, options?: { encoded?: boolean }): Promise<string> {
    const document = await this.dbmsback.getDocument(id, collection, options?.encoded ?? false);
    if (options?.encoded) {
      return JSON.stringify(this.encodedDocumentToObject(document as EncodedDocument));
    }
    return documentToJSON(document as Document);
  }

  /** Read decoded field values without converting binary fields to JSON strings. */
  async getDocumentObjectById(collection: string, id: RawId): Promise<Record<string, FieldValue> & { id: RawId }> {
    const document = (await this.dbmsback.getDocument(id, collection, false)) as Document;
    return document.asDocument();
  }

  setFieldCompressionDefaults(collection: string, defaults: FieldCompressionDefaults): void {
    this.dbmsback.setFieldCompressionDefaults(collection, defaults);
  }

  getFieldCompressionDefaults(collection: string): FieldCompressionDefaults {
    return this.dbmsback.getFieldCompressionDefaults(collection);
  }

  getFieldIndexConfig(collection: string): Record<string, boolean> {
    return this.dbmsback.getFieldIndexConfig(collection);
  }

  async setFieldIndexed(collection: string, field: string, indexed: boolean): Promise<void> {
    await this.dbmsback.setFieldIndexed(collection, field, indexed);
  }

  validateDocument(collection: string, raw: unknown, decodeImageStrings = true): void {
    this.dbmsback.validateDocument(parseRawDocument(collection, raw, decodeImageStrings));
  }

  getPendingSemanticCollections(): string[] {
    return this.dbmsback.getPendingSemanticCollections();
  }

  listCompressionProfiles(): CompressionProfileSummary[] {
    return listAvailableCompressionProfiles();
  }

  async recommendCompression(request: CompressionRecommendationRequest): Promise<CompressionRecommendation> {
    return this.dbmsback.recommendCompression(request);
  }

  /**
   * Deletes a document by its ID from the specified collection.
   * @param collection - The name of the collection to delete the document from.
   * @param id - The ID of the document to delete.
   * @returns A Promise that resolves when the document is deleted.
   */
  async deleteDocumentById(collection: string, id: string | number): Promise<void> {
    return this.dbmsback.deleteDocument(id, collection);
  }

  /**
   * Edits a field in a document by its ID.
   * It is not allowed to change the document ID or collection name during edit.
   * @param collection - The name of the collection to edit the document in.
   * @param id - The ID of the document to edit.
   * @param field - The field to edit.
   * @param newValue - The new value for the field.
   * @returns A Promise that resolves when the document is edited.
   *
   * @author Matisse De Gauquier
   */
  async editDocument(collection: string, id: string | number, field: string, newValue: FieldValue): Promise<void> {
    await this.dbmsback.editDocumentByID(collection, id, field, newValue);
  }

  /**
   * Replace the entire body of an existing document. The `id` field
   * must match the existing document; collection and id are immutable.
   * Any fields absent from `newDocument` are dropped.
   *
   * @param collection - Collection that owns the document.
   * @param id - ID of the document to replace.
   * @param newDocument - Full replacement payload (raw object). Must include the same `id`.
   */
  async replaceDocument(
    collection: string,
    id: string | number,
    newDocument: unknown,
    options?: { compression?: FieldCompressionOverrides; preserveCompression?: boolean; decodeImageStrings?: boolean },
  ): Promise<void> {
    const doc = parseRawDocument(collection, newDocument, options?.decodeImageStrings ?? true);
    await this.dbmsback.replaceDocumentByID(collection, id, doc, options?.compression, options?.preserveCompression);
  }

  /**
   * Returns the physical on-disk byte footprint of a single document
   * (`chainLength × blockSize`). Throws if the document does not exist.
   */
  async getDocumentStoredBytes(collection: string, id: RawId): Promise<number> {
    return this.dbmsback.getDocumentStoredBytes(collection, id);
  }

  /**
   * Returns the sum of physical block bytes used by every document in
   * a collection. Excludes B+ tree index blocks and HNSW vector blocks.
   */
  async getCollectionRecordBytes(collection: string): Promise<number> {
    return this.dbmsback.getCollectionRecordBytes(collection);
  }

  /** Counts primary index entries without loading document bodies or images. */
  async countDocuments(collection: string): Promise<number> {
    return this.dbmsback.getPrimaryReferenceCount(collection);
  }

  async getDocumentIds(collection: string): Promise<Array<string | number>> {
    return this.dbmsback.getDocumentIds(collection);
  }

  async hasDocument(collection: string, id: RawId): Promise<boolean> {
    return (await this.dbmsback.getDocumentBlockId(collection, id)) !== null;
  }

  /**
   * Physical block size in bytes. Useful for surfacing accurate byte
   * accounting in UIs (every record reservation is a whole multiple of
   * this value).
   */
  getBlockSize(): number {
    return this.dbmsback.getBlockSize();
  }

  /**
   * Creates a cursor for iterating over documents in a collection.
   * @param collection - The name of the collection to query.
   * @param iterableKey - The key to iterate over.
   * @param value - The value to match (optional).
   * @returns An AsyncIterable that yields the JSON representation of each document.
   */
  cursor(collection: string, iterableKey: string, value?: string | number | Buffer): AsyncIterable<string> {
    const backendCursorPromise = this.dbmsback.cursor(collection, iterableKey, value);

    // The returned object implements AsyncIterable<string>
    return {
      async *[Symbol.asyncIterator]() {
        const backendCursor = await backendCursorPromise;

        for await (const document of backendCursor) {
          yield documentToJSON(document);
        }
      },
    };
  }

  /** Index-ordered JSON documents with complete positions for cursor pagination. */
  cursorWithPosition(
    collection: string,
    iterableKey: string,
    after?: IndexCursorPosition,
  ): AsyncIterable<{ document: string; position: IndexCursorPosition }> {
    const backendCursorPromise = this.dbmsback.cursorWithPosition(collection, iterableKey, after);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const { document, position } of await backendCursorPromise) {
          yield { document: documentToJSON(document), position };
        }
      },
    };
  }

  /**
   * Seek the secondary index on `field` to `value` and yield matching
   * documents — stopping as soon as the cursor crosses past entries
   * whose `field` differs.
   *
   * This is the index-aware version of a `WHERE field = X` scan:
   *
   *   - Field **is** indexed → B+ tree seek to the matching leaf,
   *     yield each doc, stop when the field value changes. Best case
   *     O(log N + matches).
   *   - Field is **not** indexed → falls back to a full scan over the
   *     `id` index. Caller doesn't need to discriminate.
   *
   * The fallback path makes this method safe to call from a planner
   * that doesn't know which fields carry an index.
   */
  cursorEqual(collection: string, field: string, value: string | number | boolean): AsyncIterable<string> {
    const dbmsback = this.dbmsback;
    const indexed = (() => {
      try {
        return dbmsback.describeCollection(collection).some((f) => f.name === field);
      } catch {
        return false;
      }
    })();

    if (field === 'id') {
      return {
        async *[Symbol.asyncIterator]() {
          if (typeof value === 'boolean') return;
          let document: Document;
          try {
            document = (await dbmsback.getDocument(value, collection, false)) as Document;
          } catch (error) {
            if (
              error instanceof Error &&
              ['Document not found', 'No document with given id exists'].includes(error.message)
            )
              return;
            throw error;
          }
          if (document.getId() === value) yield documentToJSON(document);
        },
      };
    }

    if (!indexed) {
      const inner = this.dbmsback.cursor(collection, 'id', undefined);
      return {
        async *[Symbol.asyncIterator]() {
          const cursor = await inner;
          if (typeof value === 'string') validateUnicodeString(value, 'Index value');
          for await (const document of cursor) {
            const json = documentToJSON(document);
            const parsed = JSON.parse(json) as Record<string, unknown>;
            if (parsed[field] === value) yield json;
          }
        },
      };
    }

    // Indexed field: prefix-seek the secondary tree, stop on first
    // mismatching value. `cursor()` accepts the bare value as a prefix
    // for composite keys (see toBuffer in dbmsback.mts).
    const startValue = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    const backendCursorPromise = this.dbmsback.cursor(collection, field, startValue);
    return {
      async *[Symbol.asyncIterator]() {
        const cursor = await backendCursorPromise;
        for await (const document of cursor) {
          const json = documentToJSON(document);
          try {
            const parsed = JSON.parse(json) as Record<string, unknown>;
            if (parsed[field] === value) {
              yield json;
            } else if (
              (typeof parsed[field] === 'number' || typeof parsed[field] === 'boolean') &&
              (typeof value === 'number' || typeof value === 'boolean') &&
              Number(parsed[field]) === Number(value)
            ) {
              // Booleans share numeric key encoding. Skip a different logical
              // value within the same prefix instead of ending the seek early.
              continue;
            } else {
              // First key past the matching prefix — done.
              return;
            }
          } catch {
            // Best effort: if a doc can't be parsed, yield it and let
            // the caller decide. Stops the seek there.
            yield json;
            return;
          }
        }
      },
    };
  }

  /**
   * Commits all changes to the database.
   * @returns A Promise that resolves when the commit is complete.
   */
  async commit(): Promise<void> {
    await this.dbmsback.commit();
  }

  /** An unsafe session must be closed and replaced with a freshly opened instance. */
  assertHealthy(): void {
    this.dbmsback.assertHealthy();
  }

  get isHealthy(): boolean {
    return this.dbmsback.isHealthy;
  }

  async runIncrementalCompactionStep(policy?: IncrementalCompactionPolicy): Promise<IncrementalCompactionResult> {
    return await this.dbmsback.runIncrementalCompactionStep(policy);
  }

  async compactIfNeeded(policy?: IncrementalCompactionPolicy): Promise<IncrementalCompactionResult | null> {
    return await this.dbmsback.compactIfNeeded(policy);
  }

  async getCompactionStorageStats() {
    return await this.dbmsback.getCompactionStorageStats();
  }

  /**
   * Text-based semantic search (text → text **or** text → image).
   *
   * Embeds `query` with the text `embeddingFn` from {@link HnswConfig} and
   * returns the `k` nearest documents from the collection's HNSW index.
   * Because text and image vectors share the same space (e.g. CLIP),
   * this also returns matching image documents.
   *
   * @param collection - The collection to search.
   * @param query      - Natural-language query string.
   * @param k          - Maximum number of results.
   * @returns JSON-serialised documents ordered by similarity (closest first).
   *   Image fields are returned as base64 strings.
   */
  async semanticSearch(collection: string, query: string, k: number): Promise<string[]> {
    const documents = await this.dbmsback.semanticSearch(collection, query, k);
    return documents.map(documentToJSON);
  }

  /**
   * Text-to-image semantic search against the collection's image HNSW index.
   *
   * Embeds `query` with the image index text encoder (for CLIP this is the
   * CLIP text tower) and returns image-bearing documents ordered by similarity.
   */
  async semanticImageTextSearch(collection: string, query: string, k: number): Promise<string[]> {
    const documents = await this.dbmsback.semanticImageTextSearch(collection, query, k);
    return documents.map(documentToJSON);
  }

  /**
   * Image-based semantic search (image → image).
   *
   * Embeds `queryImage` with the `imageEmbeddingFn` from {@link HnswConfig}
   * and returns the `k` most visually similar documents.
   *
   * @param collection - The collection to search.
   * @param queryImage - Raw image bytes as a `Buffer` (JPEG, PNG or WebP).
   * @param k          - Maximum number of results.
   * @returns JSON-serialised documents ordered by similarity (closest first).
   */
  async semanticImageSearch(collection: string, queryImage: Buffer, k: number): Promise<string[]> {
    const documents = await this.dbmsback.semanticImageSearch(collection, queryImage, k);
    return documents.map(documentToJSON);
  }

  getHnswIndexKeys(): string[] {
    return Object.keys(this.dbmsback.getVacuumHnswMetaSnapshot());
  }

  /**
   * Rebuild this database into fresh temporary files using full vacuum compaction.
   */
  async vacuumCompactInto(
    tempDataFile: File,
    tempLogFile: File,
    onProgress?: (progress: VacuumProgress) => void,
  ): Promise<SimpleDbms> {
    const compactedBack = await this.dbmsback.vacuumCompactInto(tempDataFile, tempLogFile, onProgress);
    return new SimpleDbms(compactedBack);
  }

  /**
   * Return the names of all collections in the database.
   */
  listCollections(): string[] {
    return this.dbmsback.listCollections();
  }

  /**
   * Return indexed field names and their inferred types for a collection.
   * Useful for auto-generating a semantic model config.
   */
  describeCollection(collection: string): { name: string; type: 'string' | 'number' }[] {
    return this.dbmsback.describeCollection(collection);
  }

  private encodedDocumentToObject(document: EncodedDocument): Record<string, unknown> {
    const toFieldValue = (entry: EncodedDocument['iterableEntries'][number]) => ({
      valueType: entry.valueType,
      compression: entry.compression,
      payloadBase64: entry.payloadBase64,
    });

    const fields = Object.fromEntries(
      [...document.iterableEntries, ...document.nonIterableEntries].map((entry) => [entry.key, toFieldValue(entry)]),
    );

    return {
      id: document.id,
      ...fields,
    };
  }
}
