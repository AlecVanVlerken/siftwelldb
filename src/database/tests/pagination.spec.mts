import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { RealFile } from '../../storage/file.mjs';
import { DbmsBack, InvalidCursorError } from '../dbmsback.mjs';
import { SimpleDbms } from '../simpledbms.mjs';
import { fetchPageCursor, fetchPageOffset } from '../pagination.mjs';

describe('Pagination', () => {
  let db: SimpleDbms;

  // Insert 20 cities with numeric populations for consistent ordering
  const cities = Array.from({ length: 20 }, (_, i) => ({
    id: `city-${String(i).padStart(2, '0')}`,
    name: `City ${i}`,
    population: (i + 1) * 1000,
  }));

  beforeEach(async () => {
    const dataFile = new MockFile(256);
    const logFile = new MockFile(4096);
    db = await SimpleDbms.create(dataFile, logFile);

    for (const city of cities) {
      await db.insertDocument('cities', JSON.stringify(city));
    }
    await db.commit();
  });

  afterEach(async () => {
    await db.close();
  });

  describe('cursor-based pagination', () => {
    it('continues after the complete secondary key when values are duplicated', async () => {
      for (const id of ['1', '2', '3', '4']) {
        await db.insertDocument('duplicates', JSON.stringify({ id, category: 'A' }));
      }
      const first = await fetchPageCursor(db, { collection: 'duplicates', iterableKey: 'category', limit: 2 });
      const second = await fetchPageCursor(db, {
        collection: 'duplicates',
        iterableKey: 'category',
        limit: 2,
        afterCursor: first.nextCursor,
      });
      expect(second.data.map((json) => (JSON.parse(json) as { id: string }).id)).toEqual(['3', '4']);
      expect(second.hasMore).toBe(false);
    });

    it('does not skip the next primary entry when the previous entry has been deleted', async () => {
      const first = await fetchPageCursor(db, { collection: 'cities', iterableKey: 'id', limit: 2 });
      await db.deleteDocumentById('cities', 'city-01');
      const second = await fetchPageCursor(db, {
        collection: 'cities',
        iterableKey: 'id',
        limit: 2,
        afterCursor: first.nextCursor,
      });
      expect(second.data.map((json) => (JSON.parse(json) as { id: string }).id)).toEqual(['city-02', 'city-03']);
    });

    it('returns the first page of results', async () => {
      const page = await fetchPageCursor(db, {
        collection: 'cities',
        iterableKey: 'id',
        limit: 5,
      });

      expect(page.data).toHaveLength(5);
      expect(page.pageSize).toBe(5);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toBeDefined();

      const firstDoc = JSON.parse(page.data[0]) as Record<string, unknown>;
      expect(firstDoc['id']).toBe('city-00');
    });

    it('paginates through all results', async () => {
      const allDocs: string[] = [];
      let cursor: string | number | undefined = undefined;
      let pageCount = 0;

      do {
        const page = await fetchPageCursor(db, {
          collection: 'cities',
          iterableKey: 'id',
          limit: 7,
          afterCursor: cursor,
        });

        allDocs.push(...page.data);
        cursor = page.nextCursor;
        pageCount++;

        if (!page.hasMore) break;
      } while (cursor !== undefined);

      // We should get all 20 cities
      expect(allDocs).toHaveLength(20);
      expect(pageCount).toBe(3); // 7 + 7 + 6

      // Verify no duplicates
      const ids = allDocs.map((d) => (JSON.parse(d) as Record<string, unknown>)['id']);
      expect(new Set(ids).size).toBe(20);
    });

    it('returns empty page for empty collection', async () => {
      const emptyDb = await SimpleDbms.create(new MockFile(256), new MockFile(4096));
      await emptyDb.insertDocument('empty', JSON.stringify({ id: 'dummy', val: 1 }));
      await emptyDb.deleteDocumentById('empty', 'dummy');
      await emptyDb.commit();

      const freshDb = await SimpleDbms.create(new MockFile(256), new MockFile(4096));
      await freshDb.insertDocument('test', JSON.stringify({ id: 'only', val: 1 }));
      await freshDb.commit();

      const page = await fetchPageCursor(freshDb, {
        collection: 'test',
        iterableKey: 'id',
        limit: 10,
      });

      expect(page.data).toHaveLength(1);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeUndefined();
      expect(await fetchPageCursor(emptyDb, { collection: 'empty', iterableKey: 'id', limit: 10 })).toMatchObject({
        data: [],
        hasMore: false,
        nextCursor: undefined,
      });
      await emptyDb.close();
      await freshDb.close();
    });

    it('handles limit larger than total results', async () => {
      const page = await fetchPageCursor(db, {
        collection: 'cities',
        iterableKey: 'id',
        limit: 100,
      });

      expect(page.data).toHaveLength(20);
      expect(page.hasMore).toBe(false);
    });

    it('handles limit of 1', async () => {
      const allDocs: string[] = [];
      let cursor: string | number | undefined = undefined;

      for (let i = 0; i < 25; i++) {
        const page = await fetchPageCursor(db, {
          collection: 'cities',
          iterableKey: 'id',
          limit: 1,
          afterCursor: cursor,
        });

        allDocs.push(...page.data);
        if (!page.hasMore) break;
        cursor = page.nextCursor;
      }

      expect(allDocs).toHaveLength(20);
    });
  });

  describe('offset-based pagination', () => {
    it('returns the first page', async () => {
      const page = await fetchPageOffset(db, {
        collection: 'cities',
        iterableKey: 'id',
        limit: 5,
        offset: 0,
      });

      expect(page.data).toHaveLength(5);
      expect(page.hasMore).toBe(true);
    });

    it('skips documents with offset', async () => {
      const page = await fetchPageOffset(db, {
        collection: 'cities',
        iterableKey: 'id',
        limit: 5,
        offset: 5,
      });

      expect(page.data).toHaveLength(5);
      const firstDoc = JSON.parse(page.data[0]) as Record<string, unknown>;
      expect(firstDoc['id']).toBe('city-05');
    });

    it('returns partial last page', async () => {
      const page = await fetchPageOffset(db, {
        collection: 'cities',
        iterableKey: 'id',
        limit: 7,
        offset: 14,
      });

      expect(page.data).toHaveLength(6); // only 6 left
      expect(page.hasMore).toBe(false);
    });

    it('returns empty when offset exceeds total', async () => {
      const page = await fetchPageOffset(db, {
        collection: 'cities',
        iterableKey: 'id',
        limit: 5,
        offset: 100,
      });

      expect(page.data).toHaveLength(0);
      expect(page.hasMore).toBe(false);
    });

    it('paginates through all results', async () => {
      const allDocs: string[] = [];
      let offset = 0;
      const limit = 6;

      while (true) {
        const page = await fetchPageOffset(db, {
          collection: 'cities',
          iterableKey: 'id',
          limit,
          offset,
        });

        allDocs.push(...page.data);
        if (!page.hasMore) break;
        offset += limit;
      }

      expect(allDocs).toHaveLength(20);
      const ids = allDocs.map((d) => (JSON.parse(d) as Record<string, unknown>)['id']);
      expect(new Set(ids).size).toBe(20);
    });
  });
});

type Id = string | number;
const ids = (documents: string[]) => documents.map((json) => (JSON.parse(json) as { id: Id }).id);

async function traverse(db: SimpleDbms, collection: string, field: string): Promise<Id[]> {
  const documents = [];
  for await (const json of db.cursor(collection, field)) documents.push(json);
  return ids(documents);
}

async function paginate(db: SimpleDbms, collection: string, field: string, limit: number): Promise<Id[]> {
  const documents: string[] = [];
  let afterCursor: string | undefined;
  // A broken cursor must fail this bounded test rather than hang the suite.
  for (let pageCount = 0; pageCount < 150; pageCount++) {
    const page = await fetchPageCursor(db, { collection, iterableKey: field, limit, afterCursor });
    expect(page.pageSize).toBe(page.data.length);
    expect(page.data.length).toBeLessThanOrEqual(limit);
    documents.push(...page.data);
    if (!page.hasMore) {
      expect(page.nextCursor).toBeUndefined();
      return ids(documents);
    }
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.nextCursor).not.toBe(afterCursor);
    afterCursor = page.nextCursor;
  }
  throw new Error('Pagination did not reach the end');
}

describe('complete index cursor positions', () => {
  it.each([1, 2, 7, 100])('matches full traversal for all primary/composite forms with limit %i', async (limit) => {
    const db = await SimpleDbms.create(new MockFile(256), new MockFile(4096));
    try {
      const specialIds = ['', '42', 'a/b?#+%', 'é', 'e\u0301', '雪', '😀', '\ufffd', 'metadata'];
      const stringIds = [...specialIds, ...Array.from({ length: 25 }, (_, index) => `doc-${index}`)];
      const numericIds = [-100, -3.5, 0, 0.25, 1, 10, 42, ...Array.from({ length: 25 }, (_, index) => index + 100)];
      for (const [collection, documents] of [
        ['string', stringIds],
        ['numeric', numericIds],
      ] as const) {
        for (const [index, id] of documents.entries()) {
          await db.insertDocumentObject(collection, {
            id,
            category: ['A', 'AA', 'A\0', '雪', '\ufffd'][index % 5],
            score: [false, 0, true, 1, -2, 0.25][index % 6],
          });
        }
        for (const field of ['id', 'category', 'score']) {
          const expected = await traverse(db, collection, field);
          expect(await paginate(db, collection, field, limit)).toEqual(expected);
          expect(new Set(expected).size).toBe(documents.length);
        }
      }
      await db.commit();
    } finally {
      await db.close();
    }
  });

  it.each(['id', 'category'])('keeps the first surviving successor after deletions on %s', async (field) => {
    const db = await SimpleDbms.create(new MockFile(256), new MockFile(4096));
    try {
      for (let id = 1; id <= 8; id++) await db.insertDocumentObject('docs', { id, category: 'A' });
      const first = await fetchPageCursor(db, { collection: 'docs', iterableKey: field, limit: 2 });
      expect(ids(first.data)).toEqual([1, 2]);
      await db.deleteDocumentById('docs', 2);
      await db.deleteDocumentById('docs', 3);
      const second = await fetchPageCursor(db, {
        collection: 'docs',
        iterableKey: field,
        limit: 2,
        afterCursor: first.nextCursor,
      });
      expect(ids(second.data)).toEqual([4, 5]);
      for (const id of [4, 5, 6, 7, 8]) await db.deleteDocumentById('docs', id);
      expect(
        await fetchPageCursor(db, {
          collection: 'docs',
          iterableKey: field,
          limit: 2,
          afterCursor: second.nextCursor,
        }),
      ).toMatchObject({ data: [], hasMore: false, nextCursor: undefined });
    } finally {
      await db.close();
    }
  });

  it('resumes by the saved ordering position when documents are inserted or edited', async () => {
    const db = await SimpleDbms.create(new MockFile(256), new MockFile(4096));
    try {
      for (let id = 1; id <= 5; id++) await db.insertDocumentObject('docs', { id, score: id });
      const first = await fetchPageCursor(db, { collection: 'docs', iterableKey: 'score', limit: 2 });
      await db.editDocument('docs', 2, 'score', 0);
      await db.insertDocumentObject('docs', { id: 6, score: 1.5 });
      await db.insertDocumentObject('docs', { id: 7, score: 2.5 });
      const second = await fetchPageCursor(db, {
        collection: 'docs',
        iterableKey: 'score',
        limit: 20,
        afterCursor: first.nextCursor,
      });
      expect(ids(second.data)).toEqual([7, 3, 4, 5]);
      expect(second.hasMore).toBe(false);
    } finally {
      await db.close();
    }
  });

  it('reads only the resumed page plus lookahead, without scanning preceding documents', async () => {
    const db = await SimpleDbms.create(new MockFile(256), new MockFile(4096));
    try {
      for (let id = 0; id < 100; id++) await db.insertDocumentObject('docs', { id, category: 'A' });
      const first = await fetchPageCursor(db, { collection: 'docs', iterableKey: 'category', limit: 90 });
      const backend = (db as unknown as { dbmsback: DbmsBack }).dbmsback;
      const read = vi.spyOn(
        backend as unknown as { readIndexedDocument: () => Promise<unknown> },
        'readIndexedDocument',
      );
      const second = await fetchPageCursor(db, {
        collection: 'docs',
        iterableKey: 'category',
        limit: 2,
        afterCursor: first.nextCursor,
      });
      expect(ids(second.data)).toEqual([90, 91]);
      expect(read).toHaveBeenCalledTimes(3);
      read.mockRestore();
    } finally {
      await db.close();
    }
  });

  it('retains a logical token across record/tree relocation, disk reopen and full vacuum', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'siftwell-cursor-'));
    const data = path.join(directory, 'data.db');
    const wal = path.join(directory, 'data.wal');
    let db = await SimpleDbms.create(new RealFile(data), new RealFile(wal));
    try {
      for (const id of ['', 'a', 'b', 'c', '雪', '😀']) await db.insertDocumentObject('docs', { id, category: 'A' });
      await db.commit();
      const expected = await traverse(db, 'docs', 'category');
      const first = await fetchPageCursor(db, { collection: 'docs', iterableKey: 'category', limit: 2 });
      const backend = (db as unknown as { dbmsback: DbmsBack }).dbmsback;
      const relocated = await backend.relocateDocument('docs', 'b');
      expect(relocated.newBlockNumber).not.toBe(relocated.oldBlockNumber);
      for (const target of await backend.listBtreeRelocationTargets()) {
        if (target.collection === 'docs') {
          expect(await backend.relocateBtreeNode('docs', target.field!, target.blockNumber!)).not.toBe(
            target.blockNumber,
          );
        }
      }
      await db.commit();
      await db.close();
      db = await SimpleDbms.open(new RealFile(data), new RealFile(wal));
      const resumed = await fetchPageCursor(db, {
        collection: 'docs',
        iterableKey: 'category',
        limit: 10,
        afterCursor: first.nextCursor,
      });
      expect(ids([...first.data, ...resumed.data])).toEqual(expected);
      const compact = await db.vacuumCompactInto(
        new RealFile(path.join(directory, 'compact.db')),
        new RealFile(path.join(directory, 'compact.wal')),
      );
      try {
        expect(
          ids(
            (
              await fetchPageCursor(compact, {
                collection: 'docs',
                iterableKey: 'category',
                limit: 10,
                afterCursor: first.nextCursor,
              })
            ).data,
          ),
        ).toEqual(expected.slice(2));
      } finally {
        await compact.close();
      }
    } finally {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('untrusted cursor validation', () => {
  const token = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const position = { v: 1, collection: 'docs', field: 'category', form: 'SS', key: 'AAFB AAFh'.replace(/ /g, '') };

  it.each([
    ['empty', ''],
    ['legacy string', 'A'],
    ['legacy number', 1],
    ['invalid alphabet', '!'],
    ['noncanonical encoding', 'e30='],
    ['non-object', token(null)],
    ['incomplete', token({ v: 1 })],
    ['unsupported version', token({ ...position, v: 2 })],
    ['wrong collection', token({ ...position, collection: 'other' })],
    ['wrong field', token({ ...position, field: 'id' })],
    ['extra metadata', token({ ...position, pointer: 42 })],
    ['invalid encoded key', token({ ...position, key: '+' })],
    ['wrong key type', token({ ...position, key: 42 })],
    ['changed form', token({ ...position, form: 'SN' })],
    ['partial key', token({ ...position, key: Buffer.from([0, 1, 65]).toString('base64url') })],
    ['invalid UTF-8', token({ ...position, key: Buffer.from([0, 1, 0xff, 0, 1, 65]).toString('base64url') })],
    ['trailing bytes', token({ ...position, key: Buffer.from([0, 1, 65, 0, 1, 97, 0]).toString('base64url') })],
    ['too large', token({ ...position, key: Buffer.alloc(300).toString('base64url') })],
  ])('rejects %s before reading documents, keeping the database usable', async (_label, afterCursor) => {
    const db = await SimpleDbms.create(new MockFile(256), new MockFile(4096));
    try {
      await db.insertDocumentObject('docs', { id: 'a', category: 'A' });
      await db.insertDocumentObject('docs', { id: 'b', category: 'A' });
      const backend = (db as unknown as { dbmsback: DbmsBack }).dbmsback;
      const read = vi.spyOn(
        backend as unknown as { readIndexedDocument: () => Promise<unknown> },
        'readIndexedDocument',
      );
      await expect(
        fetchPageCursor(db, {
          collection: 'docs',
          iterableKey: 'category',
          limit: 1,
          afterCursor,
        }),
      ).rejects.toBeInstanceOf(InvalidCursorError);
      expect(read).not.toHaveBeenCalled();
      read.mockRestore();
      expect(db.isHealthy).toBe(true);
      expect(await traverse(db, 'docs', 'category')).toEqual(['a', 'b']);
    } finally {
      await db.close();
    }
  });

  it.each(['N', 'NN', 'NS', 'SN'])('rejects missing and non-finite numeric components in %s', async (form) => {
    const db = await SimpleDbms.create(new MockFile(256), new MockFile(4096));
    try {
      const collection = 'docs';
      const field = form === 'N' ? 'id' : 'value';
      const id = form.endsWith('S') ? 'a' : 1;
      await db.insertDocumentObject(collection, { id, value: form.startsWith('S') ? 'A' : 1 });
      for (const value of [NaN, Infinity, -Infinity]) {
        const number = Buffer.alloc(8);
        number.writeDoubleBE(value);
        const key =
          form === 'SN'
            ? Buffer.concat([Buffer.from([0, 1, 65]), number])
            : form === 'NN'
              ? Buffer.concat([number, Buffer.alloc(8)])
              : form === 'NS'
                ? Buffer.concat([number, Buffer.from([0, 1, 97])])
                : number;
        await expect(
          fetchPageCursor(db, {
            collection,
            iterableKey: field,
            limit: 1,
            afterCursor: token({ v: 1, collection, field, form, key: key.toString('base64url') }),
          }),
        ).rejects.toBeInstanceOf(InvalidCursorError);
      }
      await expect(
        fetchPageCursor(db, {
          collection,
          iterableKey: field,
          limit: 1,
          afterCursor: token({ v: 1, collection, field, form, key: '' }),
        }),
      ).rejects.toBeInstanceOf(InvalidCursorError);
    } finally {
      await db.close();
    }
  });

  it('rejects removed collections/indexes and permits resumption after rebuilding the same index', async () => {
    const db = await SimpleDbms.create(new MockFile(256), new MockFile(4096));
    try {
      for (const id of ['a', 'b', 'c']) await db.insertDocumentObject('docs', { id, category: 'A' });
      const first = await fetchPageCursor(db, { collection: 'docs', iterableKey: 'category', limit: 1 });
      await db.setFieldIndexed('docs', 'category', false);
      await expect(
        fetchPageCursor(db, {
          collection: 'docs',
          iterableKey: 'category',
          limit: 1,
          afterCursor: first.nextCursor,
        }),
      ).rejects.toBeInstanceOf(InvalidCursorError);
      await db.setFieldIndexed('docs', 'category', true);
      expect(
        ids(
          (
            await fetchPageCursor(db, {
              collection: 'docs',
              iterableKey: 'category',
              limit: 2,
              afterCursor: first.nextCursor,
            })
          ).data,
        ),
      ).toEqual(['b', 'c']);
      await db.deleteCollection('docs');
      await expect(
        fetchPageCursor(db, {
          collection: 'docs',
          iterableKey: 'category',
          limit: 1,
          afterCursor: first.nextCursor,
        }),
      ).rejects.toBeInstanceOf(InvalidCursorError);
      expect(db.isHealthy).toBe(true);
    } finally {
      await db.close();
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects page limit %j', async (limit) => {
    const db = await SimpleDbms.create(new MockFile(256), new MockFile(4096));
    try {
      await db.insertDocumentObject('docs', { id: 'a' });
      await expect(fetchPageCursor(db, { collection: 'docs', iterableKey: 'id', limit })).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
    } finally {
      await db.close();
    }
  });
});
