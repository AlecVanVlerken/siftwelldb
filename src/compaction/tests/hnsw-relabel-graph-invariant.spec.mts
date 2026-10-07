// @author: Alec Van Vlerken
// @date: 2026-05-08

import assert from 'assert';
import { describe, it } from 'vitest';

import type { DbmsBack } from '../../database/dbmsback.mjs';
import type { HnswGraphStructureSnapshot } from '../../indexes/hnsw/hnswIndex.mjs';
import {
  buildSemanticEquivalenceDataset,
  makeSemanticEquivalenceDb,
} from '../../../tests/helpers/semantic-equivalence.mjs';

describe('HNSW relabel graph invariants', () => {
  it('relabels a relocated record without changing HNSW graph topology', async () => {
    const database = await makeSemanticEquivalenceDb();
    const { db } = database;

    await buildSemanticEquivalenceDataset(db, { fragmentation: true });

    const before = await db.inspectHnswGraphStructureSnapshot('articles');
    assert(before.nodes.length > 1);

    const relocation = await relocateOneArticleRecord(db);
    assert.strictEqual(relocation.relocated, true);
    assert.notStrictEqual(relocation.oldBlockNumber, relocation.newBlockNumber);

    const after = await db.inspectHnswGraphStructureSnapshot('articles');
    assert.deepStrictEqual(normalizeDocId(after, relocation.newBlockNumber, relocation.oldBlockNumber), before);

    await db.close();
  });
});

async function relocateOneArticleRecord(
  db: DbmsBack,
): Promise<{ oldBlockNumber: number; newBlockNumber: number; relocated: boolean }> {
  const targets = (await db.listRecordRelocationTargets(64)).filter(
    (target) => target.kind === 'record' && target.collection === 'articles' && target.documentId !== undefined,
  );

  for (const target of targets) {
    const maxBlockExclusive = target.blockNumber;
    const documentId = target.documentId;
    if (maxBlockExclusive === undefined || documentId === undefined) continue;
    const result = await db.relocateDocument('articles', documentId, { maxBlockExclusive });
    if (result.relocated) return result;
  }

  throw new Error('Expected at least one article record to relocate for HNSW relabel invariant test.');
}

function normalizeDocId(
  snapshot: HnswGraphStructureSnapshot,
  fromDocId: number,
  toDocId: number,
): HnswGraphStructureSnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => ({
      ...node,
      docId: node.docId === fromDocId ? toDocId : node.docId,
    })),
  };
}
