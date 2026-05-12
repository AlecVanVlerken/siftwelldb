// @author: Alec Van Vlerken
// @date: 2026-05-06

import assert from 'assert';
import { describe, it } from 'vitest';

import { MockFile } from '../core/mockfile.mjs';
import { DbmsBack } from '../dbms/dbmsback.mjs';
import { JSONtoDocument } from '../dbms/document.mjs';
import { runIncrementalCompactionStep, runIncrementalCompactionUntilTarget } from './compaction.mjs';
import type { RelocationTarget } from './incrementaltypes.mjs';

type FakeSourceOptions = {
  totalBlocks?: number;
  usedBlocks?: number;
  freeTailBlocks?: number;
  records?: RelocationTarget[];
  btrees?: RelocationTarget[];
  hnsw?: RelocationTarget[];
  reclaimedTailBlocks?: number;
};

function makeFakeSource(options: FakeSourceOptions = {}): {
  source: DbmsBack;
  commits: () => number;
  recordRelocations: Array<{ collection: string; id: string | number; maxBlockExclusive?: number }>;
  btreeRelocations: Array<{ collection: string; field: string; blockNumber: number; maxBlockExclusive?: number }>;
  hnswRelocations: RelocationTarget[];
  tailReclaims: () => number;
} {
  let commits = 0;
  let tailReclaims = 0;
  const recordRelocations: Array<{ collection: string; id: string | number; maxBlockExclusive?: number }> = [];
  const btreeRelocations: Array<{ collection: string; field: string; blockNumber: number; maxBlockExclusive?: number }> =
    [];
  const hnswRelocations: RelocationTarget[] = [];
  const blockSize = 4096;
  const totalBlocks = options.totalBlocks ?? 10;
  const usedBlocks = options.usedBlocks ?? 5;
  const freeBlocks = totalBlocks - usedBlocks;

  const source = {
    getCompactionStorageStats: () =>
      Promise.resolve({
        blockSize,
        fileSizeBytes: totalBlocks * blockSize,
        totalBlocks,
        freeBlocks,
        usedBlocks,
        freeTailBlocks: options.freeTailBlocks ?? 0,
      }),
    listRecordRelocationTargets: (limit = 16) => Promise.resolve((options.records ?? []).slice(0, limit)),
    listBtreeRelocationTargets: (limit = 16) => Promise.resolve((options.btrees ?? []).slice(0, limit)),
    listHnswRelocationCandidateTargets: (limit = 16) => Promise.resolve((options.hnsw ?? []).slice(0, limit)),
    relocateDocument: (collection: string, id: string | number, relocateOptions?: { maxBlockExclusive?: number }) => {
      recordRelocations.push({ collection, id, maxBlockExclusive: relocateOptions?.maxBlockExclusive });
      return Promise.resolve({ oldBlockNumber: 8, newBlockNumber: 2, relocated: true });
    },
    relocateBtreeNode: (
      collection: string,
      field: string,
      blockNumber: number,
      relocateOptions?: { maxBlockExclusive?: number },
    ) => {
      btreeRelocations.push({ collection, field, blockNumber, maxBlockExclusive: relocateOptions?.maxBlockExclusive });
      return Promise.resolve(blockNumber - 1);
    },
    relocateHnswUnit: (target: RelocationTarget) => {
      hnswRelocations.push(target);
      return Promise.resolve(true);
    },
    trimFreeTail: () => {
      tailReclaims++;
      return Promise.resolve(options.reclaimedTailBlocks ?? options.freeTailBlocks ?? 0);
    },
    commit: () => {
      commits++;
      return Promise.resolve();
    },
  } as unknown as DbmsBack;

  return {
    source,
    commits: () => commits,
    recordRelocations,
    btreeRelocations,
    hnswRelocations,
    tailReclaims: () => tailReclaims,
  };
}

async function makeDb(): Promise<DbmsBack> {
  const db = new DbmsBack(new MockFile(4096), new MockFile(4096));
  await db.create();
  return db;
}

describe('IncrementalCompactionService', () => {
  it('returns didWork false when policy says compaction is not needed', async () => {
    const fake = makeFakeSource({ totalBlocks: 5, usedBlocks: 5 });

    const result = await runIncrementalCompactionStep(fake.source, { maxAmplification: 10 });

    assert.strictEqual(result.didWork, false);
    assert(result.metricsBefore);
    assert.strictEqual(result.metricsAfter, undefined);
    assert.strictEqual(fake.commits(), 0);
  });

  it('returns didWork false when no batch can be planned', async () => {
    const fake = makeFakeSource();

    const result = await runIncrementalCompactionStep(fake.source, { maxAmplification: 0.5 });

    assert.strictEqual(result.didWork, false);
    assert(result.metricsBefore);
    assert.strictEqual(result.metricsAfter, undefined);
    assert.strictEqual(fake.commits(), 0);
  });

  it('reports blocked convergence when the K metric is still violated but no safe target exists', async () => {
    const fake = makeFakeSource();

    const result = await runIncrementalCompactionUntilTarget(fake.source, { maxAmplification: 0.5 });

    assert.strictEqual(result.didWork, false);
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.reachedTarget, false);
    assert.strictEqual(fake.commits(), 0);
  });

  it('executes one destination-aware record relocation batch', async () => {
    const fake = makeFakeSource({
      records: [{ kind: 'record', collection: 'articles', documentId: 'a1', blockNumber: 8 }],
    });

    const result = await runIncrementalCompactionStep(fake.source, { maxAmplification: 0.5, targetBatchDocuments: 1 });

    assert.strictEqual(result.didWork, true);
    assert.strictEqual(result.relocatedDocuments, 1);
    assert(result.metricsBefore);
    assert(result.metricsAfter);
    assert.deepStrictEqual(fake.recordRelocations, [{ collection: 'articles', id: 'a1', maxBlockExclusive: 3 }]);
  });

  it('dispatches B-tree relocation batches and commits mutating work', async () => {
    const fake = makeFakeSource({
      btrees: [{ kind: 'btree-leaf', collection: 'articles', field: 'tag', blockNumber: 8 }],
    });

    const result = await runIncrementalCompactionStep(fake.source, { maxAmplification: 0.5, targetBatchUnits: 2 });

    assert.strictEqual(result.didWork, true);
    assert.strictEqual(result.relocatedBtreeNodes, 1);
    assert.deepStrictEqual(fake.btreeRelocations, [
      { collection: 'articles', field: 'tag', blockNumber: 8, maxBlockExclusive: 3 },
    ]);
    assert.strictEqual(fake.commits(), 1);
  });

  it('dispatches HNSW relocation batches and commits mutating work', async () => {
    const fake = makeFakeSource({
      hnsw: [{ kind: 'hnsw-graph', collection: 'articles', nodeId: 4, blockNumber: 8 }],
    });

    const result = await runIncrementalCompactionStep(fake.source, { maxAmplification: 0.5, targetBatchUnits: 2 });

    assert.strictEqual(result.didWork, true);
    assert.strictEqual(result.relocatedHnswUnits, 1);
    assert.strictEqual(fake.hnswRelocations.length, 1);
    assert.strictEqual(fake.hnswRelocations[0].kind, 'hnsw-graph');
    assert.strictEqual(fake.commits(), 1);
  });

  it('dispatches tail reclamation batches', async () => {
    const fake = makeFakeSource({
      freeTailBlocks: 2,
      reclaimedTailBlocks: 2,
    });

    const result = await runIncrementalCompactionStep(fake.source, { maxAmplification: 10 });

    assert.strictEqual(result.didWork, true);
    assert.strictEqual(result.reclaimedTailBlocks, 2);
    assert.strictEqual(fake.tailReclaims(), 1);
  });

  it('exposes a backend compactIfNeeded wrapper that returns null for no-op work', async () => {
    const db = await makeDb();

    const result = await db.compactIfNeeded({ maxAmplification: 10 });

    assert.strictEqual(result, null);
  });

  it('compactIfNeeded runs multiple bounded steps toward the K target', async () => {
    const db = await makeDb();
    const payload = 'bounded convergence '.repeat(900);

    for (let i = 0; i < 8; i++) {
      await db.insertDocument(JSONtoDocument(JSON.stringify({ id: `f${i.toString()}`, group: 'f', _payload: payload }), 'items'));
    }
    await db.commit();

    for (let i = 0; i < 8; i++) {
      await db.insertDocument(JSONtoDocument(JSON.stringify({ id: `t${i.toString()}`, group: 't', _payload: payload }), 'items'));
    }
    await db.commit();

    for (let i = 0; i < 8; i++) {
      await db.deleteDocument(`f${i.toString()}`, 'items');
    }
    await db.commit();

    const before = await db.getCompactionStorageStats();
    const result = await db.compactIfNeeded({
      maxAmplification: 1.25,
      softAmplification: 1.25,
      targetBatchDocuments: 2,
      maxStepsPerRun: 4,
    });
    const after = await db.getCompactionStorageStats();

    assert(result);
    assert((result.attemptedSteps ?? 0) > 1);
    assert(after.fileSizeBytes < before.fileSizeBytes);
    assert(after.totalBlocks / after.usedBlocks <= 1.25);
  });
});
