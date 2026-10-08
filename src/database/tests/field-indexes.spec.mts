import { describe, expect, it, vi } from 'vitest';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../dbmsback.mjs';
import { SimpleDbms } from '../simpledbms.mjs';
import { parseRawDocument, Document } from '../document.mjs';
import { BlockNodeStorage } from '../../indexes/btree/nodestorage.mjs';
import { QueryLanguage } from '../../query/querylanguage.mjs';
import { bulkImportArray } from '../bulkimport.mjs';

const longBody = 'long article about rabbits '.repeat(500);
const encoder = (text: string) => Promise.resolve(new Float32Array(text.includes('rabbit') ? [1, 0, 0] : [0, 1, 0]));
const config: HnswConfig = { dimension: 3, embeddingFn: encoder, M: 4 };

async function makeDb(semantic?: HnswConfig) {
  const data = new MockFile(4096);
  const log = new MockFile(4096);
  const db = await SimpleDbms.create(data, log, semantic);
  return { db, data, log };
}

async function rows(cursor: AsyncIterable<string>): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  for await (const json of cursor) result.push(JSON.parse(json) as Record<string, unknown>);
  return result;
}

describe('collection field indexes', () => {
  it('allows policy configuration and empty scans before the first document', async () => {
    const { db } = await makeDb();
    await db.setFieldIndexed('articles', 'body', false);
    expect(await rows(db.cursor('articles', 'id'))).toEqual([]);
    expect(await new QueryLanguage(db).execute('SELECT * FROM articles')).toEqual([]);
    await db.insertDocumentObject('articles', { id: 'a', body: longBody });
    expect(db.getFieldIndexConfig('articles')['body']).toBe(false);
  });

  it('defaults ordinary and underscore fields to indexed, excluding binary images', async () => {
    const { db } = await makeDb();
    await db.insertDocumentObject('articles', { id: 'a', title: 'short', _notes: 'normal', 'photo.png': 'YWJj' });
    expect(db.getFieldIndexConfig('articles')).toEqual({ id: true, title: true, _notes: true, 'photo.png': false });
    expect(db.describeCollection('articles').map((field) => field.name)).toEqual(['id', 'title', '_notes']);
    await expect(db.setFieldIndexed('articles', 'id', false)).rejects.toThrow('primary id');
    await expect(db.setFieldIndexed('articles', 'photo.png', true)).rejects.toThrow('binary/image');
  });

  it('stores and edits long unindexed text and scans it across reopen', async () => {
    const { db, data, log } = await makeDb();
    await db.setFieldIndexed('articles', 'body', false);
    await db.insertDocumentObject('articles', { id: 'a', title: 'short', body: longBody });
    await db.editDocument('articles', 'a', 'body', longBody + ' revised');
    expect((await rows(db.cursorEqual('articles', 'body', longBody + ' revised'))).map((row) => row['id'])).toEqual([
      'a',
    ]);
    await db.commit();
    await db.close();
    const reopened = await SimpleDbms.open(data, log);
    expect(reopened.getFieldIndexConfig('articles')['body']).toBe(false);
    expect(JSON.parse(await reopened.getDocumentById('articles', 'a'))).toMatchObject({ body: longBody + ' revised' });
    expect(reopened.describeCollection('articles').map((field) => field.name)).toEqual(['id', 'title']);
  });

  it('checks complete UTF-8 keys, including id and length overhead, before any mutation', async () => {
    const { db } = await makeDb();
    await expect(db.insertDocumentObject('articles', { id: 'a', title: 'é'.repeat(1016) })).rejects.toThrow('2035');
    expect(db.listCollections()).toEqual([]);
    await db.insertDocumentObject('articles', { id: 'a', title: 'original', score: 1 });
    await expect(db.insertDocumentObject('articles', { id: 'a', title: 'duplicate' })).rejects.toThrow(
      'already exists',
    );
    await expect(db.editDocument('articles', 'a', 'title', longBody)).rejects.toThrow('disable indexing');
    await expect(db.replaceDocument('articles', 'a', { id: 'a', title: longBody, score: 2 })).rejects.toThrow(
      'disable indexing',
    );
    expect(await rows(db.cursorEqual('articles', 'title', 'original'))).toEqual([
      { id: 'a', title: 'original', score: 1 },
    ]);
    await db.insertDocumentObject('articles', { id: 'b', title: 'é'.repeat(1015), score: 2 });
    await db.commit();
  });

  it('backfills a complete index, removes it, and maintains it through replacement and deletion', async () => {
    const { db, data, log } = await makeDb();
    await db.setFieldIndexed('articles', '_tag', false);
    for (let i = 0; i < 180; i++)
      await db.insertDocumentObject('articles', { id: String(i).padStart(3, '0'), _tag: i % 2 ? 'odd' : 'even' });
    await db.setFieldIndexed('articles', '_tag', true);
    expect((await rows(db.cursorEqual('articles', '_tag', 'odd'))).length).toBe(90);
    await db.replaceDocument('articles', '001', { id: '001', _tag: 'even' });
    await db.deleteDocumentById('articles', '003');
    expect((await rows(db.cursorEqual('articles', '_tag', 'odd'))).length).toBe(88);
    await db.setFieldIndexed('articles', '_tag', false);
    expect(db.describeCollection('articles').map((field) => field.name)).toEqual(['id']);
    expect((await rows(db.cursorEqual('articles', '_tag', 'odd'))).length).toBe(88);
    await db.commit();
    await db.close();
    const reopened = await SimpleDbms.open(data, log);
    expect(reopened.getFieldIndexConfig('articles')['_tag']).toBe(false);
    await reopened.setFieldIndexed('articles', '_tag', true);
    expect((await rows(reopened.cursorEqual('articles', '_tag', 'odd'))).length).toBe(88);
  });

  it('leaves config and records intact when backfill validation fails', async () => {
    const { db } = await makeDb();
    await db.setFieldIndexed('articles', 'body', false);
    await db.insertDocumentObject('articles', { id: 'a', body: 'short' });
    await db.insertDocumentObject('articles', { id: 'b', body: longBody });
    await expect(db.setFieldIndexed('articles', 'body', true)).rejects.toThrow('maximum indexed key size');
    expect(db.getFieldIndexConfig('articles')['body']).toBe(false);
    expect(db.describeCollection('articles').map((field) => field.name)).toEqual(['id']);
    expect((await rows(db.cursor('articles', 'id'))).length).toBe(2);
  });

  it('serializes index changes with concurrent inserts', async () => {
    const { db } = await makeDb();
    await db.setFieldIndexed('articles', 'tag', false);
    await db.insertDocumentObject('articles', { id: 'a', tag: 'same' });
    await Promise.all([
      db.setFieldIndexed('articles', 'tag', true),
      db.insertDocumentObject('articles', { id: 'b', tag: 'same' }),
    ]);
    expect((await rows(db.cursorEqual('articles', 'tag', 'same'))).map((row) => row['id'])).toEqual(['a', 'b']);
  });

  it('discards staged nodes after a backfill flush failure and can retry', async () => {
    const db = new DbmsBack(new MockFile(4096), new MockFile(4096));
    await db.create();
    await db.setFieldIndexed('articles', 'tag', false);
    for (let i = 0; i < 180; i++)
      await db.insertDocument(parseRawDocument('articles', { id: String(i), tag: `tag-${i}` }));
    // Initialize FreeBlockFile's free-list page before measuring live block usage.
    await db.insertDocument(parseRawDocument('articles', { id: 'warmup' }));
    await db.deleteDocument('warmup', 'articles');
    const before = await db.getCompactionStorageStats();
    const flush = vi
      .spyOn(BlockNodeStorage.prototype, 'flushDirtyNodes')
      .mockRejectedValueOnce(new Error('injected build failure'));
    try {
      await expect(db.setFieldIndexed('articles', 'tag', true)).rejects.toThrow('injected build failure');
    } finally {
      flush.mockRestore();
    }
    expect(db.getFieldIndexConfig('articles')['tag']).toBe(false);
    expect(db.describeCollection('articles').map((field) => field.name)).toEqual(['id']);
    expect((await db.getCompactionStorageStats()).usedBlocks).toBe(before.usedBlocks);
    await db.setFieldIndexed('articles', 'tag', true);
    const ids = [];
    for await (const document of await db.cursor('articles', 'tag')) ids.push(document.getId());
    expect(ids.length).toBe(180);
    await db.commit();
  });

  it('splits mixed short and near-limit keys into valid disk nodes', async () => {
    const { db, data, log } = await makeDb();
    for (let i = 0; i < 100; i++) await db.insertDocumentObject('articles', { id: `s${i}`, title: `z${i}` });
    for (const letter of ['a', 'b', 'c', 'd', 'e', 'f'])
      await db.insertDocumentObject('articles', { id: letter, title: letter.repeat(2000) });
    await db.commit();
    await db.close();
    const reopened = await SimpleDbms.open(data, log);
    expect((await rows(reopened.cursor('articles', 'title'))).length).toBe(106);
  });

  it('keeps SQL lookups and mutations correct after toggles, and preflights every updated row', async () => {
    const { db } = await makeDb();
    const sql = new QueryLanguage(db);
    await db.setFieldIndexed('articles', 'body', false);
    await sql.execute("INSERT INTO articles VALUES {id: 'a', title: 'first', body: 'same', score: 1}");
    await sql.execute("INSERT INTO articles VALUES {id: 'b', title: 'second', body: 'same', score: 1}");
    expect((await sql.execute("SELECT id FROM articles WHERE body = 'same'")).length).toBe(2);
    await db.setFieldIndexed('articles', 'body', true);
    await sql.execute("UPDATE articles SET body = 'updated' WHERE id = 'a'");
    expect(await sql.execute("SELECT id FROM articles WHERE body = 'updated'")).toEqual([{ id: 'a' }]);
    await expect(sql.execute(`UPDATE articles SET score = 2, title = '${longBody}'`)).rejects.toThrow(
      'maximum indexed key size',
    );
    expect((await rows(db.cursorEqual('articles', 'score', 1))).length).toBe(2);
    await db.setFieldIndexed('articles', 'body', false);
    await sql.execute("DELETE FROM articles WHERE body = 'updated'");
    expect(await sql.execute("SELECT id FROM articles WHERE body = 'same'")).toEqual([{ id: 'b' }]);
  });

  it('reports failed bulk inserts without committing partial records', async () => {
    const { db } = await makeDb();
    const result = await bulkImportArray(
      db,
      [
        { id: 'a', title: 'short' },
        { id: 'bad', title: longBody },
        { id: 'b', title: 'short' },
      ],
      { collection: 'articles' },
    );
    expect(result).toMatchObject({ totalImported: 2, failedCount: 1 });
    expect((await rows(db.cursor('articles', 'id'))).map((row) => row['id'])).toEqual(['a', 'b']);
  });

  it('embeds indexed and unindexed text automatically and does not embed on B+ tree toggles', async () => {
    const embeddingFn = vi.fn(encoder);
    const { db, data, log } = await makeDb({ ...config, embeddingFn });
    await db.setFieldIndexed('articles', '_body', false);
    await db.insertDocumentObject('articles', { id: 'a', title: 'short', _body: longBody });
    expect(embeddingFn).toHaveBeenLastCalledWith(`title: short _body: ${longBody}`);
    const calls = embeddingFn.mock.calls.length;
    await db.setFieldIndexed('articles', 'title', false);
    await db.setFieldIndexed('articles', 'title', true);
    expect(embeddingFn).toHaveBeenCalledTimes(calls);
    await db.editDocument('articles', 'a', '_body', 'dolphins');
    expect(embeddingFn).toHaveBeenLastCalledWith('title: short _body: dolphins');
    await db.commit();
    await db.close();
    const reopened = await SimpleDbms.open(data, log, { ...config, embeddingFn });
    expect(
      (await reopened.semanticSearch('articles', 'dolphins', 1)).map((json) => (JSON.parse(json) as { id: string }).id),
    ).toEqual(['a']);
    await reopened.deleteDocumentById('articles', 'a');
    expect(await reopened.semanticSearch('articles', 'dolphins', 1)).toEqual([]);
  });

  it('leaves the old document intact when an embedding fails during replacement', async () => {
    const embeddingFn = vi.fn(encoder);
    const { db } = await makeDb({ ...config, embeddingFn });
    await db.insertDocumentObject('articles', { id: 'a', title: 'original' });
    embeddingFn.mockRejectedValueOnce(new Error('model unavailable'));
    await expect(db.replaceDocument('articles', 'a', { id: 'a', title: 'new' })).rejects.toThrow('model unavailable');
    expect(JSON.parse(await db.getDocumentById('articles', 'a'))).toEqual({ id: 'a', title: 'original' });
  });

  it('preserves settings, long text, indexes and semantic pointers through relocation and full vacuum', async () => {
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const db = new DbmsBack(data, log, config);
    await db.create();
    await db.setFieldIndexed('articles', 'body', false);
    await db.insertDocument(parseRawDocument('articles', { id: 'a', title: 'short', body: longBody }));
    await db.setFieldIndexed('articles', 'title', false);
    await db.setFieldIndexed('articles', 'title', true);
    await db.relocateDocument('articles', 'a');
    expect((await db.semanticSearch('articles', 'rabbit', 1))[0].getId()).toBe('a');
    await db.commit();
    const targetData = new MockFile(4096);
    const targetLog = new MockFile(4096);
    const compacted = await db.vacuumCompactInto(targetData, targetLog);
    expect(compacted.getFieldIndexConfig('articles')).toEqual({ id: true, body: false, title: true });
    await compacted.close();
    const reopened = await DbmsBack.open(targetData, targetLog, config);
    expect(((await reopened.getDocument('a', 'articles')) as Document).getFields()).toEqual({
      title: 'short',
      body: longBody,
    });
    expect(reopened.describeCollection('articles').map((field) => field.name)).toEqual(['id', 'title']);
    expect((await reopened.semanticSearch('articles', 'rabbit', 1))[0].getId()).toBe('a');
  });
});

async function legacyDatabase() {
  const data = new MockFile(4096);
  const log = new MockFile(4096);
  // Reproduce both the old record classification and its text-only embedding input.
  const db = new DbmsBack(data, log, { ...config, embeddingFn: (text) => encoder(text.split(' _body:')[0]) });
  await db.create();
  await db.setFieldIndexed('articles', '_body', false);
  await db.insertDocument(new Document('articles', 'a', [['title', 'short']], [['_body', longBody]]));
  // Produce a legacy-compatible fixture: existing records/trees/HNSW, without the new metadata.
  const internal = db as unknown as { metaCache: Record<string, unknown> };
  delete internal.metaCache['__indexing__'];
  await db.commit();
  await db.close();
  return { data, log };
}

describe('index policy migration', () => {
  it('backfills legacy per-document exclusions when the collection already has an index', async () => {
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const db = new DbmsBack(data, log);
    await db.create();
    await db.insertDocument(new Document('articles', 'a', [['title', 'short']], []));
    await db.insertDocument(new Document('articles', 'b', [], [['title', 'excluded previously']]));
    const internal = db as unknown as {
      metaCache: Record<string, unknown>;
      treeCache: Map<
        string,
        {
          tree: {
            get(key: Buffer): Promise<Buffer | null>;
            delete(key: Buffer): Promise<boolean>;
            insert(key: Buffer, value: Buffer): Promise<void>;
          };
        }
      >;
      secondaryIndexKeyBuffer(form: string, value: string, id: string): Buffer;
    };
    const titleTree = internal.treeCache.get('articles:title')!.tree;
    const excludedKey = internal.secondaryIndexKeyBuffer('SS', 'excluded previously', 'b');
    const pointer = (await titleTree.get(excludedKey))!;
    await titleTree.delete(excludedKey);
    await titleTree.insert(internal.secondaryIndexKeyBuffer('SS', 'obsolete value', 'b'), pointer);
    delete internal.metaCache['__indexing__'];
    await db.commit();
    await db.close();
    const reopened = await SimpleDbms.open(data, log);
    expect(reopened.getFieldIndexConfig('articles')['title']).toBe(true);
    expect(
      (await rows(reopened.cursorEqual('articles', 'title', 'excluded previously'))).map((row) => row['id']),
    ).toEqual(['b']);
    expect(await rows(reopened.cursorEqual('articles', 'title', 'obsolete value'))).toEqual([]);
    expect((await rows(reopened.cursor('articles', 'id'))).length).toBe(2);
  });

  it('derives old field policy from roots, preserves names and data, and reindexes semantics once', async () => {
    const { data, log } = await legacyDatabase();
    const embeddingFn = vi.fn(encoder);
    const db = await DbmsBack.open(data, log, { ...config, embeddingFn });
    expect(db.getFieldIndexConfig('articles')).toEqual({ id: true, title: true, _body: false });
    expect(embeddingFn).toHaveBeenCalledTimes(1);
    expect(embeddingFn.mock.calls[0][0]).toContain(`_body: ${longBody}`);
    expect(db.getPendingSemanticCollections()).toEqual([]);
    await db.close();
    const reopened = await DbmsBack.open(data, log, { ...config, embeddingFn });
    expect(embeddingFn).toHaveBeenCalledTimes(1);
    expect(((await reopened.getDocument('a', 'articles')) as Document).getFields()['_body']).toBe(longBody);
  });

  it('persists pending semantic migration without a model, then retries safely after failure', async () => {
    const { data, log } = await legacyDatabase();
    const offline = await DbmsBack.open(data, log);
    expect(offline.getPendingSemanticCollections()).toEqual(['articles']);
    await offline.close();
    const failing = await DbmsBack.open(data, log, {
      ...config,
      embeddingFn: () => Promise.reject(new Error('offline model')),
    });
    expect(failing.getPendingSemanticCollections()).toEqual(['articles']);
    await expect(failing.semanticSearch('articles', 'rabbit', 1)).rejects.toThrow('reindex pending');
    await failing.commit();
    await failing.close();
    const recovered = await DbmsBack.open(data, log, config);
    expect(recovered.getPendingSemanticCollections()).toEqual([]);
    expect((await recovered.semanticSearch('articles', 'rabbit', 1))[0].getId()).toBe('a');
  });

  it('repairs semantic pointers after edits/deletes while the model is unavailable', async () => {
    const { db, data, log } = await makeDb(config);
    await db.insertDocumentObject('articles', { id: 'old', title: 'rabbit' });
    await db.commit();
    await db.close();
    const offline = await SimpleDbms.open(data, log);
    await offline.deleteDocumentById('articles', 'old');
    await offline.insertDocumentObject('articles', { id: 'new', title: 'dolphin' });
    await offline.commit();
    await offline.close();
    const reopened = await SimpleDbms.open(data, log, config);
    expect(reopened.getPendingSemanticCollections()).toEqual([]);
    expect(
      (await reopened.semanticSearch('articles', 'dolphin', 10)).map((json) => (JSON.parse(json) as { id: string }).id),
    ).toEqual(['new']);
  });
});
