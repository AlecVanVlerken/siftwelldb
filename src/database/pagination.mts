/**
 * Pagination module for SimpleDbms.
 *
 * Provides two pagination strategies on top of the existing cursor API:
 *   1. Cursor-based pagination (efficient, recommended for large datasets)
 *   2. Offset/limit pagination (simple, but slower for deep pages)
 *
 * @module largedatasets/pagination
 */

import { SimpleDbms } from './simpledbms.mjs';
import { InvalidCursorError, type IndexCursorPosition } from './dbmsback.mjs';

/** A single page of results. */
export interface Page<T = string> {
  /** The documents in this page (JSON strings). */
  data: T[];
  /** Number of documents in this page. */
  pageSize: number;
  /** Whether there are more pages after this one. */
  hasMore: boolean;
  /** Cursor token to pass for the next page (cursor mode only). */
  nextCursor?: string;
}

/** Options for cursor-based pagination. */
export interface CursorPaginationOptions {
  collection: string;
  iterableKey: string;
  /** How many documents per page. */
  limit: number;
  /** Opaque token from `nextCursor`. Legacy bare key values are unsupported. */
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
 * iterator directly: seeking costs O(log N), followed by the page plus one
 * lookahead document. Tokens do not provide snapshot isolation.
 *
 * @param db      - An open SimpleDbms instance.
 * @param options - Cursor pagination options.
 * @returns A Page object containing the results.
 */
export async function fetchPageCursor(db: SimpleDbms, options: CursorPaginationOptions): Promise<Page> {
  const { collection, iterableKey, limit, afterCursor } = options;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new InvalidCursorError('limit must be a positive integer');
  const after = afterCursor === undefined ? undefined : decodeCursor(afterCursor, collection, iterableKey);
  const iterable = db.cursorWithPosition(collection, iterableKey, after);
  const data: string[] = [];
  let lastPosition: IndexCursorPosition | undefined;
  let hasMore = false;
  for await (const { document, position } of iterable) {
    if (data.length === limit) {
      hasMore = true;
      break;
    }
    data.push(document);
    lastPosition = position;
  }

  return {
    data,
    pageSize: data.length,
    hasMore,
    nextCursor: hasMore && lastPosition ? encodeCursor(collection, iterableKey, lastPosition) : undefined,
  };
}

function encodeCursor(collection: string, field: string, position: IndexCursorPosition): string {
  return Buffer.from(
    JSON.stringify({ v: 1, collection, field, form: position.form, key: position.key.toString('base64url') }),
  ).toString('base64url');
}

function decodeCursor(token: string | number, collection: string, field: string): IndexCursorPosition {
  try {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const encoded = Buffer.from(token, 'base64url');
    if (encoded.toString('base64url') !== token) throw new Error();
    const json = encoded.toString('utf8');
    if (!Buffer.from(json).equals(encoded)) throw new Error();
    const value = JSON.parse(json) as Record<string, unknown>;
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 5 ||
      value['v'] !== 1 ||
      value['collection'] !== collection ||
      value['field'] !== field ||
      typeof value['form'] !== 'string' ||
      typeof value['key'] !== 'string' ||
      !/^[A-Za-z0-9_-]*$/.test(value['key'])
    ) {
      throw new Error();
    }
    const key = Buffer.from(value['key'], 'base64url');
    if (key.toString('base64url') !== value['key']) throw new Error();
    return { form: value['form'], key };
  } catch {
    throw new InvalidCursorError('expected a version 1 token for this collection and index');
  }
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
export async function fetchPageOffset(db: SimpleDbms, options: OffsetPaginationOptions): Promise<Page> {
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
