// author: Thomas Dumon
// date: 2025-12-07

import { DbmsBack, type HnswConfig } from './dbmsback.mjs';

/**
 * Optional configuration that enables HNSW-based semantic (approximate
 * nearest-neighbour) search inside a `SimpleDbms` instance.
 *
 * Pass this to `SimpleDbms.create()` or `SimpleDbms.open()` to activate the
 * feature.  Once enabled, every `insertDocument()` call automatically embeds
 * all non-underscore-prefixed string fields of the document and indexes them
 * in the collection's HNSW graph.  You can then call `semanticSearch()` to
 * retrieve the k most semantically similar documents for a query string.
 *
 * @example
 * ```typescript
 * import { pipeline } from '@huggingface/transformers';
 * import { SimpleDbms, type HnswConfig } from './simpledbms.mjs';
 * import { AtomicFile } from '../atomic/atomicfile.mjs';
 *
 * // pipeline() downloads the model on first run and caches it locally.
 * // 'Xenova/all-MiniLM-L6-v2' produces 384-dimensional float32 vectors.
 * const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
 *
 * const hnswConfig: HnswConfig = {
 *   dimension: 384, // must match the model output size
 *   embeddingFn: async (text) => {
 *     const out = await extractor(text, { pooling: 'mean', normalize: true });
 *     return new Float32Array(out.data);
 *   },
 *   // All of the following are optional:
 *   M: 16,             // max neighbours per HNSW node   (default 16)
 *   efConstruction: 200, // ef during index build         (default 200)
 *   efSearch: 50,      // ef during search queries       (default 50)
 * };
 *
 * const db = await SimpleDbms.create(
 *   new AtomicFile('mydb.data', 'mydb.data.log'),
 *   new AtomicFile('mydb.log',  'mydb.log.log'),
 *   hnswConfig,
 * );
 *
 * await db.insertDocument('articles', JSON.stringify({ id: '1', title: 'Neural networks' }));
 * await db.commit();
 *
 * const results = await db.semanticSearch('articles', 'deep learning', 5);
 * // → string[] of the 5 closest documents, serialised as JSON
 * ```
 *
 * **Important:**
 * - `dimension` must exactly match the number of floats your model outputs.
 * - Pass the **same** `HnswConfig` (with the same `embeddingFn`) to both
 *   `create()` and every subsequent `open()` call; the config is not persisted
 *   on disk.
 * - The HNSW index shares the same WAL-backed file as records and B+ tree
 *   indexes, so a single `commit()` atomically persists everything.
 */
export type { HnswConfig };
import { type File } from '../core/file.mjs';
import { documentToJSON, type FieldValue } from './document.mjs';
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
   * Closes the database management system.
   * @returns A Promise that resolves when the database is closed.
   */
  async close(): Promise<void> {
    await this.dbmsback.close();
  }

  /**
   * Inserts a document into the specified collection.
   * @param collection - The name of the collection to insert the document into.
   * @param documentJSON - The JSON representation of the document to insert.
   * @returns A Promise that resolves when the document is inserted.
   */
  async insertDocument(collection: string, documentJSON: string): Promise<void> {
    const documentObj = JSONtoDocument(documentJSON, collection);
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
   * Perform a semantic (approximate nearest-neighbour) search over all
   * text-indexed documents in a collection.
   *
   * Requires an `HnswConfig` to have been passed to `create()` / `open()`.
   *
   * @param collection - The collection to search in.
   * @param query      - A natural-language query string.
   * @param k          - Maximum number of results to return.
   * @returns Array of JSON-serialised documents ordered by semantic similarity.
   */
  async semanticSearch(collection: string, query: string, k: number): Promise<string[]> {
    const documents = await this.dbmsback.semanticSearch(collection, query, k);
    return documents.map(documentToJSON);
  }
}
