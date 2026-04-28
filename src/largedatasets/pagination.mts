/**
 * Pagination module for SimpleDbms.
 *
 * Provides two pagination strategies on top of the existing cursor API:
 *   1. Cursor-based pagination (efficient, recommended for large datasets)
 *   2. Offset/limit pagination (simple, but slower for deep pages)
 *
 * @module largedatasets/pagination
 */

import { SimpleDbms } from '../dbms/simpledbms.mjs';

/** A single page of results. */
export interface Page<T = string> {
  /** The documents in this page (JSON strings). */
  data: T[];
  /** Total number of documents returned so far (useful for offset mode). */
  pageSize: number;
  /** Whether there are more pages after this one. */
  hasMore: boolean;
  /** Cursor token to pass for the next page (cursor mode only). */
  nextCursor?: string | number;
}

/** Options for cursor-based pagination. */
export interface CursorPaginationOptions {
  collection: string;
  iterableKey: string;
  /** How many documents per page. */
  limit: number;
  /** Start from this key value (pass `nextCursor` from the previous page). */
  afterCursor?: string | number;
}

/** Options for offset-based pagination. */
export interface OffsetPaginationOptions {
  collection: string;
  iterableKey: string;
  /** How many documents per page. */
  limit: number;
  /** How many documents to skip. */
  offset: number;
}

/**
 * Fetch a single page of results using cursor-based pagination.
 *
 * This is the preferred method for large datasets because it uses the B+ tree
 * iterator directly — no documents are skipped, so every page is O(limit).
 *
 * @param db      - An open SimpleDbms instance.
 * @param options - Cursor pagination options.
 * @returns A Page object containing the results.
 */
export async function fetchPageCursor(
  db: SimpleDbms,
  options: CursorPaginationOptions,
): Promise<Page> {
  const { collection, iterableKey, limit, afterCursor } = options;

  // Start iterating from afterCursor (or from the beginning if undefined)
  const iterable = db.cursor(collection, iterableKey, afterCursor as string | number | undefined);

  const data: string[] = [];
  let lastKey: string | number | undefined;
  let skipFirst = afterCursor !== undefined;

  for await (const jsonStr of iterable) {
    // When resuming from afterCursor, skip the first element (we already sent it)
    if (skipFirst) {
      skipFirst = false;
      continue;
    }

    data.push(jsonStr);

    // Extract the key value for the next cursor
    const parsed = JSON.parse(jsonStr);
    lastKey = parsed[iterableKey];

    if (data.length >= limit + 1) {
      // We fetched one extra to check if there are more results
      break;
    }
  }

  const hasMore = data.length > limit;
  if (hasMore) {
    data.pop(); // Remove the extra lookahead document
    // Recalculate lastKey from the actual last document
    const lastDoc = JSON.parse(data[data.length - 1]);
    lastKey = lastDoc[iterableKey];
  }

  return {
    data,
    pageSize: data.length,
    hasMore,
    nextCursor: hasMore ? lastKey : undefined,
  };
}

/**
 * Fetch a single page of results using offset/limit pagination.
 *
 * Simpler API but less efficient for deep pages (must skip `offset` docs).
 * Use cursor-based pagination for better performance on large datasets.
 *
 * @param db      - An open SimpleDbms instance.
 * @param options - Offset pagination options.
 * @returns A Page object containing the results.
 */
export async function fetchPageOffset(
  db: SimpleDbms,
  options: OffsetPaginationOptions,
): Promise<Page> {
  const { collection, iterableKey, limit, offset } = options;

  const iterable = db.cursor(collection, iterableKey);

  const data: string[] = [];
  let index = 0;

  for await (const jsonStr of iterable) {
    if (index < offset) {
      index++;
      continue;
    }

    data.push(jsonStr);

    if (data.length > limit) {
      break;
    }

    index++;
  }

  const hasMore = data.length > limit;
  if (hasMore) {
    data.pop();
  }

  return {
    data,
    pageSize: data.length,
    hasMore,
  };
}
