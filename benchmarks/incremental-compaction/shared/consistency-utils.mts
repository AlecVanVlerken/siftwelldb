// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';

import type { IncrementalCompactionPolicy } from '../../../src/compaction/compaction.mjs';
import { CollectionCatalog } from '../../../src/compaction/vacuum/collectioncatalog.mjs';
import type { DbmsBack } from '../../../src/database/dbmsback.mjs';
import { documentToJSON, type Document } from '../../../src/database/document.mjs';
import { DEFAULT_K, queryIds } from './benchmark-utils.mjs';

export type SemanticCheck = {
  collection: string;
  query: string;
  k: number;
};

export type CrossStructureSnapshot = {
  collections: string[];
  documentCount: number;
  docsByCollection: Record<string, Record<string, string>>;
  indexedResultIds: Record<string, string[]>;
  cursorResultIds: Record<string, string[]>;
  semanticResultIds: Record<string, string[]>;
  semanticResultDocuments: Record<string, string[]>;
};

export type ConsistencyReport = {
  sameIds: boolean;
  sameDocumentContents: boolean;
  sameIndexedResults: boolean;
  sameCursorResults: boolean;
  sameSemanticResults: boolean;
  semanticResultsReadable: boolean;
  postReopenChecksPassed?: boolean;
};

export const strictConsistencyPolicy: IncrementalCompactionPolicy = {
  maxAmplification: DEFAULT_K,
  softAmplification: DEFAULT_K,
  targetBatchDocuments: 4,
  targetBatchUnits: 4,
  maxStepsPerRun: 30,
};

export async function captureCrossStructureSnapshot(
  db: DbmsBack,
  semanticChecks: SemanticCheck[] = [],
): Promise<CrossStructureSnapshot> {
  const catalog = new CollectionCatalog(db);
  const collections = catalog.listCollections().sort();
  const docsByCollection: Record<string, Record<string, string>> = {};
  const indexedResultIds: Record<string, string[]> = {};
  const cursorResultIds: Record<string, string[]> = {};
  const semanticResultIds: Record<string, string[]> = {};
  const semanticResultDocuments: Record<string, string[]> = {};
  let documentCount = 0;

  for (const collection of collections) {
    docsByCollection[collection] = {};
    if (!catalog.hasIdTree(collection)) continue;

    const docs: Document[] = [];
    for await (const doc of await db.cursor(collection, 'id')) {
      docs.push(doc);
      docsByCollection[collection][String(doc.getId())] = documentToJSON(doc);
      documentCount++;
    }

    for (const field of catalog.getIndexedFields(collection).sort()) {
      const cursorKey = `${collection}:${field}:cursor`;
      cursorResultIds[cursorKey] = [];
      for await (const doc of await db.cursor(collection, field)) {
        cursorResultIds[cursorKey].push(String(doc.getId()));
      }

      if (field === 'id') {
        indexedResultIds[`${collection}:id:*`] = docs.map((doc) => String(doc.getId())).sort();
        for (const doc of docs) {
          indexedResultIds[`${collection}:id:${String(doc.getId())}`] = await queryIds(
            db,
            collection,
            'id',
            doc.getId(),
          );
        }
        continue;
      }

      const values = new Set<string | number>();
      for (const doc of docs) {
        const value = doc.getFields()[field];
        if (typeof value === 'string' || typeof value === 'number') values.add(value);
      }
      for (const value of [...values].sort((a, b) => String(a).localeCompare(String(b)))) {
        indexedResultIds[`${collection}:${field}:${String(value)}`] = await queryIds(db, collection, field, value);
      }
    }
  }

  for (const semantic of semanticChecks) {
    const key = semanticKey(semantic);
    const results = await db.semanticSearch(semantic.collection, semantic.query, semantic.k);
    semanticResultIds[key] = results.map((doc) => String(doc.getId()));
    semanticResultDocuments[key] = results.map((doc) => documentToJSON(doc));
  }

  return {
    collections,
    documentCount,
    docsByCollection,
    indexedResultIds,
    cursorResultIds,
    semanticResultIds,
    semanticResultDocuments,
  };
}

export function compareConsistencySnapshots(
  before: CrossStructureSnapshot,
  after: CrossStructureSnapshot,
): ConsistencyReport {
  return {
    sameIds: sameDocumentIds(before, after),
    sameDocumentContents: JSON.stringify(before.docsByCollection) === JSON.stringify(after.docsByCollection),
    sameIndexedResults: JSON.stringify(before.indexedResultIds) === JSON.stringify(after.indexedResultIds),
    sameCursorResults: JSON.stringify(before.cursorResultIds) === JSON.stringify(after.cursorResultIds),
    sameSemanticResults:
      JSON.stringify(before.semanticResultIds) === JSON.stringify(after.semanticResultIds) &&
      JSON.stringify(before.semanticResultDocuments) === JSON.stringify(after.semanticResultDocuments),
    semanticResultsReadable: semanticResultsReadable(after),
  };
}

export function assertCrossStructureSnapshotsEqual(
  before: CrossStructureSnapshot,
  after: CrossStructureSnapshot,
): ConsistencyReport {
  const report = compareConsistencySnapshots(before, after);

  assertCrossStructureCoreEqual(before, after);
  assert.strictEqual(report.sameSemanticResults, true);
  assert.strictEqual(report.semanticResultsReadable, true);

  return report;
}

export function assertCrossStructureCoreEqual(
  before: CrossStructureSnapshot,
  after: CrossStructureSnapshot,
): ConsistencyReport {
  const report = compareConsistencySnapshots(before, after);

  assert.deepStrictEqual(after.collections, before.collections);
  assert.strictEqual(after.documentCount, before.documentCount);
  assert.strictEqual(report.sameIds, true);
  assert.strictEqual(report.sameDocumentContents, true);
  assert.strictEqual(report.sameIndexedResults, true);
  assert.strictEqual(report.sameCursorResults, true);
  assert.strictEqual(report.semanticResultsReadable, true);

  return report;
}

export function assertSemanticResultsReadable(snapshot: CrossStructureSnapshot): void {
  assert.strictEqual(semanticResultsReadable(snapshot), true);
  for (const ids of Object.values(snapshot.semanticResultIds)) {
    assert(ids.length > 0);
  }
}

export async function runConsistencyCompaction(
  db: DbmsBack,
  policy: IncrementalCompactionPolicy = strictConsistencyPolicy,
): Promise<{
  relocatedDocuments: number;
  relocatedBtreeNodes: number;
  relocatedHnswUnits: number;
  reclaimedTailBlocks: number;
}> {
  const result = await db.compactIfNeeded(policy);
  await db.commit();
  return {
    relocatedDocuments: result?.relocatedDocuments ?? 0,
    relocatedBtreeNodes: result?.relocatedBtreeNodes ?? 0,
    relocatedHnswUnits: result?.relocatedHnswUnits ?? 0,
    reclaimedTailBlocks: result?.reclaimedTailBlocks ?? 0,
  };
}

function sameDocumentIds(before: CrossStructureSnapshot, after: CrossStructureSnapshot): boolean {
  const beforeIds = idsByCollection(before);
  const afterIds = idsByCollection(after);
  return JSON.stringify(beforeIds) === JSON.stringify(afterIds);
}

function idsByCollection(snapshot: CrossStructureSnapshot): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(snapshot.docsByCollection).map(([collection, docs]) => [collection, Object.keys(docs).sort()]),
  );
}

function semanticResultsReadable(snapshot: CrossStructureSnapshot): boolean {
  const documents = new Map<string, string>();
  for (const [collection, docs] of Object.entries(snapshot.docsByCollection)) {
    for (const [id, serialised] of Object.entries(docs)) {
      documents.set(`${collection}:${id}`, serialised);
    }
  }

  for (const [key, ids] of Object.entries(snapshot.semanticResultIds)) {
    const collection = key.split(':', 1)[0];
    const serialised = snapshot.semanticResultDocuments[key] ?? [];
    if (ids.length !== serialised.length) return false;
    for (let i = 0; i < ids.length; i++) {
      if (documents.get(`${collection}:${ids[i]}`) !== serialised[i]) return false;
    }
  }

  return true;
}

function semanticKey(check: SemanticCheck): string {
  return `${check.collection}:${check.query}:${check.k.toString()}`;
}
