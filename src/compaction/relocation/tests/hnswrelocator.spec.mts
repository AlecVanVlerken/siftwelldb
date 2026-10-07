// @author: Alec Van Vlerken
// @date: 2026-05-06

import assert from 'assert';
import { describe, it } from 'vitest';

import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../../../database/dbmsback.mjs';
import { JSONtoDocument } from '../../../database/document.mjs';
import { relocateHnswUnits } from '../../compaction.mjs';

function makeEmbedding(text: string): Float32Array {
  const vector = new Float32Array(4);
  for (let i = 0; i < text.length; i++) {
    vector[i % vector.length] += text.charCodeAt(i);
  }
  return vector;
}

async function makeDbmsBack(): Promise<{ db: DbmsBack; data: MockFile; log: MockFile; hnswConfig: HnswConfig }> {
  const data = new MockFile(4096);
  const log = new MockFile(4096);
  const hnswConfig: HnswConfig = {
    dimension: 4,
    embeddingFn: (text) => Promise.resolve(makeEmbedding(text)),
    M: 4,
    efConstruction: 16,
    efSearch: 8,
  };
  const db = new DbmsBack(data, log, hnswConfig);
  await db.create();
  return { db, data, log, hnswConfig };
}

describe('HnswRelocator', () => {
  it('relocates explicit graph and vector units while preserving semantic search after reopen', async () => {
    const { db, data, log, hnswConfig } = await makeDbmsBack();

    for (const doc of [
      { id: 'h1', body: 'alpha relocation target' },
      { id: 'h2', body: 'beta relocation target' },
      { id: 'h3', body: 'gamma relocation target' },
    ]) {
      await db.insertDocument(JSONtoDocument(JSON.stringify(doc), 'articles'));
    }
    await db.commit();

    const before = await db.semanticSearch('articles', 'alpha relocation target', 1);
    assert.strictEqual(before.length, 1);

    const targets = await db.listHnswRelocationTargets('articles');
    const graphTarget = targets.find((target) => target.kind === 'hnsw-graph');
    assert(graphTarget?.nodeId !== undefined);
    const vectorTarget = targets.find(
      (target) => target.kind === 'hnsw-vector' && target.nodeId !== graphTarget.nodeId,
    );
    assert(vectorTarget?.nodeId !== undefined);

    const result = await relocateHnswUnits(db, [graphTarget, vectorTarget]);
    await db.commit();

    assert.strictEqual(result.relocatedHnswUnits, 2);
    const after = await db.semanticSearch('articles', 'alpha relocation target', 1);
    assert.strictEqual(after.length, 1);

    const refreshedTargets = await db.listHnswRelocationTargets('articles');
    assert(!refreshedTargets.some((target) => target.kind === 'hnsw-graph' && target.nodeId === graphTarget.nodeId));

    await db.close();
    const reopened = await DbmsBack.open(data, log, hnswConfig);
    const reopenedResults = await reopened.semanticSearch('articles', 'alpha relocation target', 3);
    assert(reopenedResults.length > 0);
    assert(reopenedResults.some((doc) => ['h1', 'h2', 'h3'].includes(String(doc.getId()))));
    await reopened.close();
  });

  it('refreshes stale same-node vector targets after graph relocation inside one batch', async () => {
    const { db } = await makeDbmsBack();

    for (const doc of [
      { id: 'h1', body: 'alpha same node target' },
      { id: 'h2', body: 'beta same node target' },
      { id: 'h3', body: 'gamma same node target' },
    ]) {
      await db.insertDocument(JSONtoDocument(JSON.stringify(doc), 'articles'));
    }
    await db.commit();

    const targets = await db.listHnswRelocationTargets('articles');
    const graphTarget = targets.find((target) => target.kind === 'hnsw-graph');
    assert(graphTarget?.nodeId !== undefined);
    const vectorTarget = targets.find(
      (target) => target.kind === 'hnsw-vector' && target.nodeId === graphTarget.nodeId,
    );
    assert(vectorTarget?.nodeId !== undefined);

    const result = await relocateHnswUnits(db, [graphTarget, vectorTarget]);
    await db.commit();

    assert.strictEqual(result.relocatedHnswUnits, 2);
    const after = await db.semanticSearch('articles', 'alpha same node target', 3);
    assert(after.some((doc) => ['h1', 'h2', 'h3'].includes(String(doc.getId()))));

    await db.close();
  });

  it('deletes HNSW documents without tombstones and keeps remaining live units relocatable', async () => {
    const { db, data, log, hnswConfig } = await makeDbmsBack();

    for (const doc of [
      { id: 'h1', body: 'alpha delete target' },
      { id: 'h2', body: 'beta delete target' },
      { id: 'h3', body: 'gamma delete target' },
      { id: 'h4', body: 'delta delete target' },
    ]) {
      await db.insertDocument(JSONtoDocument(JSON.stringify(doc), 'articles'));
    }
    await db.commit();

    const targetsBeforeDelete = (await db.listHnswRelocationTargets('articles')).filter(
      (target) => target.kind !== 'hnsw-meta',
    );
    assert.strictEqual(targetsBeforeDelete.length, 8);

    await db.deleteDocument('h1', 'articles');
    await db.commit();

    const semanticBefore = (await db.semanticSearch('articles', 'beta delete target', 3)).map((doc) =>
      String(doc.getId()),
    );
    assert(!semanticBefore.includes('h1'));

    const graph = await db.inspectHnswGraphStructure('articles');
    assert(!graph.some((node) => node.deleted), 'delete should rebuild without persistent HNSW tombstones');

    const targetsAfterDelete = (await db.listHnswRelocationTargets('articles')).filter(
      (target) => target.kind !== 'hnsw-meta',
    );
    assert.strictEqual(targetsAfterDelete.length, 6);

    const graphTarget = targetsAfterDelete.find((target) => target.kind === 'hnsw-graph');
    assert(graphTarget?.nodeId !== undefined);

    const graphMoved = await db.relocateHnswUnit({
      collection: 'articles',
      kind: 'hnsw-graph',
      nodeId: graphTarget.nodeId,
    });
    assert.strictEqual(graphMoved, true);
    const movedGraph = await db.inspectHnswGraphStructure('articles');
    assert(!movedGraph.some((node) => node.deleted));

    const vectorTarget = (await db.listHnswRelocationTargets('articles')).find(
      (target) => target.kind === 'hnsw-vector',
    );
    assert(vectorTarget?.nodeId !== undefined);

    const vectorMoved = await db.relocateHnswUnit({
      collection: 'articles',
      kind: 'hnsw-vector',
      nodeId: vectorTarget.nodeId,
    });
    assert.strictEqual(vectorMoved, true);
    await db.commit();

    const semanticAfter = (await db.semanticSearch('articles', 'beta delete target', 3)).map((doc) =>
      String(doc.getId()),
    );
    assert.deepStrictEqual(semanticAfter, semanticBefore);

    await db.close();
    const reopened = await DbmsBack.open(data, log, hnswConfig);
    const reopenedResults = (await reopened.semanticSearch('articles', 'beta delete target', 3)).map((doc) =>
      String(doc.getId()),
    );
    assert.deepStrictEqual(reopenedResults, semanticBefore);
    await reopened.close();
  });

  it('relocates HNSW metadata blocks so metadata does not pin the file tail', async () => {
    const { db, data, log, hnswConfig } = await makeDbmsBack();

    const fillerPayload = 'free low blocks for hnsw metadata relocation '.repeat(220);
    for (let i = 0; i < 8; i++) {
      await db.insertDocument(
        JSONtoDocument(
          JSON.stringify({
            id: `filler-${i.toString()}`,
            _payload: fillerPayload,
          }),
          'filler',
        ),
      );
    }
    await db.commit();

    for (const doc of [
      { id: 'h1', body: 'alpha metadata relocation target' },
      { id: 'h2', body: 'beta metadata relocation target' },
    ]) {
      await db.insertDocument(JSONtoDocument(JSON.stringify(doc), 'articles'));
    }
    await db.commit();

    for (let i = 0; i < 8; i++) {
      await db.deleteDocument(`filler-${i.toString()}`, 'filler');
    }
    await db.commit();

    const before = (await db.semanticSearch('articles', 'alpha metadata relocation target', 2)).map((doc) =>
      String(doc.getId()),
    );
    const oldMetaBlock = db.getVacuumHnswMetaSnapshot()['articles'][0];

    const moved = await db.relocateHnswUnit({
      collection: 'articles',
      kind: 'hnsw-meta',
      blockNumber: oldMetaBlock,
      maxBlockExclusive: oldMetaBlock,
    });
    await db.commit();

    const newMetaBlock = db.getVacuumHnswMetaSnapshot()['articles'][0];
    assert.strictEqual(moved, true);
    assert(newMetaBlock < oldMetaBlock);
    assert.deepStrictEqual(
      (await db.semanticSearch('articles', 'alpha metadata relocation target', 2)).map((doc) => String(doc.getId())),
      before,
    );

    await db.close();
    const reopened = await DbmsBack.open(data, log, hnswConfig);
    assert.deepStrictEqual(
      (await reopened.semanticSearch('articles', 'alpha metadata relocation target', 2)).map((doc) =>
        String(doc.getId()),
      ),
      before,
    );
    await reopened.close();
  });
});
