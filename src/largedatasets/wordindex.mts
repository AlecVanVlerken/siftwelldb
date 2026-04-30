/**
 * Persistent word index for SimpleDbms.
 *
 * Stores an inverted index as a collection in the database so it survives
 * restarts. Each document in `_word_index` has:
 *   { id: "<normalised-word>", _docIds: "id1|id2|id3|..." }
 *
 * The `id` field is indexed in the B+ tree (O(log n) lookup by word).
 * The `_docIds` field is prefixed with `_` so it is NOT B+ tree indexed.
 */

import { SimpleDbms } from '../dbms/simpledbms.mjs';
import { type InvertedIndex } from './invertedindex.mjs';

export const WORD_INDEX_COLLECTION = '_word_index';
export const CONTENT_INDEX_COLLECTION = '_content_index';
const SEP = '|';

/**
 * Persist an in-memory InvertedIndex into the database.
 * Should be called once after bulk import finishes.
 */
export async function persistWordIndex(
  db: SimpleDbms,
  index: InvertedIndex,
  batchSize = 500,
  onProgress?: (wordsDone: number) => void,
  collection = WORD_INDEX_COLLECTION,
): Promise<void> {
  let count = 0;
  let skipped = 0;
  for (const word of index.words) {
    const docIds = index.search(word);
    if (docIds.length === 0) continue;
    try {
      await db.insertDocumentObject(collection, { id: word, _docIds: docIds.join(SEP) });
    } catch {
      // Word already exists in index (e.g. from a previous import run) — skip it.
      skipped++;
      continue;
    }
    count++;
    if (count % batchSize === 0) {
      await db.commit();
      onProgress?.(count);
    }
  }
  if (count % batchSize !== 0) {
    await db.commit();
    onProgress?.(count);
  }
  if (skipped > 0) {
    console.warn(`[persistWordIndex] Skipped ${skipped} duplicate words (already in index).`);
  }
}

/**
 * Look up a single word in the persistent content index.
 * Returns a paginated slice of matching document IDs.
 */
export async function searchContentIndex(
  db: SimpleDbms,
  word: string,
  limit: number,
  offset: number,
): Promise<{ docIds: string[]; total: number; hasMore: boolean }> {
  const normalized = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) return { docIds: [], total: 0, hasMore: false };

  let raw: string;
  try {
    raw = await db.getDocumentById(CONTENT_INDEX_COLLECTION, normalized);
  } catch {
    return { docIds: [], total: 0, hasMore: false };
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const docIdsStr = parsed['_docIds'];
  if (typeof docIdsStr !== 'string' || !docIdsStr) return { docIds: [], total: 0, hasMore: false };

  const all = docIdsStr.split(SEP);
  const page = all.slice(offset, offset + limit);
  return { docIds: page, total: all.length, hasMore: offset + limit < all.length };
}

/**
 * Look up a single word in the persistent word index.
 * Returns a paginated slice of matching document IDs.
 */
export async function searchWordIndex(
  db: SimpleDbms,
  word: string,
  limit: number,
  offset: number,
): Promise<{ docIds: string[]; total: number; hasMore: boolean }> {
  const normalized = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) return { docIds: [], total: 0, hasMore: false };

  let raw: string;
  try {
    raw = await db.getDocumentById(WORD_INDEX_COLLECTION, normalized);
  } catch {
    console.log(`[searchWordIndex] word="${normalized}" → not found in index`);
    return { docIds: [], total: 0, hasMore: false };
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const docIdsStr = parsed['_docIds'];
  if (typeof docIdsStr !== 'string' || !docIdsStr) return { docIds: [], total: 0, hasMore: false };

  const all = docIdsStr.split(SEP);
  const page = all.slice(offset, offset + limit);
  return { docIds: page, total: all.length, hasMore: offset + limit < all.length };
}
