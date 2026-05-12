// @author: Alec Van Vlerken
// @date: 2026-05-08

import assert from 'assert';
import { describe, it } from 'vitest';

import { MockFile } from '../core/mockfile.mjs';
import { DbmsBack } from '../dbms/dbmsback.mjs';
import { documentToJSON, JSONtoDocument } from '../dbms/document.mjs';
import {
  assertSemanticEquivalence,
  buildSemanticEquivalenceDataset,
  captureSemanticEquivalenceSnapshot,
  makeSemanticEquivalenceDb,
} from './hnsw-semantic-equivalence-utils.mjs';

describe('repeated relocation invariants', () => {
  it('keeps a repeatedly relocated HNSW-backed record reachable through semantic search', async () => {
    const database = await makeSemanticEquivalenceDb();
    const { db } = database;

    await buildSemanticEquivalenceDataset(db, { fragmentation: true });
    const before = await captureSemanticEquivalenceSnapshot(db);
    const target = await firstRecordTarget(db, 'articles');

    let relocatedCount = 0;
    for (let i = 0; i < 4; i++) {
      const result = await db.relocateDocument('articles', target, {});
      if (result.relocated) relocatedCount++;
      const after = await captureSemanticEquivalenceSnapshot(db);
      assertSemanticEquivalence(before, after);
    }

    assert(relocatedCount >= 2);
    await db.close();
  });

  it('keeps indexed queries correct after repeated B-tree node relocation', async () => {
    const db = await makePlainDb();
    await buildIndexedDataset(db);
    const expected = await indexedSnapshot(db);

    const targets = await db.listBtreeRelocationTargets(32);
    const target = targets.find((candidate) => candidate.collection === 'items' && candidate.field === 'group');
    if (target?.blockNumber === undefined) {
      throw new Error('Expected a B-tree relocation target for items.group');
    }
    let blockNumber = target.blockNumber;

    for (let i = 0; i < 4; i++) {
      const newBlockNumber = await db.relocateBtreeNode('items', 'group', blockNumber, {});
      const actual = await indexedSnapshot(db);
      assert.deepStrictEqual(actual, expected);
      blockNumber = newBlockNumber;
    }

    await db.close();
  });

  it('keeps exact semantic results after repeated HNSW vector relocation', async () => {
    const database = await makeSemanticEquivalenceDb();
    const { db } = database;

    await buildSemanticEquivalenceDataset(db, { fragmentation: true });
    const before = await captureSemanticEquivalenceSnapshot(db);
    const originalTarget = (await db.listHnswRelocationCandidateTargets(64)).find(
      (target) => target.collection === 'articles' && target.kind === 'hnsw-vector' && target.nodeId !== undefined,
    );
    assert(originalTarget?.nodeId !== undefined);

    for (let i = 0; i < 4; i++) {
      const currentTarget = (await db.listHnswRelocationCandidateTargets(64)).find(
        (target) =>
          target.collection === 'articles' && target.kind === 'hnsw-vector' && target.nodeId === originalTarget.nodeId,
      );
      if (currentTarget === undefined) {
        throw new Error('Expected repeated HNSW vector relocation target to remain discoverable.');
      }
      if (currentTarget.nodeId === undefined) {
        throw new Error('Expected HNSW vector relocation target to include nodeId.');
      }
      const moved = await db.relocateHnswUnit({
        collection: 'articles',
        kind: 'hnsw-vector',
        nodeId: currentTarget.nodeId,
        blockNumber: currentTarget.blockNumber,
      });
      assert.strictEqual(moved, true);
      const after = await captureSemanticEquivalenceSnapshot(db);
      assertSemanticEquivalence(before, after);
    }

    await db.close();
  });
});

async function makePlainDb(): Promise<DbmsBack> {
  const db = new DbmsBack(new MockFile(4096), new MockFile(4096));
  await db.create();
  return db;
}

async function buildIndexedDataset(db: DbmsBack): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await db.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: `item${i.toString().padStart(3, '0')}`,
          group: `g${(i % 5).toString()}`,
          rank: i,
          _payload: `indexed ${i.toString()} `.repeat(40),
        }),
        'items',
      ),
    );
  }
  await db.commit();
}

async function indexedSnapshot(db: DbmsBack): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const group of ['g0', 'g1', 'g2', 'g3', 'g4']) {
    result[`group:${group}`] = [];
    for await (const doc of await db.cursor('items', 'group', group)) {
      result[`group:${group}`].push(documentToJSON(doc));
    }
  }
  result['group:cursor'] = [];
  for await (const doc of await db.cursor('items', 'group')) {
    result['group:cursor'].push(String(doc.getId()));
  }
  return result;
}

async function firstRecordTarget(db: DbmsBack, collection: string): Promise<string | number> {
  const target = (await db.listRecordRelocationTargets(64)).find(
    (candidate) => candidate.collection === collection && candidate.documentId !== undefined,
  );
  if (target?.documentId === undefined) {
    throw new Error(`No record relocation target found for ${collection}`);
  }
  return target.documentId;
}
