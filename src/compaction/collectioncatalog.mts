// @author: Alec Van Vlerken
// @date: 2026-04-24

/**
 * collectioncatalog.mts
 * -------------------------
 * This module implements collection discovery logic for the vacuum
 * compaction subsystem.
 *
 * A logical collection may exist in multiple ways:
 *   • regular collection metadata (B+ tree roots)
 *   • compression metadata
 *   • HNSW metadata
 *
 * This module provides:
 *   • listCollections()         — return all logical collections
 *   • getCompressionDefaults()  — return compression defaults for a collection
 *   • hasHnsw()                 — check whether a collection has HNSW metadata
 *   • hasAnyHnswCollections()   — check whether any HNSW-backed collection exists
 *   • hasCollectionMeta()       — check whether a collection has regular metadata
 *   • hasIdTree()               — check whether a collection has an id tree
 *   • getIndexedFields()        — return indexed fields from regular metadata
 *
 * A collection may exist logically without having any documents yet.
 * In that case it may not have an `id` B+ tree yet, so callers must not
 * assume that `cursor(collection, 'id')` is always valid.
 */

import type { DbmsBack } from '../dbms/dbmsback.mjs';
import type { FieldCompressionDefaults } from '../dbms/compression.mjs';

/**
 * Snapshot type for regular collection metadata.
 */
type CollectionMetaSnapshot = Record<string, Record<string, [number, string]>>;

/**
 * Snapshot type for HNSW metadata.
 */
type HnswMetaSnapshot = Record<string, [number, string]>;

/**
 * Minimal read-only surface expected from DbmsBack by the vacuum subsystem.
 */
interface VacuumCatalogSource {
  getVacuumCollectionMetaSnapshot(): CollectionMetaSnapshot;
  getVacuumCompressionMetaSnapshot(): Record<string, FieldCompressionDefaults>;
  getVacuumHnswMetaSnapshot(): HnswMetaSnapshot;
}

/**
 * Helper class that exposes a normalized, vacuum-friendly view of the
 * logical collections known to the database backend.
 */
export class CollectionCatalog {
  private readonly sourceView: VacuumCatalogSource;

  /**
   * Creates a new CollectionCatalog.
   *
   * @param {DbmsBack} source - The source database backend being compacted.
   *
   * @author Alec Van Vlerken
   */
  constructor(private readonly source: DbmsBack) {
    this.sourceView = source as unknown as VacuumCatalogSource;
  }

  /**
   * Returns all logical collections known to the source database.
   *
   * The returned collection set is the union of:
   *   • regular collection metadata
   *   • compression metadata
   *   • HNSW metadata
   *
   * This ensures that metadata-only collections are preserved during vacuum.
   *
   * @returns {string[]} Sorted array of collection names.
   *
   * @author Alec Van Vlerken
   */
  listCollections(): string[] {
    const collections = new Set<string>();

    for (const collection of Object.keys(this.getCollectionMetaSnapshot())) {
      collections.add(collection);
    }

    for (const collection of Object.keys(this.getCompressionMetaSnapshot())) {
      collections.add(collection);
    }

    for (const collection of Object.keys(this.getHnswMetaSnapshot())) {
      collections.add(this.logicalCollectionFromHnswKey(collection));
    }

    return Array.from(collections).sort();
  }

  /**
   * Returns the compression defaults configured for the given collection.
   *
   * If the collection has no explicit compression defaults, `undefined`
   * is returned.
   *
   * @param {string} collection - The collection name.
   * @returns {FieldCompressionDefaults | undefined} Compression defaults for the collection.
   *
   * @author Alec Van Vlerken
   */
  getCompressionDefaults(collection: string): FieldCompressionDefaults | undefined {
    const compressionMeta = this.getCompressionMetaSnapshot();
    const defaults = compressionMeta[collection];
    if (!defaults) return undefined;
    return { ...defaults };
  }

  /**
   * Returns whether the given collection has HNSW metadata.
   *
   * @param {string} collection - The collection name.
   * @returns {boolean} True if the collection has HNSW metadata.
   *
   * @author Alec Van Vlerken
   */
  hasHnsw(collection: string): boolean {
    const hnswMeta = this.getHnswMetaSnapshot();
    return (
      collection in hnswMeta ||
      `${collection}::text` in hnswMeta ||
      `${collection}::image` in hnswMeta
    );
  }

  /**
   * Returns whether the source database contains any HNSW-backed collections.
   *
   * @returns {boolean} True if at least one collection has HNSW metadata.
   *
   * @author Alec Van Vlerken
   */
  hasAnyHnswCollections(): boolean {
    return Object.keys(this.getHnswMetaSnapshot()).length > 0;
  }

  private logicalCollectionFromHnswKey(indexKey: string): string {
    if (indexKey.endsWith('::text')) return indexKey.slice(0, -'::text'.length);
    if (indexKey.endsWith('::image')) return indexKey.slice(0, -'::image'.length);
    return indexKey;
  }

  /**
   * Returns whether the collection has regular collection metadata.
   *
   * Regular collection metadata corresponds to the normal per-collection
   * B+ tree metadata.
   *
   * @param {string} collection - The collection name.
   * @returns {boolean} True if the collection exists in regular metadata.
   *
   * @author Alec Van Vlerken
   */
  hasCollectionMeta(collection: string): boolean {
    return collection in this.getCollectionMetaSnapshot();
  }

  /**
   * Returns whether the collection currently has an `id` B+ tree.
   *
   * A logical collection may exist without any documents yet. In that case,
   * it may not have an `id` tree, and callers must not try to iterate it
   * through `cursor(collection, 'id')`.
   *
   * @param {string} collection - The collection name.
   * @returns {boolean} True if the collection has an `id` tree.
   *
   * @author Alec Van Vlerken
   */
  hasIdTree(collection: string): boolean {
    const collectionMeta = this.getCollectionMetaSnapshot()[collection];
    return !!collectionMeta && 'id' in collectionMeta;
  }

  /**
   * Returns the indexed fields present in the regular collection metadata.
   *
   * If the collection has no regular metadata, an empty array is returned.
   *
   * @param {string} collection - The collection name.
   * @returns {string[]} Sorted array of indexed field names.
   *
   * @author Alec Van Vlerken
   */
  getIndexedFields(collection: string): string[] {
    const collectionMeta = this.getCollectionMetaSnapshot()[collection];
    if (!collectionMeta) return [];
    return Object.keys(collectionMeta).sort();
  }

  /**
   * Returns a snapshot of the regular collection metadata map.
   *
   * @returns {CollectionMetaSnapshot} Snapshot of regular collection metadata.
   *
   * @author Alec Van Vlerken
   */
  private getCollectionMetaSnapshot(): CollectionMetaSnapshot {
    return this.sourceView.getVacuumCollectionMetaSnapshot();
  }

  /**
   * Returns a snapshot of the compression metadata map.
   *
   * @returns {Record<string, FieldCompressionDefaults>} Snapshot of compression metadata.
   *
   * @author Alec Van Vlerken
   */
  private getCompressionMetaSnapshot(): Record<string, FieldCompressionDefaults> {
    return this.sourceView.getVacuumCompressionMetaSnapshot();
  }

  /**
   * Returns a snapshot of the HNSW metadata map.
   *
   * @returns {HnswMetaSnapshot} Snapshot of HNSW metadata.
   *
   * @author Alec Van Vlerken
   */
  private getHnswMetaSnapshot(): HnswMetaSnapshot {
    return this.sourceView.getVacuumHnswMetaSnapshot();
  }
}
