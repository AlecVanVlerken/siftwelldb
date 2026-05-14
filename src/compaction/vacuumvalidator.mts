// @author: Alec Van Vlerken
// @date: 2026-04-22

/**
 * vacuumvalidator.mts
 * -------------------------
 * This module implements logical validation for the vacuum
 * compaction subsystem.
 *
 * The validator checks whether a rebuilt target database is correct enough
 * before the original files are replaced.
 *
 * Version 1 validation checks:
 *   • the collection exists in the target
 *   • source and target document counts match
 *   • every source document id exists in the target
 *
 * This validator works at the logical DBMS layer.
 * It does not compare:
 *   • block layouts
 *   • record-chain identities
 *   • B+ tree node identities
 *   • HNSW graph structure
 *   • exact compressed bytes
 *
 * A logical collection may exist without an `id` tree yet. In that case,
 * the collection has zero documents and validation must not try to iterate
 * `cursor(collection, 'id')`.
 */

import type { FieldCompressionDefaults } from '../dbms/compression.mjs';
import type { DbmsBack } from '../dbms/dbmsback.mjs';
import { documentToJSON } from '../dbms/document.mjs';
import { CollectionCatalog } from './collectioncatalog.mjs';

/**
 * Validates that the compacted target database preserves the logical contents
 * of the source database closely enough for the base vacuum implementation.
 */
export class VacuumValidator {
  private readonly targetCatalog: CollectionCatalog;

  /**
   * Creates a new VacuumValidator.
   *
   * @param {DbmsBack} source - The original source database backend.
   * @param {DbmsBack} target - The rebuilt compacted target database backend.
   * @param {CollectionCatalog} catalog - Collection catalog built from the source database.
   *
   * @author Alec Van Vlerken
   */
  constructor(
    private readonly source: DbmsBack,
    private readonly target: DbmsBack,
    private readonly catalog: CollectionCatalog,
  ) {
    this.targetCatalog = new CollectionCatalog(target);
  }

  /**
   * Validates all logical collections known to the source database.
   *
   * Validation is performed collection by collection. The method throws as soon
   * as a mismatch is found.
   *
   * @returns {Promise<void>}
   *
   * @throws {Error} If the rebuilt target database fails validation.
   *
   * @author Alec Van Vlerken
   */
  async validate(): Promise<void> {
    const collections = this.catalog.listCollections();

    for (const collection of collections) {
      await this.validateCollection(collection);
    }
  }

  /**
   * Validates one logical collection.
   *
   * Version 1 checks:
   *   • the collection exists in the target catalog
   *   • source and target document counts match
   *   • every source document id can be found in the target
   *
   * If the source collection has no `id` tree, then the collection has zero
   * documents and document-id validation is skipped.
   *
   * @param {string} collection - The collection name to validate.
   * @returns {Promise<void>}
   *
   * @throws {Error} If the collection fails validation.
   *
   * @author Alec Van Vlerken
   */
  private async validateCollection(collection: string): Promise<void> {
    this.assertTargetHasCollection(collection);
    this.assertCompressionDefaultsMatch(collection);

    const sourceHasIdTree = this.catalog.hasIdTree(collection);
    const targetHasIdTree = this.targetCatalog.hasIdTree(collection);

    const sourceCount = await this.countDocuments(this.source, this.catalog, collection);
    const targetCount = await this.countDocuments(this.target, this.targetCatalog, collection);

    if (sourceCount !== targetCount) {
      throw new Error(
        `Vacuum validation failed for collection "${collection}": ` +
          `document count mismatch (source=${sourceCount}, target=${targetCount}).`,
      );
    }

    if (!sourceHasIdTree) {
      if (targetHasIdTree) {
        throw new Error(
          `Vacuum validation failed for collection "${collection}": ` + `target has an id tree while source does not.`,
        );
      }
      return;
    }

    if (!targetHasIdTree) {
      throw new Error(
        `Vacuum validation failed for collection "${collection}": ` + `source has an id tree but target does not.`,
      );
    }

    const sourceDocs = await this.source.cursor(collection, 'id');

    for await (const doc of sourceDocs) {
      const id = doc.getId();

      if (id === undefined || id === null) {
        throw new Error(
          `Vacuum validation failed for collection "${collection}": ` +
            `encountered source document without a valid id.`,
        );
      }

      const targetDocs = await this.target.cursor(collection, 'id', id);

      let found = false;
      for await (const targetDoc of targetDocs) {
        if (targetDoc.getId() === id) {
          const sourceJson = documentToJSON(doc);
          const targetJson = documentToJSON(targetDoc);
          if (targetJson !== sourceJson) {
            throw new Error(
              `Vacuum validation failed for collection "${collection}": ` +
                `document with id "${String(id)}" has different contents in target database.`,
            );
          }

          found = true;
          break;
        }
      }

      if (!found) {
        throw new Error(
          `Vacuum validation failed for collection "${collection}": ` +
            `document with id "${String(id)}" not found in target database.`,
        );
      }
    }
  }

  /**
   * Counts the number of logical documents in the given collection.
   *
   * If the collection has no `id` tree, then its logical document count is
   * zero and no cursor iteration is attempted.
   *
   * @param {DbmsBack} db - The database backend to count from.
   * @param {CollectionCatalog} catalog - The collection catalog corresponding to the database.
   * @param {string} collection - The collection name.
   * @returns {Promise<number>} The number of logical documents in the collection.
   *
   * @author Alec Van Vlerken
   */
  private async countDocuments(db: DbmsBack, catalog: CollectionCatalog, collection: string): Promise<number> {
    if (!catalog.hasIdTree(collection)) {
      return 0;
    }

    let count = 0;

    for await (const doc of await db.cursor(collection, 'id')) {
      void doc;
      count += 1;
    }

    return count;
  }

  /**
   * Ensures that the target database still contains the given logical
   * collection.
   *
   * Collections may exist even when they currently have zero documents,
   * because metadata such as compression defaults or HNSW metadata may still
   * need to be preserved.
   *
   * @param {string} collection - The collection name to check.
   * @returns {void}
   *
   * @throws {Error} If the collection is missing in the target database.
   *
   * @author Alec Van Vlerken
   */
  private assertTargetHasCollection(collection: string): void {
    const targetCollections = new Set(this.targetCatalog.listCollections());

    if (!targetCollections.has(collection)) {
      throw new Error(`Vacuum validation failed: target database is missing collection "${collection}".`);
    }
  }

  private assertCompressionDefaultsMatch(collection: string): void {
    const sourceDefaults = this.catalog.getCompressionDefaults(collection);
    const targetDefaults = this.targetCatalog.getCompressionDefaults(collection);

    if (this.normalizedCompressionDefaults(sourceDefaults) !== this.normalizedCompressionDefaults(targetDefaults)) {
      throw new Error(
        `Vacuum validation failed for collection "${collection}": compression defaults differ between source and target.`,
      );
    }
  }

  private normalizedCompressionDefaults(defaults: FieldCompressionDefaults | undefined): string {
    if (!defaults) return '';
    return JSON.stringify(Object.entries(defaults).sort(([left], [right]) => left.localeCompare(right)));
  }
}
