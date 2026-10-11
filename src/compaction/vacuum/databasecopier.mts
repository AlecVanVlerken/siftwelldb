// @author: Alec Van Vlerken
// @date: 2026-04-21

/**
 * databasecopier.mts
 * -------------------------
 * This module implements logical data copying for the vacuum
 * compaction subsystem.
 *
 * The copier rebuilds the database by reading logical documents
 * from the source backend and reinserting them into a fresh target
 * backend. For HNSW-backed collections, the target semantic index is rebuilt
 * only from live logical documents; persisted source graph/vector tombstones
 * are intentionally not copied.
 *
 * This module provides:
 *   • copyAll()        — copy all logical collections
 *
 * Additionally, internal helpers exist:
 *   • copyCollection() — copy one collection
 *   • reportProgress() — emit progress events when configured
 *
 * The copier works strictly through normal DBMS APIs.
 * It does not manipulate:
 *   • raw block numbers
 *   • free-list entries
 *   • B+ tree nodes directly
 *   • HNSW graph blocks directly
 *   • record-chain internals
 *
 * By reinserting logical documents into the target database, the normal
 * insertion flow automatically rebuilds:
 *   • RecordStore chains
 *   • B+ tree roots and nodes
 *   • field indexes
 *   • metadata roots
 *   • HNSW indexes and storage, if configured
 */

import type { DbmsBack } from '../../database/dbmsback.mjs';
import type { EncodedDocument } from '../../storage/records/recordstore.mjs';
import { CollectionCatalog } from './collectioncatalog.mjs';
import type { VacuumProgress } from './vacuumtypes.mjs';

/**
 * Summary of a completed database copy operation.
 */
export type DatabaseCopyResult = {
  collectionsCopied: number;
  documentsCopied: number;
};

/**
 * Copies all logical collections and documents from a source DBMS backend
 * into a fresh target DBMS backend.
 *
 * The source database is assumed to be open and stable.
 * The target database is assumed to be freshly created and ready to accept
 * inserts.
 */
export class DatabaseCopier {
  /**
   * Creates a new DatabaseCopier.
   *
   * @param {DbmsBack} source - The source database backend being compacted.
   * @param {DbmsBack} target - The fresh target database backend that receives copied data.
   * @param {CollectionCatalog} catalog - Collection metadata helper for the source DB.
   * @param {(progress: VacuumProgress) => void} onProgress - Optional progress callback.
   *
   * @author Alec Van Vlerken
   */
  constructor(
    private readonly source: DbmsBack,
    private readonly target: DbmsBack,
    private readonly catalog: CollectionCatalog,
    private readonly onProgress?: (progress: VacuumProgress) => void,
  ) {}

  /**
   * Copies all logical collections from the source database into the target
   * database.
   *
   * For each collection:
   *   • collection-level compression defaults are copied first
   *   • documents are read through the normal `id` cursor when an id tree exists
   *   • documents are reinserted through the normal insert flow
   *
   * This method reports progress at collection boundaries and while documents
   * are copied, if a progress callback was provided.
   *
   * @returns {Promise<DatabaseCopyResult>} Summary of copied collections and documents.
   *
   * @author Alec Van Vlerken
   */
  async copyAll(): Promise<DatabaseCopyResult> {
    const collections = this.catalog.listCollections();

    let collectionsCopied = 0;
    let documentsCopied = 0;

    for (const collection of collections) {
      const copiedInCollection = await this.copyCollection(collection);
      collectionsCopied += 1;
      documentsCopied += copiedInCollection;
    }

    return {
      collectionsCopied,
      documentsCopied,
    };
  }

  /**
   * Copies one logical collection from the source database into the target
   * database.
   *
   * The collection copy process is:
   *   • copy collection-level compression defaults, if configured
   *   • if no `id` tree exists, stop there and return 0
   *   • otherwise read documents through `source.cursor(collection, 'id')`
   *   • insert each document into the target DB through normal insertion
   *
   * A logical collection may exist without any documents yet. In that case
   * it may still need to survive vacuum because metadata such as compression
   * defaults may exist. Therefore compression defaults are copied even when
   * the collection has no `id` tree.
   *
   * @param {string} collection - The collection name to copy.
   * @returns {Promise<number>} Number of copied logical documents in that collection.
   *
   * @author Alec Van Vlerken
   */
  private async copyCollection(collection: string): Promise<number> {
    for (const [field, indexed] of Object.entries(this.source.getFieldIndexConfig(collection))) {
      await this.target.setFieldIndexed(collection, field, indexed);
    }
    const compressionDefaults = this.catalog.getCompressionDefaults(collection);
    if (compressionDefaults) {
      this.target.setFieldCompressionDefaults(collection, compressionDefaults);
    }

    if (!this.catalog.hasIdTree(collection)) {
      await this.ensureCleanHnswTarget(collection);
      return 0;
    }

    let copiedDocuments = 0;
    const expectedDocuments = await this.source.getPrimaryReferenceCount(collection);

    this.reportProgress({
      phase: 'copy-collection',
      collection,
      copiedDocuments: 0,
    });

    const docs = await this.source.cursor(collection, 'id');

    for await (const doc of docs) {
      const stored = (await this.source.getDocument(doc.getId(), collection, true)) as EncodedDocument;
      // Preserve actual stored codecs, including 'none', even if defaults have
      // changed since insertion or compression was explicitly disabled.
      const compression = Object.fromEntries(
        [...stored.iterableEntries, ...stored.nonIterableEntries].map((entry) => [entry.key, entry.compression]),
      );
      await this.target.insertDocument(doc, compression);
      copiedDocuments += 1;

      this.reportProgress({
        phase: 'copy-collection',
        collection,
        copiedDocuments,
      });
    }

    if (copiedDocuments !== expectedDocuments) {
      throw new Error(
        `Vacuum copy failed for collection "${collection}": ` +
          `copied ${copiedDocuments} documents from ${expectedDocuments} live primary references.`,
      );
    }

    if (copiedDocuments === 0) {
      const type = this.source.describeCollection(collection).find((field) => field.name === 'id')!.type;
      await this.target.ensurePrimaryIndex(collection, type);
    }
    await this.ensureCleanHnswTarget(collection);
    return copiedDocuments;
  }

  private async ensureCleanHnswTarget(collection: string): Promise<void> {
    if (!this.catalog.hasHnsw(collection)) return;

    // Full vacuum is the semantic cleanup/reset point. The target HNSW
    // metadata is created fresh, and only live logical documents copied above
    // are indexed. Tombstoned source graph/vector units are never copied.
    await this.target.ensureHnswCollection(collection);
  }

  /**
   * Emits a progress event if a progress callback was provided.
   *
   * @param {VacuumProgress} progress - Progress event to emit.
   * @returns {void}
   *
   * @author Alec Van Vlerken
   */
  private reportProgress(progress: VacuumProgress): void {
    this.onProgress?.(progress);
  }
}
