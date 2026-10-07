// @author: Alec Van Vlerken
// @date: 2026-05-06

import assert from 'assert';
import { describe, it } from 'vitest';

import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../../../database/dbmsback.mjs';
import { JSONtoDocument } from '../../../database/document.mjs';
import { relocateHnswUnits } from '../../compaction.mjs';

function makeEmbedding(text: string, dimension = 4): Float32Array {
  const vector = new Float32Array(dimension);
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

  it('relocates tombstoned HNSW graph and vector units without resurrecting deleted results', async () => {
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
    const tombstone = graph.find((node) => node.deleted);
    assert(tombstone, 'delete should leave a persistent HNSW tombstone');
    const tombstoneDocId = tombstone.docId;

    const targetsAfterDelete = (await db.listHnswRelocationTargets('articles')).filter(
      (target) => target.kind !== 'hnsw-meta',
    );
    assert.strictEqual(targetsAfterDelete.length, 8);
    assert.strictEqual(targetsAfterDelete.filter((target) => target.hnswUnitState === 'tombstoned-retained').length, 2);

    const graphTarget = targetsAfterDelete.find(
      (target) => target.kind === 'hnsw-graph' && target.nodeId === tombstone.nodeId,
    );
    assert(graphTarget?.nodeId !== undefined);
    assert.strictEqual(graphTarget.hnswUnitState, 'tombstoned-retained');

    const graphMoved = await db.relocateHnswUnit({
      collection: 'articles',
      kind: 'hnsw-graph',
      nodeId: graphTarget.nodeId,
    });
    assert.strictEqual(graphMoved, true);
    const movedGraph = await db.inspectHnswGraphStructure('articles');
    const movedTombstone = movedGraph.find((node) => node.docId === tombstoneDocId);
    assert(movedTombstone?.deleted === true);
    assert.notStrictEqual(movedTombstone.nodeId, tombstone.nodeId);

    const vectorTarget = (await db.listHnswRelocationTargets('articles')).find(
      (target) => target.kind === 'hnsw-vector' && target.nodeId === movedTombstone.nodeId,
    );
    assert(vectorTarget?.nodeId !== undefined);
    assert.strictEqual(vectorTarget.hnswUnitState, 'tombstoned-retained');
    const oldVectorLocation = `${movedTombstone.vectorPageId.toString()}:${movedTombstone.vectorSlotId.toString()}`;

    const vectorMoved = await db.relocateHnswUnit({
      collection: 'articles',
      kind: 'hnsw-vector',
      nodeId: vectorTarget.nodeId,
    });
    assert.strictEqual(vectorMoved, true);
    await db.commit();

    const movedVectorGraph = await db.inspectHnswGraphStructure('articles');
    const movedVectorTombstone = movedVectorGraph.find((node) => node.docId === tombstoneDocId);
    assert(movedVectorTombstone?.deleted === true);
    assert.notStrictEqual(
      `${movedVectorTombstone.vectorPageId.toString()}:${movedVectorTombstone.vectorSlotId.toString()}`,
      oldVectorLocation,
    );

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

  it('incremental compaction can move tombstoned HNSW tail blockers and trim the exposed tail', async () => {
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const dimension = 900;
    const hnswConfig: HnswConfig = {
      dimension,
      embeddingFn: (text) => Promise.resolve(makeEmbedding(text, dimension)),
      M: 4,
      efConstruction: 16,
      efSearch: 8,
    };
    const db = new DbmsBack(data, log, hnswConfig);
    await db.create();

    const fillerPayload = 'free low blocks for tombstone-aware hnsw compaction '.repeat(260);
    for (let i = 0; i < 18; i++) {
      await db.insertDocument(
        JSONtoDocument(
          JSON.stringify({
            id: `filler-${i.toString()}`,
            _payload: fillerPayload,
          }),
          'filler',
        ),
        undefined,
        { skipSemanticIndex: true },
      );
    }
    await db.commit();

    for (const doc of [
      { id: 'h1', body: 'alpha tombstone compaction live target' },
      { id: 'h2', body: 'beta tombstone compaction live target' },
      { id: 'h3', body: 'gamma tombstone compaction live target' },
      { id: 'h-dead-tail', body: 'deleted tombstone compaction tail blocker' },
    ]) {
      await db.insertDocument(JSONtoDocument(JSON.stringify(doc), 'articles'));
    }
    await db.commit();

    await db.deleteDocument('h-dead-tail', 'articles');
    for (let i = 0; i < 18; i++) {
      await db.deleteDocument(`filler-${i.toString()}`, 'filler');
    }
    await db.commit();

    const graphBefore = await db.inspectHnswGraphStructure('articles');
    const tombstoneBefore = graphBefore.find((node) => node.deleted);
    assert(tombstoneBefore, 'expected a tombstoned HNSW node before compaction');
    const beforeStats = await db.getCompactionStorageStats();
    const targetBlockCount = Math.ceil(beforeStats.usedBlocks * 1.02);
    const tombstoneWasTailRelevant =
      Math.floor(tombstoneBefore.nodeId / 4294967296) >= targetBlockCount ||
      tombstoneBefore.vectorPageId >= targetBlockCount;
    assert(tombstoneWasTailRelevant, 'test fixture should put tombstoned HNSW storage above the target boundary');

    const compacted = await db.compactIfNeeded({
      maxAmplification: 1.02,
      softAmplification: 1.02,
      targetBatchDocuments: 4,
      targetBatchUnits: 4,
      maxStepsPerRun: 80,
    });
    await db.commit();

    assert(compacted !== null);
    assert((compacted.relocatedDocuments ?? 0) > 0);
    assert((compacted.relocatedBtreeNodes ?? 0) > 0);
    assert((compacted.relocatedHnswUnits ?? 0) > 0);
    assert((compacted.reclaimedTailBlocks ?? 0) > 0);
    const afterStats = await db.getCompactionStorageStats();
    assert(afterStats.totalBlocks < beforeStats.totalBlocks);

    const graphAfter = await db.inspectHnswGraphStructure('articles');
    const tombstoneAfter = graphAfter.find((node) => node.docId === tombstoneBefore.docId);
    assert(tombstoneAfter?.deleted === true);

    const semanticAfter = (await db.semanticSearch('articles', 'deleted tombstone compaction tail blocker', 3)).map(
      (doc) => String(doc.getId()),
    );
    assert(!semanticAfter.includes('h-dead-tail'));
    assert(semanticAfter.some((id) => ['h1', 'h2', 'h3'].includes(id)));

    await db.close();
    const reopened = await DbmsBack.open(data, log, hnswConfig);
    const reopenedGraph = await reopened.inspectHnswGraphStructure('articles');
    const reopenedTombstone = reopenedGraph.find((node) => node.docId === tombstoneBefore.docId);
    assert(reopenedTombstone?.deleted === true);
    const reopenedResults = (
      await reopened.semanticSearch('articles', 'deleted tombstone compaction tail blocker', 3)
    ).map((doc) => String(doc.getId()));
    assert(!reopenedResults.includes('h-dead-tail'));
    assert(reopenedResults.some((id) => ['h1', 'h2', 'h3'].includes(id)));
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
