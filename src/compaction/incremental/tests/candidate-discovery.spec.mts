import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { DbmsBack } from '../../../database/dbmsback.mjs';
import { JSONtoDocument, type Document } from '../../../database/document.mjs';
import { RecordStore } from '../../../storage/records/recordstore.mjs';
import { BlockNodeStorage } from '../../../indexes/btree/nodestorage.mjs';
import { HNSWIndex } from '../../../indexes/hnsw/hnswIndex.mjs';
import { HnswRelocator } from '../../relocation/hnswrelocator.mjs';
import { IncrementalCompactionService } from '../incrementalservice.mjs';

const databases: DbmsBack[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function makeDb(semantic = false): Promise<DbmsBack> {
  const db = new DbmsBack(
    new MockFile(4096),
    new MockFile(4096),
    semantic ? { dimension: 4, embeddingFn: () => Promise.resolve(new Float32Array([1, 2, 3, 4])) } : undefined,
  );
  databases.push(db);
  await db.create();
  for (let id = 0; id < 30; id++) {
    await db.insertDocument(JSONtoDocument(JSON.stringify({ id, group: 'same', text: `document ${id}` }), 'items'));
  }
  await db.commit();
  return db;
}

describe('Incremental compaction candidate discovery', () => {
  it('verifies record inventory once and reuses physical-tail ordering for small batches', async () => {
    const db = await makeDb();
    const reads = vi.spyOn(RecordStore.prototype, 'readRecord');
    const chains = vi.spyOn(RecordStore.prototype, 'readRecordBlockChain');
    const all = await db.listRecordRelocationTargets(100);
    expect(reads).toHaveBeenCalledTimes(30);
    expect(chains).toHaveBeenCalledTimes(30);
    for (const limit of [1, 5, 10, 1]) {
      expect(await db.listRecordRelocationTargets(limit)).toEqual(all.slice(0, limit));
    }
    expect(reads).toHaveBeenCalledTimes(30);
    expect(chains).toHaveBeenCalledTimes(30);
  });

  it('reuses B+ tree and retained HNSW inventories without rescanning', async () => {
    const db = await makeDb(true);
    await db.deleteDocument(29, 'items');
    await db.commit();
    const nodes = vi.spyOn(BlockNodeStorage.prototype, 'listNodeBlocks');
    const graph = vi.spyOn(HNSWIndex.prototype, 'listRelocationTargets');
    const btrees = await db.listBtreeRelocationTargets(1000);
    const hnsw = await db.listHnswRelocationCandidateTargets(1000);
    const initialNodeCalls = nodes.mock.calls.length;
    expect(initialNodeCalls).toBeGreaterThan(0);
    expect(graph).toHaveBeenCalledTimes(1);
    expect(hnsw.some((target) => target.hnswUnitState === 'tombstoned-retained')).toBe(true);
    for (const limit of [1, 5, 10, 1]) {
      expect(await db.listBtreeRelocationTargets(limit)).toEqual(btrees.slice(0, limit));
      expect(await db.listHnswRelocationCandidateTargets(limit)).toEqual(hnsw.slice(0, limit));
    }
    expect(nodes).toHaveBeenCalledTimes(initialNodeCalls);
    expect(graph).toHaveBeenCalledTimes(1);
  });

  it('does no inventory work for zero and negative limits', async () => {
    const db = await makeDb(true);
    const records = vi.spyOn(RecordStore.prototype, 'readRecord');
    const trees = vi.spyOn(BlockNodeStorage.prototype, 'listNodeBlocks');
    const graphs = vi.spyOn(HNSWIndex.prototype, 'listRelocationTargets');
    for (const limit of [0, -1, NaN]) {
      expect(await db.listRecordRelocationTargets(limit)).toEqual([]);
      expect(await db.listBtreeRelocationTargets(limit)).toEqual([]);
      expect(await db.listHnswRelocationCandidateTargets(limit)).toEqual([]);
    }
    expect(records).not.toHaveBeenCalled();
    expect(trees).not.toHaveBeenCalled();
    expect(graphs).not.toHaveBeenCalled();
  });

  it('releases an inventory built by queued discovery while closing', async () => {
    const db = await makeDb();
    const discovery = db.listRecordRelocationTargets(1);
    const closing = db.close();
    expect(await discovery).toHaveLength(1);
    await closing;
    await expect(db.listRecordRelocationTargets(1)).rejects.toThrow(/Cannot read record/);
  });

  it('keeps inventory private and preserves it through commit and tail trimming', async () => {
    const db = await makeDb();
    const reads = vi.spyOn(RecordStore.prototype, 'readRecord');
    const first = (await db.listRecordRelocationTargets(1))[0];
    const original = { ...first };
    first.documentId = 'wrong';
    first.blockNumber = 0;
    await db.commit();
    await db.trimFreeTail();
    expect(await db.listRecordRelocationTargets(1)).toEqual([original]);
    expect(reads).toHaveBeenCalledTimes(30);
  });

  it('refreshes one moved record chain without reexamining the other documents', async () => {
    const db = await makeDb();
    const all = await db.listRecordRelocationTargets(100);
    const reads = vi.spyOn(RecordStore.prototype, 'readRecord');
    const chains = vi.spyOn(RecordStore.prototype, 'readRecordBlockChain');
    const target = all[0];
    const moved = await db.relocateDocument(target.collection!, target.documentId!);
    expect(moved.relocated).toBe(true);
    const refreshed = await db.listRecordRelocationTargets(100);
    expect(refreshed[0]).toMatchObject({ documentId: target.documentId, blockNumber: moved.newBlockNumber });
    expect(refreshed.filter((candidate) => candidate.documentId !== target.documentId)).toEqual(all.slice(1));
    // Relocation validates one record, deletes its old chain and inventories its new chain.
    expect(reads).toHaveBeenCalledTimes(1);
    expect(chains).toHaveBeenCalledTimes(2);
  });

  it('refreshes relocated B+ tree nodes without rebuilding any tree inventory', async () => {
    const db = await makeDb();
    const all = await db.listBtreeRelocationTargets(100);
    const inventories = vi.spyOn(BlockNodeStorage.prototype, 'listNodeBlocks');
    const target = all[0];
    const moved = await db.relocateBtreeNode(target.collection!, target.field!, target.blockNumber!);
    const refreshed = await db.listBtreeRelocationTargets(100);
    expect(refreshed).toHaveLength(all.length);
    expect(refreshed.some((candidate) => candidate.blockNumber === target.blockNumber)).toBe(false);
    expect(refreshed.find((candidate) => candidate.blockNumber === moved)).toMatchObject({ field: target.field });
    expect(inventories).not.toHaveBeenCalled();
    expect(((await db.getDocument(29, 'items')) as Document).getId()).toBe(29);
  });

  it('refreshes graph, vector and metadata locations while retaining tombstone state and native memory', async () => {
    const db = await makeDb(true);
    await db.deleteDocument(29, 'items');
    const all = await db.listHnswRelocationCandidateTargets(1000);
    const scans = vi.spyOn(HNSWIndex.prototype, 'listRelocationTargets');
    const opens = vi.spyOn(HNSWIndex, 'open');
    const graph = all.find((target) => target.kind === 'hnsw-graph' && target.hnswUnitState === 'tombstoned-retained')!;
    await db.relocateHnswUnit({ ...graph, collection: graph.collection!, kind: 'hnsw-graph' });
    let refreshed = await db.listHnswRelocationCandidateTargets(1000);
    const oldVector = all.find((target) => target.kind === 'hnsw-vector' && target.nodeId === graph.nodeId)!;
    const vector = refreshed.find(
      (target) =>
        target.kind === 'hnsw-vector' &&
        target.blockNumber === oldVector.blockNumber &&
        target.hnswUnitState === 'tombstoned-retained',
    )!;
    expect(vector.nodeId).not.toBe(graph.nodeId);
    expect(refreshed.some((target) => target.nodeId === graph.nodeId)).toBe(false);
    await db.relocateHnswUnit({ ...vector, collection: vector.collection!, kind: 'hnsw-vector' });
    const meta = refreshed.find((target) => target.kind === 'hnsw-meta')!;
    await db.relocateHnswUnit({ ...meta, collection: meta.collection!, kind: 'hnsw-meta' });
    refreshed = await db.listHnswRelocationCandidateTargets(1000);
    expect(refreshed).toHaveLength(all.length);
    expect(refreshed.filter((target) => target.hnswUnitState === 'tombstoned-retained')).toHaveLength(2);
    expect(scans).not.toHaveBeenCalled();
    expect(opens).not.toHaveBeenCalled();
    expect((await db.semanticSearch('items', 'document', 30)).map((doc) => doc.getId())).not.toContain(29);
  });

  it('resolves vector targets after a preceding graph relocation changes their planned node identity', async () => {
    const db = await makeDb(true);
    const first = (await db.listHnswRelocationCandidateTargets(1000)).find((target) => target.kind === 'hnsw-graph')!;
    await db.relocateHnswUnit({ ...first, collection: first.collection!, kind: 'hnsw-graph' });
    const all = await db.listHnswRelocationCandidateTargets(1000);
    const graph = all.find((target) => target.kind === 'hnsw-graph' && target.blockNumber !== first.blockNumber)!;
    const vector = all.find((target) => target.kind === 'hnsw-vector' && target.nodeId === graph.nodeId)!;
    expect(graph.blockNumber!).toBeGreaterThan(vector.blockNumber!);
    const scans = vi.spyOn(HNSWIndex.prototype, 'listRelocationTargets');
    const result = await new HnswRelocator(db).relocate([
      { ...graph, collection: 'items', kind: 'hnsw-graph' },
      { ...vector, collection: 'items', kind: 'hnsw-vector' },
    ]);
    expect(result.relocatedHnswUnits).toBe(2);
    expect(scans).not.toHaveBeenCalled();
  });

  it('invalidates inventories after ordinary writes and index toggles', async () => {
    const db = await makeDb(true);
    await db.listRecordRelocationTargets(100);
    await db.listBtreeRelocationTargets(100);
    await db.listHnswRelocationCandidateTargets(1000);
    const reads = vi.spyOn(RecordStore.prototype, 'readRecord');
    await db.insertDocument(JSONtoDocument(JSON.stringify({ id: 30, group: 'new', text: 'new document' }), 'items'));
    expect(await db.listRecordRelocationTargets(100)).toHaveLength(31);
    expect(reads).toHaveBeenCalledTimes(31);
    expect(await db.listHnswRelocationCandidateTargets(1000)).toHaveLength(63);
    await db.setFieldIndexed('items', 'group', false);
    expect((await db.listBtreeRelocationTargets(100)).some((target) => target.field === 'group')).toBe(false);
    await db.setFieldIndexed('items', 'group', true);
    expect((await db.listBtreeRelocationTargets(100)).some((target) => target.field === 'group')).toBe(true);
    await db.deleteDocument(30, 'items');
    expect(await db.listRecordRelocationTargets(100)).toHaveLength(30);
    expect(
      (await db.listHnswRelocationCandidateTargets(1000)).filter(
        (target) => target.hnswUnitState === 'tombstoned-retained',
      ),
    ).toHaveLength(2);
  });

  it('discards a failed inventory so a healthy transient read failure can retry', async () => {
    const db = await makeDb();
    const reads = vi
      .spyOn(RecordStore.prototype, 'readRecord')
      .mockRejectedValueOnce(new Error('temporary read failure'));
    await expect(db.listRecordRelocationTargets(1)).rejects.toThrow('temporary read failure');
    expect(db.isHealthy).toBe(true);
    expect(await db.listRecordRelocationTargets(1)).toHaveLength(1);
    expect(reads).toHaveBeenCalledTimes(31);
  });

  it('does not recollect unchanged free-block metrics during planning', async () => {
    const db = await makeDb();
    await db.deleteDocument(1, 'items');
    await db.commit();
    const collect = vi.spyOn(db, 'getCompactionStorageStats');
    await new IncrementalCompactionService(db, { maxAmplification: 1, targetBatchDocuments: 1 }).runStep();
    expect(collect.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('commits and reclaims a multi-block tail even when the relocated record head moves upward', async () => {
    const db = new DbmsBack(new MockFile(4096), new MockFile(4096));
    databases.push(db);
    await db.create();
    await db.setFieldIndexed('items', 'payload', false);
    await db.insertDocument(JSONtoDocument(JSON.stringify({ id: 'front', payload: 'x' }), 'items'));
    for (let id = 0; id < 12; id++) {
      await db.insertDocument(JSONtoDocument(JSON.stringify({ id: `f${id}`, payload: 'x' }), 'items'));
    }
    await db.deleteDocument('front', 'items');
    const payload = 'tail record '.repeat(1500);
    await db.insertDocument(JSONtoDocument(JSON.stringify({ id: 'multi', payload }), 'items'));
    for (let id = 0; id < 12; id++) await db.deleteDocument(`f${id}`, 'items');
    await db.commit();
    const store = (db as unknown as { recordStore: RecordStore }).recordStore;
    const oldHead = (await db.getDocumentBlockId('items', 'multi'))!;
    const oldChain = await store.readRecordBlockChain(oldHead);
    const before = await db.getCompactionStorageStats();
    const boundary = Math.ceil(before.usedBlocks * 1.5);
    expect(oldHead).toBeLessThan(boundary);
    expect(Math.max(...oldChain)).toBeGreaterThanOrEqual(boundary);
    expect(oldChain.length).toBeGreaterThan(1);
    const commit = vi.spyOn(db, 'commit');
    const trim = vi.spyOn(db, 'trimFreeTail');
    const result = await db.runIncrementalCompactionStep({
      maxAmplification: 1.5,
      targetBatchDocuments: 1,
      targetBatchUnits: 1,
    });
    expect(result.didWork).toBe(true);
    expect(result.relocatedDocuments).toBe(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(trim).toHaveBeenCalledTimes(1);
    expect(result.reclaimedTailBlocks).toBeGreaterThan(0);
    const newHead = (await db.getDocumentBlockId('items', 'multi'))!;
    expect(newHead).toBeGreaterThan(oldHead);
    expect(Math.max(...(await store.readRecordBlockChain(newHead)))).toBeLessThan(boundary);
    expect((await db.getCompactionStorageStats()).fileSizeBytes).toBeLessThan(before.fileSizeBytes);
    const document = (await db.getDocument('multi', 'items')) as Document;
    expect(document.getId()).toBe('multi');
    expect(document.getFields()).toEqual({ payload });
  });
});
