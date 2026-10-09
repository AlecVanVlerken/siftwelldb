import { describe, expect, it, vi } from 'vitest';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../dbmsback.mjs';
import { parseRawDocument, type Document } from '../document.mjs';
import type { RecordStore } from '../../storage/records/recordstore.mjs';

const body = 'unindexed rabbit habitat '.repeat(500);
const encode = (text: string) => Promise.resolve(new Float32Array([text.includes('rabbit') ? 0 : 10, 0, 0, 0]));
const config: HnswConfig = { dimension: 4, embeddingFn: encode, M: 4, efConstruction: 32, efSearch: 32 };

async function create(hnswConfig = config) {
  const data = new MockFile(4096);
  const log = new MockFile(4096);
  const db = new DbmsBack(data, log, hnswConfig);
  await db.create();
  await db.setFieldIndexed('articles', '_body', false);
  return { db, data, log };
}

async function semanticIds(db: DbmsBack, collection = 'articles') {
  return (await db.semanticSearch(collection, 'rabbit', 20)).map((doc) => doc.getId());
}

describe('field indexing with retained HNSW tombstones', () => {
  it('keeps record identities and graph topology when deleting an already tombstoned document', async () => {
    const embeddingFn = vi.fn(encode);
    const { db, data, log } = await create({ ...config, embeddingFn });
    await db.insertDocument(parseRawDocument('articles', { id: 'old', title: 'rabbit', _body: body }));
    await db.insertDocument(parseRawDocument('articles', { id: 'live', title: 'dolphin', _body: body }));
    const oldPointer = (await db.getDocumentBlockId('articles', 'old'))!;
    const before = await db.inspectHnswGraphStructureSnapshot('articles');
    const calls = embeddingFn.mock.calls.length;
    await db.setFieldIndexed('articles', 'title', false);
    await db.setFieldIndexed('articles', 'title', true);
    expect(embeddingFn).toHaveBeenCalledTimes(calls);
    expect(await db.inspectHnswGraphStructureSnapshot('articles')).toEqual(before);
    await db.tombstoneSemanticEntry('old', 'articles');
    await db.deleteDocument('old', 'articles');
    expect(embeddingFn).toHaveBeenCalledTimes(calls);
    expect(await (db as unknown as { recordStore: RecordStore }).recordStore.readRecord(oldPointer)).not.toBeNull();
    const after = await db.inspectHnswGraphStructureSnapshot('articles');
    expect(after.nodes).toEqual(before.nodes.map((node) => ({ ...node, deleted: node.docId === oldPointer })));
    expect(after.entryPoint).toBe(before.entryPoint);
    await db.insertDocument(parseRawDocument('articles', { id: 'new', title: 'rabbit', _body: body }));
    expect(await db.getDocumentBlockId('articles', 'new')).not.toBe(oldPointer);
    expect(await semanticIds(db)).toEqual(expect.arrayContaining(['live', 'new']));
    expect(await semanticIds(db)).not.toContain('old');
    await db.commit();
    await db.close();
    const reopened = await DbmsBack.open(data, log, config);
    expect(await semanticIds(reopened)).toEqual(expect.arrayContaining(['live', 'new']));
    expect(await semanticIds(reopened)).not.toContain('old');
    expect((await reopened.inspectHnswGraphStructure('articles')).filter((node) => node.deleted)).toHaveLength(1);
    await reopened.close();
  });

  it('replaces the last live entry through retained routing nodes and preserves it after reopen', async () => {
    const { db, data, log } = await create();
    await db.insertDocument(parseRawDocument('articles', { id: 'a', title: 'rabbit', _body: body }));
    for (let i = 0; i < 5; i++) await db.editDocumentByID('articles', 'a', 'title', `dolphin ${i}`);
    expect((await db.inspectHnswGraphStructure('articles')).filter((node) => node.deleted)).toHaveLength(5);
    await db.commit();
    await db.close();
    const reopened = await DbmsBack.open(data, log, config);
    expect(await semanticIds(reopened)).toEqual(['a']);
    expect(((await reopened.getDocument('a', 'articles')) as Document).getFields()['title']).toBe('dolphin 4');
    await reopened.deleteDocument('a', 'articles');
    await reopened.commit();
    await reopened.close();
    const empty = await DbmsBack.open(data, log, config);
    expect(await semanticIds(empty)).toEqual([]);
    await empty.insertDocument(parseRawDocument('articles', { id: 'b', title: 'rabbit', _body: body }));
    await empty.commit();
    await empty.close();
    const reinserted = await DbmsBack.open(data, log, config);
    expect(await semanticIds(reinserted)).toEqual(['b']);
    await reinserted.close();
  });

  it('migrates live long text without resurrecting online or offline deletions', async () => {
    const { db, data, log } = await create();
    for (const id of ['online-dead', 'offline-dead', 'live'])
      await db.insertDocument(parseRawDocument('articles', { id, title: 'dolphin', _body: body }));
    await db.deleteDocument('online-dead', 'articles');
    const offlinePointer = (await db.getDocumentBlockId('articles', 'offline-dead'))!;
    delete (db as unknown as { metaCache: Record<string, unknown> }).metaCache['__indexing__'];
    await db.commit();
    await db.close();
    const offline = await DbmsBack.open(data, log);
    await offline.deleteDocument('offline-dead', 'articles');
    expect(
      await (offline as unknown as { recordStore: RecordStore }).recordStore.readRecord(offlinePointer),
    ).not.toBeNull();
    expect(offline.getPendingSemanticCollections()).toEqual(['articles']);
    await offline.commit();
    await offline.close();
    const embeddingFn = vi.fn(encode);
    const migrated = await DbmsBack.open(data, log, { ...config, embeddingFn });
    expect(embeddingFn).toHaveBeenCalledTimes(1);
    expect(embeddingFn.mock.calls[0][0]).toContain(`_body: ${body}`);
    expect(migrated.getPendingSemanticCollections()).toEqual([]);
    expect(migrated.getFieldIndexConfig('articles')['_body']).toBe(false);
    expect(await semanticIds(migrated)).toEqual(['live']);
    expect(await migrated.inspectHnswGraphStructure('articles')).toHaveLength(1);
    const calls = embeddingFn.mock.calls.length;
    await migrated.close();
    const reopened = await DbmsBack.open(data, log, { ...config, embeddingFn });
    expect(embeddingFn).toHaveBeenCalledTimes(calls);
    expect(await semanticIds(reopened)).toEqual(['live']);
    await reopened.close();
  });

  it('relocates retained graph and vector units without changing another collection or query results', async () => {
    const { db, data, log } = await create();
    for (const id of ['dead', 'live'])
      await db.insertDocument(parseRawDocument('articles', { id, title: 'rabbit', _body: body }));
    await db.insertDocument(parseRawDocument('other', { id: 'foreign', title: 'dolphin' }));
    await db.deleteDocument('dead', 'articles');
    const foreign = await db.inspectHnswGraphStructureSnapshot('other');
    const results = await semanticIds(db);
    await db.setFieldIndexed('articles', 'title', false);
    const tombstone = (await db.inspectHnswGraphStructure('articles')).find((node) => node.deleted)!;
    await db.relocateHnswUnit({ collection: 'articles', kind: 'hnsw-graph', nodeId: tombstone.nodeId });
    const moved = (await db.inspectHnswGraphStructure('articles')).find((node) => node.docId === tombstone.docId)!;
    await db.relocateHnswUnit({ collection: 'articles', kind: 'hnsw-vector', nodeId: moved.nodeId });
    await db.relocateDocument('articles', 'live');
    await db.setFieldIndexed('articles', 'title', true);
    const tree = (await db.listBtreeRelocationTargets()).find((target) => target.collection === 'articles')!;
    await db.relocateBtreeNode(tree.collection!, tree.field!, tree.blockNumber!);
    expect(await db.inspectHnswGraphStructureSnapshot('other')).toEqual(foreign);
    expect(await semanticIds(db)).toEqual(results);
    expect((await db.getDocument('live', 'articles')) as Document).toBeDefined();
    await db.commit();
    await db.close();
    const reopened = await DbmsBack.open(data, log, config);
    expect(await semanticIds(reopened)).toEqual(results);
    expect(db.getFieldIndexConfig('articles')).toEqual(reopened.getFieldIndexConfig('articles'));
    const ids: Array<string | number> = [];
    for await (const doc of await reopened.cursor('articles', 'title', 'rabbit')) ids.push(doc.getId());
    expect(ids).toEqual(['live']);
    await reopened.close();
  });

  it('vacuum preserves field policies and empty numeric collections while reclaiming retained records', async () => {
    const { db } = await create();
    await db.setFieldIndexed('empty', '_body', false);
    await db.insertDocument(parseRawDocument('empty', { id: 42, title: 'rabbit', _body: body }));
    await db.deleteDocument(42, 'empty');
    await db.insertDocument(parseRawDocument('articles', { id: 'dead', title: 'rabbit', _body: body }));
    await db.insertDocument(parseRawDocument('articles', { id: 'live', title: 'dolphin', _body: body }));
    await db.deleteDocument('dead', 'articles');
    await db.setFieldIndexed('articles', 'title', false);
    await db.commit();
    const before = await db.getCompactionStorageStats();
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const target = await db.vacuumCompactInto(data, log);
    expect((await target.getCompactionStorageStats()).usedBlocks).toBeLessThan(before.usedBlocks);
    expect(target.getFieldIndexConfig('articles')).toEqual(db.getFieldIndexConfig('articles'));
    expect(target.describeCollection('empty').find((field) => field.name === 'id')!.type).toBe('number');
    expect(await target.inspectHnswGraphStructure('empty')).toEqual([]);
    expect((await target.inspectHnswGraphStructure('articles')).some((node) => node.deleted)).toBe(false);
    expect(((await target.getDocument('live', 'articles')) as Document).getFields()['_body']).toBe(body);
    await target.close();
    const reopened = await DbmsBack.open(data, log, config);
    expect(await semanticIds(reopened)).toEqual(['live']);
    expect(await semanticIds(reopened, 'empty')).toEqual([]);
    await reopened.insertDocument(parseRawDocument('empty', { id: 43, title: 'rabbit', _body: body }));
    expect(await semanticIds(reopened, 'empty')).toEqual([43]);
    expect(await semanticIds(reopened)).toEqual(['live']);
    await reopened.close();
    await db.close();
  });
});
