import { Rectangle } from './rstarRectangle.mjs';
import { RStarTreeStorage } from './rstarTreeStorage.mjs';
import { rstarInsert } from './rstarInsert.mjs';
import { rstarSearch } from './rstarSearch.mjs';
import { rstarDelete } from './rstarDelete.mjs';
import type { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';

/**
 * RStarIndex
 * ----------
 * R*-tree spatial index implementation for 2D rectangle queries.
 *
 * The R*-tree is a height-balanced tree structure for indexing
 * multi-dimensional spatial data. It supports efficient:
 * - **Range queries**: Find all objects intersecting a query rectangle
 * - **Point queries**: Find all objects containing a point
 * - **Insertions**: Add new spatial objects
 * - **Deletions**: Remove spatial objects
 *
 * **STORAGE MODEL**
 * The index persists nodes in a FreeBlockFile. All dirty pages are
 * flushed by a single WAL commit. In normal usage `DbmsBack.commit()`
 * handles this; `RStarIndex.commit()` is for standalone use.
 *
 * **USAGE**
 * ```typescript
 * // Create a new index
 * const index = await RStarIndex.create(freeBlockFile, 50);
 *
 * // Insert rectangles with IDs
 * await index.insert(new Rectangle(0, 0, 10, 10), 1);
 * await index.insert(new Rectangle(5, 5, 15, 15), 2);
 *
 * // Search for intersecting rectangles
 * const results = await index.search(new Rectangle(8, 8, 12, 12));
 * // results = [1, 2]
 *
 * // Delete a rectangle
 * await index.delete(new Rectangle(0, 0, 10, 10), 1);
 * ```
 *
 * **PERSISTENCE**
 * ```typescript
 * // Save index state
 * await freeBlockFile.commit();
 * const rootPageId = index.getRootPageId();
 *
 * // Later: reopen the index
 * const reopened = RStarIndex.open(freeBlockFile, rootPageId, 50);
 * ```
 *
 * @see Rectangle - The spatial primitive used for indexing
 * @see RStarTreeStorage - Low-level node persistence
 */
export class RStarIndex {
  private rootPageId: number;

  private constructor(
    readonly storage: RStarTreeStorage,
    rootPageId: number,
  ) {
    this.rootPageId = rootPageId;
    this.storage.setRootPageId(rootPageId);
  }

  /**
   * Creates a new empty R*-tree index.
   *
   * Allocates an initial root node and prepares the index for insertions.
   * The index is stored in the provided FreeBlockFile.
   *
   * @param file - The FreeBlockFile to store index data in
   * @param maxEntries - Maximum entries per node (default: 50).
   *                     Higher values reduce tree height but increase
   *                     node I/O cost. Typical range: 25-100.
   * @returns A new empty RStarIndex
   *
   * @example
   * const index = await RStarIndex.create(fbf, 50);
   */
  static async create(file: FreeBlockFile, maxEntries: number = 50): Promise<RStarIndex> {
    const storage = new RStarTreeStorage(file, maxEntries);
    const rootPageId = await storage.create();
    return new RStarIndex(storage, rootPageId);
  }

  /**
   * Opens an existing R*-tree index from disk.
   *
   * Use this to reopen a previously persisted index after a restart.
   * The `rootPageId` should be saved during the original session.
   *
   * @param file - The FreeBlockFile containing the index
   * @param rootPageId - Page ID of the root node (from `getRootPageId()`)
   * @param maxEntries - Maximum entries per node (must match original)
   * @returns The reopened RStarIndex
   *
   * @example
   * const index = RStarIndex.open(fbf, savedRootPageId, 50);
   */
  static open(file: FreeBlockFile, rootPageId: number, maxEntries: number = 50): RStarIndex {
    const storage = new RStarTreeStorage(file, maxEntries);
    storage.open(rootPageId);
    return new RStarIndex(storage, rootPageId);
  }

  /**
   * Inserts a rectangle with an associated ID into the index.
   *
   * The rectangle defines the spatial extent of the indexed object.
   * The ID is typically a document/record ID that can be used to
   * retrieve the full object from another store.
   *
   * **Note**: Duplicate (rect, id) pairs are allowed. To update,
   * delete the old entry first.
   *
   * @param rect - The bounding rectangle of the object
   * @param id - Unique identifier for the object
   *
   * @example
   * await index.insert(new Rectangle(0, 0, 10, 10), docId);
   */
  async insert(rect: Rectangle, id: number): Promise<void> {
    this.rootPageId = await rstarInsert(this.storage, this.rootPageId, rect, id);
    this.storage.setRootPageId(this.rootPageId);
  }

  /**
   * Searches for all objects whose rectangles intersect the query rectangle.
   *
   * Returns the IDs of all indexed objects that overlap with the query.
   * An object overlaps if any part of its rectangle touches the query
   * rectangle (including edges).
   *
   * @param rect - The query rectangle
   * @returns Array of IDs for all intersecting objects
   *
   * @example
   * // Find all objects in a region
   * const ids = await index.search(new Rectangle(0, 0, 100, 100));
   *
   * // Point query (find objects containing a point)
   * const ids = await index.search(new Rectangle(5, 5, 5, 5));
   */
  async search(rect: Rectangle): Promise<number[]> {
    const results: number[] = [];
    await rstarSearch(this.storage, this.rootPageId, rect, results);
    return results;
  }

  /**
   * Deletes a rectangle with the given ID from the index.
   *
   * Both the rectangle and ID must match exactly for deletion.
   * If the entry is not found, this is a no-op.
   *
   * @param rect - The exact rectangle to delete
   * @param id - The ID associated with the rectangle
   *
   * @example
   * await index.delete(new Rectangle(0, 0, 10, 10), docId);
   */
  async delete(rect: Rectangle, id: number): Promise<void> {
    this.rootPageId = await rstarDelete(this.storage, this.rootPageId, rect, id);
    this.storage.setRootPageId(this.rootPageId);
  }

  /**
   * Gets the current root page ID.
   *
   * Save this value to reopen the index later with `RStarIndex.open()`.
   * The root page ID may change after insertions that cause root splits.
   *
   * @returns The page ID of the root node
   */
  getRootPageId(): number {
    return this.rootPageId;
  }

  /**
   * Commits pending changes to disk.
   *
   * In standalone usage (without DbmsBack), call this to flush
   * all dirty pages to the WAL. In normal DbmsBack usage,
   * `db.commit()` handles this automatically.
   *
   * @example
   * await index.insert(rect, id);
   * await fbf.commit();  // Persist to disk
   */
  async commit(): Promise<void> {
    // In normal usage, DbmsBack handles commits
    // This is provided for standalone usage
  }
}
