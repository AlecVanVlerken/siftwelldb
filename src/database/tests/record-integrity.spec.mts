import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../dbmsback.mjs';
import { SimpleDbms } from '../simpledbms.mjs';
import { fetchPageCursor } from '../pagination.mjs';
import { QueryLanguage } from '../../query/querylanguage.mjs';
import type { FreeBlockFile } from '../../storage/blocks/freeblockfile.mjs';
import { CollectionCatalog } from '../../compaction/vacuum/collectioncatalog.mjs';
import { VacuumValidator } from '../../compaction/vacuum/vacuumvalidator.mjs';

const open: SimpleDbms[] = [];

async function fixture(hnswConfig?: HnswConfig) {
  const data = new MockFile(4096);
  const log = new MockFile(4096);
  const db = await SimpleDbms.create(data, log, hnswConfig);
  open.push(db);
  for (const [index, id] of ['A', 'B', 'C'].entries()) {
    await db.insertDocumentObject('docs', { id, title: `document ${id}`, score: index + 1 });
  }
  await db.commit();
  const back = (db as unknown as { dbmsback: DbmsBack }).dbmsback;
  const blocks = (back as unknown as { freeblockFile: FreeBlockFile }).freeblockFile;
  return { db, back, blocks, data, log, middle: (await back.getDocumentBlockId('docs', 'B'))! };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const entry of iterable) result.push(entry);
  return result;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of open.splice(0)) await db.close();
});

describe('live record integrity', () => {
  it('vacuum rejects an incomplete source cursor using independent primary-reference counts', async () => {
    const { db, back } = await fixture();
    const cursor = back.cursor.bind(back);
    vi.spyOn(back, 'cursor').mockImplementation(async (collection, field, value) => {
      const actual = await cursor(collection, field, value);
      return (async function* () {
        for await (const document of actual) {
          if (document.getId() !== 'B') yield document;
        }
      })();
    });
    await expect(db.vacuumCompactInto(new MockFile(4096), new MockFile(4096))).rejects.toThrow(
      'copied 2 documents from 3 live primary references',
    );
    vi.restoreAllMocks();
    expect((await collect(db.cursor('docs', 'id'))).map((raw) => (JSON.parse(raw) as { id: string }).id)).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('vacuum validation refuses matching incomplete scans rather than trusting their equal counts', async () => {
    const { back } = await fixture();
    const target = await SimpleDbms.create(new MockFile(4096), new MockFile(4096));
    open.push(target);
    for (const [index, id] of ['A', 'C'].entries()) {
      await target.insertDocumentObject('docs', { id, title: `document ${id}`, score: index === 0 ? 1 : 3 });
    }
    const cursor = back.cursor.bind(back);
    vi.spyOn(back, 'cursor').mockImplementation(async (collection, field, value) => {
      const actual = await cursor(collection, field, value);
      return (async function* () {
        for await (const document of actual) if (document.getId() !== 'B') yield document;
      })();
    });
    const targetBack = (target as unknown as { dbmsback: DbmsBack }).dbmsback;
    await expect(new VacuumValidator(back, targetBack, new CollectionCatalog(back)).validate()).rejects.toThrow(
      'document scan returned 2 documents from 3 live primary references',
    );
  });

  it('fails direct reads, scans, SQL, pagination, statistics and maintenance on a live I/O failure', async () => {
    const { db, back, blocks, middle } = await fixture();
    const failure = new Error('injected B read failure');
    const readBlock = blocks.readBlock.bind(blocks);
    vi.spyOn(blocks, 'readBlock').mockImplementation((pointer) => {
      if (pointer === middle) return Promise.reject(failure);
      return readBlock(pointer);
    });
    const sql = new QueryLanguage(db);
    const expected = { cause: failure };
    await expect(back.getDocument('B', 'docs')).rejects.toMatchObject(expected);
    await expect(back.getDocument('B', 'docs', true)).rejects.toMatchObject(expected);
    await expect(collect(db.cursor('docs', 'id'))).rejects.toMatchObject(expected);
    await expect(collect(db.cursor('docs', 'score'))).rejects.toMatchObject(expected);
    await expect(sql.execute('SELECT * FROM docs')).rejects.toMatchObject(expected);
    await expect(sql.execute('SELECT * FROM docs WHERE id = "B"')).rejects.toMatchObject(expected);
    await expect(sql.execute('SELECT COUNT(*) AS n FROM docs')).rejects.toMatchObject(expected);
    await expect(sql.execute('UPDATE docs SET score = 9')).rejects.toMatchObject(expected);
    await expect(sql.execute('DELETE FROM docs')).rejects.toMatchObject(expected);
    await expect(fetchPageCursor(db, { collection: 'docs', iterableKey: 'id', limit: 3 })).rejects.toMatchObject(
      expected,
    );
    await expect(db.getCollectionRecordBytes('docs')).rejects.toMatchObject(expected);
    await expect(db.getDocumentStoredBytes('docs', 'B')).rejects.toMatchObject(expected);
    await expect(back.listRecordRelocationTargets()).rejects.toMatchObject(expected);
    await expect(back.relocateDocument('docs', 'B')).rejects.toMatchObject(expected);
    expect(await back.getPrimaryReferenceCount('docs')).toBe(3);
    expect(await db.getDocumentObjectById('docs', 'A')).toEqual({ id: 'A', title: 'document A', score: 1 });
    expect(await back.getDocumentBlockId('docs', 'B')).toBe(middle);
  });

  it('distinguishes missing IDs from missing records still referenced by the primary index', async () => {
    const { db, back, blocks, middle } = await fixture();
    await expect(back.getDocument('absent', 'docs')).rejects.toThrow('Document not found');
    expect(await collect(db.cursorEqual('docs', 'id', 'absent'))).toEqual([]);
    await blocks.freeBlock(middle);
    await expect(back.getDocument('B', 'docs')).rejects.toThrow(/references missing record/);
    await expect(collect(db.cursorEqual('docs', 'id', 'B'))).rejects.toThrow(/references missing record/);
    await expect(collect(db.cursor('docs', 'id'))).rejects.toThrow(/references missing record/);
    expect(await back.getPrimaryReferenceCount('docs')).toBe(3);
  });

  it('does not hide a compression decode failure or reclaim its live record', async () => {
    const { db, back, blocks, middle } = await fixture();
    const block = await blocks.readBlock(middle);
    const length = block.readUInt32BE(5);
    const stored = JSON.parse(block.subarray(9, 9 + length).toString('utf8')) as {
      iterableEntries: Array<{ key: string; compression: string }>;
    };
    stored.iterableEntries.find((field) => field.key === 'title')!.compression = 'gzip';
    const json = Buffer.from(JSON.stringify(stored));
    block.fill(0, 5);
    block.writeUInt32BE(json.length, 5);
    json.copy(block, 9);
    blocks._setDirtyBlock(middle, block);
    await expect(collect(db.cursor('docs', 'id'))).rejects.toThrow(/Cannot read record/);
    await expect(back.listRecordRelocationTargets()).rejects.toThrow(/Cannot read record/);
    expect(await back.getDocumentBlockId('docs', 'B')).toBe(middle);
  });

  it('propagates unreadable live semantic results while preserving tombstone absence', async () => {
    const config: HnswConfig = {
      dimension: 3,
      M: 4,
      efConstruction: 32,
      efSearch: 32,
      embeddingFn: () => Promise.resolve(new Float32Array([1, 0, 0])),
    };
    const { back, blocks, middle } = await fixture(config);
    const readBlock = blocks.readBlock.bind(blocks);
    const read = vi.spyOn(blocks, 'readBlock').mockImplementation((pointer) => {
      if (pointer === middle) return Promise.reject(new Error('live semantic record read failed'));
      return readBlock(pointer);
    });
    await expect(back.semanticSearch('docs', 'document', 10)).rejects.toThrow(/Cannot read record/);
    read.mockRestore();
    await back.deleteDocument('B', 'docs');
    expect((await back.semanticSearch('docs', 'document', 10)).map((doc) => doc.getId()).sort()).toEqual(['A', 'C']);
    expect(await back.getPrimaryReferenceCount('docs')).toBe(2);
    expect(await collect(await back.cursor('docs', 'id'))).toHaveLength(2);
  });
});
