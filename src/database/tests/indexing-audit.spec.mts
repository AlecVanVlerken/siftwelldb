import { describe, expect, it, vi } from 'vitest';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../dbmsback.mjs';
import { SimpleDbms } from '../simpledbms.mjs';
import { parseRawDocument, type Document } from '../document.mjs';
import { BlockNodeStorage } from '../../indexes/btree/nodestorage.mjs';

const config: HnswConfig = {
  dimension: 2,
  M: 4,
  embeddingFn: (text) => Promise.resolve(new Float32Array(text.includes('rabbit') ? [1, 0] : [0, 1])),
};
async function create(semantic?: HnswConfig) {
  const data = new MockFile(4096);
  const log = new MockFile(4096);
  const db = new DbmsBack(data, log, semantic);
  await db.create();
  return { db, data, log };
}
async function ids(cursor: AsyncIterable<string>) {
  const result: string[] = [];
  for await (const json of cursor) result.push((JSON.parse(json) as { id: string }).id);
  return result;
}

describe('indexing integration audit', () => {
  it('keeps boolean and numeric equality identical before and after backfill', async () => {
    const db = await SimpleDbms.create(new MockFile(4096), new MockFile(4096));
    await db.setFieldIndexed('mixed', 'value', false);
    for (const doc of [
      { id: 'a', value: 1 },
      { id: 'b', value: true },
      { id: 'c', value: 1 },
      { id: 'd', value: true },
      { id: 'e', value: 2 },
    ])
      await db.insertDocumentObject('mixed', doc);
    expect(await ids(db.cursorEqual('mixed', 'value', true))).toEqual(['b', 'd']);
    await db.setFieldIndexed('mixed', 'value', true);
    expect(await ids(db.cursorEqual('mixed', 'value', true))).toEqual(['b', 'd']);
    expect(await ids(db.cursorEqual('mixed', 'value', 1))).toEqual(['a', 'c']);
  });

  it('reclaims nodes orphaned by failure while propagating a backfill split', async () => {
    const { db } = await create();
    await db.setFieldIndexed('articles', 'title', false);
    for (let i = 0; i < 24; i++)
      await db.insertDocument(
        parseRawDocument('articles', { id: `id-${i}`, title: String(i).padStart(2, '0') + 'x'.repeat(1990) }),
      );
    await db.insertDocument(parseRawDocument('articles', { id: 'warmup' }));
    await db.deleteDocument('warmup', 'articles');
    await db.commit();
    const before = await db.getCompactionStorageStats();
    const allocation = vi
      .spyOn(BlockNodeStorage.prototype, 'allocateInternalNode')
      .mockRejectedValueOnce(new Error('injected split failure'));
    try {
      await expect(db.setFieldIndexed('articles', 'title', true)).rejects.toThrow('injected split failure');
    } finally {
      allocation.mockRestore();
    }
    expect(db.getFieldIndexConfig('articles')['title']).toBe(false);
    expect((await db.getCompactionStorageStats()).usedBlocks).toBe(before.usedBlocks);
    await db.setFieldIndexed('articles', 'title', true);
    await db.commit();
  });

  it('vacuum preserves an emptied numeric collection, its primary type, and field policies', async () => {
    const { db } = await create(config);
    await db.setFieldIndexed('empty', 'body', false);
    await db.insertDocument(parseRawDocument('empty', { id: 42, title: 'rabbit', body: 'x'.repeat(16000) }));
    await db.deleteDocument(42, 'empty');
    const target = await db.vacuumCompactInto(new MockFile(4096), new MockFile(4096));
    expect(target.getFieldIndexConfig('empty')).toEqual(db.getFieldIndexConfig('empty'));
    expect(target.describeCollection('empty').find((field) => field.name === 'id')?.type).toBe('number');
    await target.insertDocument(parseRawDocument('empty', { id: 43, title: 'rabbit', body: 'y'.repeat(16000) }));
    await expect(target.insertDocument(parseRawDocument('empty', { id: 'wrong', title: 'rabbit' }))).rejects.toThrow(
      'id type',
    );
    expect((await target.semanticSearch('empty', 'rabbit', 1))[0].getId()).toBe(43);
  });

  it('rejects an image index setting before the first image exists', async () => {
    const { db } = await create();
    await expect(db.setFieldIndexed('images', 'photo.png', true)).rejects.toThrow('binary/image');
    expect(db.listCollections()).toEqual([]);
  });

  it('discards a partially built semantic migration and retries only until current', async () => {
    const { db, data, log } = await create(config);
    await db.setFieldIndexed('articles', 'body', false);
    for (const id of ['a', 'b', 'c'])
      await db.insertDocument(parseRawDocument('articles', { id, title: 'rabbit', body: 'x'.repeat(8000) }));
    const old = await db.inspectHnswGraphStructureSnapshot('articles');
    delete (db as unknown as { metaCache: Record<string, unknown> }).metaCache['__indexing__'];
    await db.commit();
    const before = await db.getCompactionStorageStats();
    await db.close();
    const embeddingFn = vi
      .fn(config.embeddingFn)
      .mockImplementationOnce(config.embeddingFn)
      .mockRejectedValueOnce(new Error('second vector unavailable'));
    const failed = await DbmsBack.open(data, log, { ...config, embeddingFn });
    expect(failed.getPendingSemanticCollections()).toEqual(['articles']);
    expect(await failed.inspectHnswGraphStructureSnapshot('articles')).toEqual(old);
    expect((await failed.getCompactionStorageStats()).usedBlocks).toBe(before.usedBlocks);
    await expect(failed.semanticSearch('articles', 'rabbit', 3)).rejects.toThrow('reindex pending');
    await failed.commit();
    await failed.close();
    const retried = await DbmsBack.open(data, log, { ...config, embeddingFn });
    expect(retried.getPendingSemanticCollections()).toEqual([]);
    expect((await retried.semanticSearch('articles', 'rabbit', 3)).map((doc) => doc.getId()).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
    await retried.close();
    const calls = embeddingFn.mock.calls.length;
    await DbmsBack.open(data, log, { ...config, embeddingFn });
    expect(embeddingFn).toHaveBeenCalledTimes(calls);
  });

  it('holds index changes and inserts until a full vacuum has finished its source snapshot', async () => {
    const { db } = await create();
    await db.insertDocument(parseRawDocument('articles', { id: 'a', title: 'rabbit' }));
    let release!: () => void;
    let started!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const copying = new Promise<void>((resolve) => {
      started = resolve;
    });
    const originalCursor = db.cursor.bind(db);
    const cursor = vi.spyOn(db, 'cursor').mockImplementationOnce(async (...args) => {
      const documents = await originalCursor(...args);
      return (async function* () {
        for await (const document of documents) {
          started();
          await paused;
          yield document;
        }
      })();
    });
    const vacuum = db.vacuumCompactInto(new MockFile(4096), new MockFile(4096));
    await copying;
    let changed = false;
    const mutation = db.setFieldIndexed('articles', 'title', false).then(() => {
      changed = true;
    });
    const insertion = db.insertDocument(parseRawDocument('articles', { id: 'b', title: 'dolphin' }));
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(changed).toBe(false);
    } finally {
      release();
    }
    const target = await vacuum;
    await mutation;
    await insertion;
    cursor.mockRestore();
    expect(target.getFieldIndexConfig('articles')['title']).toBe(true);
    const copied = [];
    for await (const document of await target.cursor('articles', 'id')) copied.push(document.getId());
    expect(copied).toEqual(['a']);
    expect(db.getFieldIndexConfig('articles')['title']).toBe(false);
    expect(((await db.getDocument('b', 'articles')) as Document).getFields()['title']).toBe('dolphin');
  });

  it('preserves mixed near-limit keys across multi-level splits, deletion, and reopen', async () => {
    const { db, data, log } = await create();
    const expected = new Map<string, string>();
    for (let n = 0; n < 241; n++) {
      const i = (n * 97) % 241;
      const id = `id-${String(i).padStart(3, '0')}`;
      const title = String(i).padStart(3, '0') + (i % 3 ? 'x'.repeat(2010) : 'short');
      expected.set(id, title);
      await db.insertDocument(parseRawDocument('articles', { id, title }));
    }
    for (const [id] of [...expected].filter((_, i) => i % 2)) {
      await db.deleteDocument(id, 'articles');
      expected.delete(id);
    }
    await db.commit();
    await db.close();
    const reopened = await DbmsBack.open(data, log);
    const seen = [];
    for await (const doc of await reopened.cursor('articles', 'title'))
      seen.push([doc.getId(), doc.getFields()['title']]);
    expect(seen).toEqual([...expected].sort((a, b) => a[1].localeCompare(b[1])));
    for (const [id, title] of expected)
      expect(((await reopened.getDocument(id, 'articles')) as Document).getFields()['title']).toBe(title);
  });
});
