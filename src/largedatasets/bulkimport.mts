/**
 * Bulk Import module for SimpleDbms.
 *
 * Efficiently imports large numbers of documents using batched commits.
 * Instead of committing after every insert, documents are batched and
 * committed together, which is much faster for large datasets.
 *
 * Supports:
 *   - Array-based import (pass an array of objects)
 *   - Streaming import (pass an async iterable, e.g. reading from a file)
 *   - JSON Lines (JSONL) parsing for line-delimited JSON
 *
 * @module largedatasets/bulkimport
 */

import { SimpleDbms } from '../dbms/simpledbms.mjs';

/** Options for bulk import. */
export interface BulkImportOptions {
  /** The collection to import into. */
  collection: string;
  /** Number of documents per commit batch (default: 100). */
  batchSize?: number;
  /** Called after each batch is committed. */
  onBatchComplete?: (info: BatchInfo) => void;
}

/** Information about a completed batch. */
export interface BatchInfo {
  /** Number of documents in this batch. */
  batchCount: number;
  /** Total documents imported so far. */
  totalImported: number;
  /** Batch number (1-based). */
  batchNumber: number;
}

/** Result of a bulk import operation. */
export interface BulkImportResult {
  /** Total number of documents imported. */
  totalImported: number;
  /** Number of batches committed. */
  batchesCommitted: number;
  /** Number of documents that failed to import. */
  failedCount: number;
  /** Error messages for failed documents. */
  errors: string[];
}

/**
 * Bulk import an array of documents into a collection.
 *
 * Documents are inserted in batches and committed periodically to avoid
 * building up too much uncommitted data in memory.
 *
 * @param db      - An open SimpleDbms instance.
 * @param docs    - Array of plain objects (each must have an `id` field).
 * @param options - Import options.
 * @returns A BulkImportResult with stats about the import.
 */
export async function bulkImportArray(
  db: SimpleDbms,
  docs: Record<string, unknown>[],
  options: BulkImportOptions,
): Promise<BulkImportResult> {
  function* generate() {
    for (const doc of docs) {
      yield doc;
    }
  }
  return bulkImportStream(db, generate(), options);
}

/**
 * Bulk import documents from an async iterable (streaming).
 *
 * This is the most memory-efficient way to import large datasets.
 * Documents are consumed one at a time from the stream and committed
 * in batches.
 *
 * @param db      - An open SimpleDbms instance.
 * @param stream  - AsyncIterable yielding plain objects with `id` fields.
 * @param options - Import options.
 * @returns A BulkImportResult with stats about the import.
 */
export async function bulkImportStream(
  db: SimpleDbms,
  stream: AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>,
  options: BulkImportOptions,
): Promise<BulkImportResult> {
  const batchSize = options.batchSize ?? 100;
  const { collection, onBatchComplete } = options;

  let totalImported = 0;
  let batchCount = 0;
  let currentBatch = 0;
  let failedCount = 0;
  const errors: string[] = [];

  for await (const doc of stream) {
    try {
      await db.insertDocumentObject(collection, doc);
      currentBatch++;
      totalImported++;
    } catch (err) {
      failedCount++;
      const msg = err instanceof Error ? err.message : String(err);
      const docId = typeof doc['id'] === 'string' ? doc['id'] : 'unknown';
      errors.push(`Document ${docId}: ${msg}`);
      continue;
    }

    if (currentBatch >= batchSize) {
      await db.commit();
      batchCount++;
      if (onBatchComplete) {
        onBatchComplete({
          batchCount: currentBatch,
          totalImported,
          batchNumber: batchCount,
        });
      }
      currentBatch = 0;
    }
  }

  // Commit any remaining documents
  if (currentBatch > 0) {
    await db.commit();
    batchCount++;
    if (onBatchComplete) {
      onBatchComplete({
        batchCount: currentBatch,
        totalImported,
        batchNumber: batchCount,
      });
    }
  }

  return {
    totalImported,
    batchesCommitted: batchCount,
    failedCount,
    errors,
  };
}

/**
 * Parse JSON Lines (JSONL) text into an array of objects.
 *
 * Each line must be a valid JSON object. Empty lines are skipped.
 * This is useful for importing data exported from other systems.
 *
 * @param jsonlText - The JSONL text to parse.
 * @returns Array of parsed objects.
 */
export function parseJsonLines(jsonlText: string): Record<string, unknown>[] {
  return jsonlText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Create an async generator from JSONL text for streaming import.
 *
 * @param jsonlText - The JSONL text to parse.
 * @yields Parsed objects one at a time.
 */
export function* streamJsonLines(jsonlText: string): Generator<Record<string, unknown>> {
  const lines = jsonlText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    yield JSON.parse(trimmed) as Record<string, unknown>;
  }
}
