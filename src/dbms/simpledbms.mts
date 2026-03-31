// author: Thomas Dumon
// date: 2025-12-07

import { DbmsBack, type HnswConfig } from './dbmsback.mjs';

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
import { type File } from '../core/file.mjs';
import { documentToJSON, parseRawDocument, type FieldValue } from './document.mjs';
import { JSONtoDocument } from './document.mjs';

/**
 * SimpleDbms class
 *
 * Provides a high-level interface for interacting with the database management system.
 * Supports operations such as creating/opening a database, inserting, retrieving,
 * and deleting documents, as well as cursor-based iteration over documents.
 */
export class SimpleDbms {
  private dbmsback: DbmsBack;

  /**
   * Private constructor for the SimpleDbms class.
   * @param dbmsback - The DbmsBack instance to use for backend operations.
   */
  private constructor(dbmsback: DbmsBack) {
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
    return new SimpleDbms(dbmsback);
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
    return new SimpleDbms(dbmsback);
  }

  /**
   * Reopens an existing instance of the SimpleDbms class.
   * @param datafile - The data file to use for the database.
   * @param logfile - The log file to use for the database.
   */
  async reopen(datafile: File, logfile: File): Promise<void> {
    const dbmsback = await DbmsBack.open(datafile, logfile);
    this.dbmsback = dbmsback;
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
    await this.dbmsback.close();
  }

  /**
   * Inserts a document into the specified collection.
   *
   * The document is a JSON string with at least an `id` field. Regular fields
   * (string, number, boolean) are indexed in the B+ tree. Fields whose names
   * end in `.jpeg`, `.jpg`, `.png` or `.webp` are treated as image fields:
   * pass the raw bytes as a **base64 string** and the DBMS stores them as a
   * `Buffer` internally. Image fields are excluded from B+ tree indexes but
   * embedded into HNSW when `imageEmbeddingFn` is configured.
   *
   * @param collection   - The collection to insert into.
   * @param documentJSON - JSON string, e.g.
   *   `'{"id":"dog","photo.jpeg":"<base64>"}'`
   */
  async insertDocument(collection: string, documentJSON: string): Promise<void> {
    const documentObj = JSONtoDocument(documentJSON, collection);
    return this.dbmsback.insertDocument(documentObj);
  }

  /**
   * Insert a document from a pre-parsed object (avoids JSONtoDocument regex issues).
   * Use this when the document is already a JS object (e.g. from the web API).
   */
  async insertDocumentObject(collection: string, document: unknown): Promise<void> {
    const documentObj = parseRawDocument(collection, document);
    return this.dbmsback.insertDocument(documentObj);
  }

  /**
   * Retrieves a document by its ID from the specified collection.
   * @param collection - The name of the collection to retrieve the document from.
   * @param id - The ID of the document to retrieve.
   * @returns A Promise that resolves to the JSON representation of the document.
   */
  async getDocumentById(collection: string, id: string): Promise<string> {
    const document = await this.dbmsback.getDocument(id, collection);
    return documentToJSON(document);
  }

  /**
   * Deletes a document by its ID from the specified collection.
   * @param collection - The name of the collection to delete the document from.
   * @param id - The ID of the document to delete.
   * @returns A Promise that resolves when the document is deleted.
   */
  async deleteDocumentById(collection: string, id: string): Promise<void> {
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
  async editDocument(collection: string, id: string, field: string, newValue: FieldValue): Promise<void> {
    await this.dbmsback.editDocumentByID(collection, id, field, newValue);
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

  /**
   * Commits all changes to the database.
   * @returns A Promise that resolves when the commit is complete.
   */
  async commit(): Promise<void> {
    await this.dbmsback.commit();
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
}
