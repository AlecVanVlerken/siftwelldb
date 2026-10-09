import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../service.mjs';
import { SimpleDbms } from '../../../database/simpledbms.mjs';
import { DbmsBack } from '../../../database/dbmsback.mjs';

vi.mock('../embedding-config.mjs', () => ({
  getClipHnswConfig: () => ({
    dimension: 2,
    M: 4,
    efConstruction: 16,
    efSearch: 16,
    embeddingFn: (text: string) => Promise.resolve(new Float32Array(text.includes('second') ? [0, 1] : [1, 0])),
  }),
}));

type FakeDbms = {
  cursor: (collection: string, iterableKey: string, value?: string) => AsyncIterable<string>;
  deleteDocumentById: (collection: string, id: string) => Promise<void>;
  insertDocumentObject?: (collection: string, document: unknown) => Promise<void>;
  commit: () => Promise<void>;
};

type ServiceInternals = {
  dbms: FakeDbms | null;
  recordBytesCache: Map<string, number>;
};

function setFakeDbms(service: DatabaseService, dbms: FakeDbms): ServiceInternals {
  const internals = service as unknown as ServiceInternals;
  internals.dbms = dbms;
  internals.recordBytesCache = new Map();
  return internals;
}

function isDocumentRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function* documents(values: string[]): AsyncIterable<string> {
  for (const value of values) {
    await Promise.resolve();
    yield value;
  }
}

describe('DatabaseService', () => {
  it('returns the requested cursor page with the full collection count', async () => {
    const service = new DatabaseService();
    const seen: Array<[string, string, string | undefined]> = [];
    setFakeDbms(service, {
      cursor(collection, iterableKey, value) {
        seen.push([collection, iterableKey, value]);
        return documents([
          JSON.stringify({ id: 'a', title: 'A' }),
          JSON.stringify({ id: 'b', title: 'B' }),
          JSON.stringify({ id: 'c', title: 'C' }),
        ]);
      },
      deleteDocumentById() {
        return Promise.resolve();
      },
      commit() {
        return Promise.resolve();
      },
    });

    await expect(service.getDocuments('books', 'title', 'A', 2)).resolves.toEqual({
      documents: [JSON.stringify({ id: 'b', title: 'B' }), JSON.stringify({ id: 'c', title: 'C' })],
      hasMore: false,
      total: 3,
      nextCursor: undefined,
    });
    expect(seen).toEqual([
      ['books', 'id', undefined],
      ['books', 'title', 'A'],
    ]);
  });

  it('sorts documents numerically ascending when sortBy targets a number field', async () => {
    const service = new DatabaseService();
    setFakeDbms(service, {
      cursor() {
        return documents([
          JSON.stringify({ id: 'a', salary: 4200 }),
          JSON.stringify({ id: 'b', salary: 1000 }),
          JSON.stringify({ id: 'c', salary: 7800 }),
        ]);
      },
      deleteDocumentById() {
        return Promise.resolve();
      },
      commit() {
        return Promise.resolve();
      },
    });

    const result = await service.getDocuments('employees', 'id', undefined, 10, 'salary', 'asc');

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeUndefined();
    expect(result.documents.map((d) => (JSON.parse(d) as Record<string, unknown>)['salary'])).toEqual([
      1000, 4200, 7800,
    ]);
  });

  it('sorts documents alphabetically descending when sortBy targets a string field', async () => {
    const service = new DatabaseService();
    setFakeDbms(service, {
      cursor() {
        return documents([
          JSON.stringify({ id: 'a', name: 'Alice' }),
          JSON.stringify({ id: 'b', name: 'Charlie' }),
          JSON.stringify({ id: 'c', name: 'Bob' }),
        ]);
      },
      deleteDocumentById() {
        return Promise.resolve();
      },
      commit() {
        return Promise.resolve();
      },
    });

    const result = await service.getDocuments('employees', 'id', undefined, 10, 'name', 'desc');

    expect(result.documents.map((d) => (JSON.parse(d) as Record<string, unknown>)['name'])).toEqual([
      'Charlie',
      'Bob',
      'Alice',
    ]);
  });

  it('places nullish values first in ascending sort and applies the limit after sorting', async () => {
    const service = new DatabaseService();
    setFakeDbms(service, {
      cursor() {
        return documents([
          JSON.stringify({ id: 'a', salary: 4200 }),
          JSON.stringify({ id: 'b' }),
          JSON.stringify({ id: 'c', salary: 1000 }),
          JSON.stringify({ id: 'd', salary: null }),
        ]);
      },
      deleteDocumentById() {
        return Promise.resolve();
      },
      commit() {
        return Promise.resolve();
      },
    });

    const result = await service.getDocuments('employees', 'id', undefined, 3, 'salary', 'asc');

    expect(result.documents.map((d) => (JSON.parse(d) as Record<string, unknown>)['id'])).toEqual(['b', 'd', 'c']);
    expect(result).toMatchObject({ total: 4, hasMore: true });
    const next = await service.getDocuments('employees', 'id', undefined, 3, 'salary', 'asc', 3);
    expect(next.documents.map((d) => (JSON.parse(d) as Record<string, unknown>)['id'])).toEqual(['a']);
    expect(next).toMatchObject({ total: 4, hasMore: false });
  });

  it('commits document deletes and invalidates collection storage cache', async () => {
    const service = new DatabaseService();
    const calls: string[] = [];
    const internals = setFakeDbms(service, {
      cursor() {
        return documents([]);
      },
      async deleteDocumentById(collection, id) {
        await Promise.resolve();
        calls.push(`delete:${collection}:${id}`);
      },
      async commit() {
        await Promise.resolve();
        calls.push('commit');
      },
    });
    internals.recordBytesCache.set('books', 4096);

    await service.deleteDocument('books', 'b1');

    expect(calls).toEqual(['delete:books:b1', 'commit']);
    expect(internals.recordBytesCache.has('books')).toBe(false);
  });

  it('counts collections beyond the previous 100000-document cap', async () => {
    const service = new DatabaseService();
    setFakeDbms(service, {
      async *cursor() {
        await Promise.resolve();
        for (let i = 0; i < 100001; i++) yield `{"id":"${i}"}`;
      },
      deleteDocumentById() {
        return Promise.resolve();
      },
      commit() {
        return Promise.resolve();
      },
    });
    const result = await service.getDocuments('books', 'id', undefined, 1);
    expect(result.total).toBe(100001);
    expect(result.hasMore).toBe(true);
    expect(result.documents).toHaveLength(1);
  });

  it('seeds deterministic demo employees when the employees collection is empty', async () => {
    const service = new DatabaseService();
    const inserted: Array<Record<string, unknown>> = [];
    const internals = setFakeDbms(service, {
      cursor() {
        return documents([]);
      },
      deleteDocumentById() {
        return Promise.resolve();
      },
      insertDocumentObject(collection, document) {
        expect(collection).toBe('employees');
        if (!isDocumentRecord(document)) {
          return Promise.reject(new Error('Expected a document object'));
        }
        inserted.push(document);
        return Promise.resolve();
      },
      commit() {
        return Promise.resolve();
      },
    });
    internals.recordBytesCache.set('employees', 4096);

    const result = await service.seedDemoEmployees(3);

    expect(result).toEqual({ collection: 'employees', inserted: 3, skipped: false });
    expect(inserted).toHaveLength(3);
    expect(inserted[0]).toMatchObject({ id: 'emp001' });
    expect(typeof inserted[0]?.['department']).toBe('string');
    expect(internals.recordBytesCache.has('employees')).toBe(false);
  });

  it('skips demo seeding when employees already exist', async () => {
    const service = new DatabaseService();
    const inserted: Array<Record<string, unknown>> = [];
    setFakeDbms(service, {
      cursor() {
        return documents([JSON.stringify({ id: 'emp001' })]);
      },
      deleteDocumentById() {
        return Promise.resolve();
      },
      insertDocumentObject(_collection, document) {
        if (!isDocumentRecord(document)) {
          return Promise.reject(new Error('Expected a document object'));
        }
        inserted.push(document);
        return Promise.resolve();
      },
      commit() {
        return Promise.reject(new Error('commit should not be called'));
      },
    });

    const result = await service.seedDemoEmployees(3);

    expect(result).toEqual({ collection: 'employees', inserted: 0, skipped: true });
    expect(inserted).toHaveLength(0);
  });
});

describe('DatabaseService with real database files', () => {
  let directory: string;
  let filepath: string;
  let service: DatabaseService;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(tmpdir(), 'simpledbms-webclient-'));
    filepath = path.join(directory, 'database.db');
    service = new DatabaseService();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await service.disconnect();
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error('Unexpected test directory');
    await fs.rm(resolved, { recursive: true, force: true });
  });

  it('persists field controls, rejects failed builds, and clears settings when switching databases', async () => {
    await service.create(filepath);
    expect(await service.setFieldIndexed('articles', 'body', false)).toEqual({ id: true, body: false });
    await service.insertDocument('articles', { id: 'a', title: 'short', body: 'long text '.repeat(1000) });
    expect(await service.getFieldIndexConfig('articles')).toEqual({ id: true, title: true, body: false });
    await expect(service.setFieldIndexed('articles', 'body', true)).rejects.toThrow('maximum indexed key size');
    await service.replaceDocument('articles', 'a', { id: 'a', title: 'changed', body: 'new long text '.repeat(1000) });
    await service.setFieldIndexed('articles', 'title', false);
    expect((await service.query("SELECT id FROM articles WHERE title = 'changed'")).rows).toEqual([{ id: 'a' }]);
    await service.setFieldIndexed('articles', 'title', true);
    await service.disconnect();
    await service.connect(filepath);
    expect((await service.getCollectionStorage('articles')).fieldIndexes).toEqual({
      id: true,
      title: true,
      body: false,
    });
    await service.create(path.join(directory, 'other.db'));
    expect(await service.getFieldIndexConfig('articles')).toEqual({ id: true });
    await service.disconnect();
    await service.connect(filepath);
    expect((await service.getFieldIndexConfig('articles'))['body']).toBe(false);
  });

  it('persists CRUD and SQL writes across disconnect and reconnect', async () => {
    await service.create(filepath);
    await service.insertDocument('books', { id: 'b1', title: 'first book', pages: 100 });
    await service.insertDocument('books', { id: 'b2', title: 'second book', pages: 200 });
    await service.replaceDocument('books', 'b1', { id: 'b1', title: 'first revised', pages: 120 });
    await service.editDocument('books', 'b1', 'pages', 140);
    expect((await service.getDocuments('books', 'id', undefined, 1)).total).toBe(2);
    await service.deleteDocument('books', 'b2');
    const inserted = await service.query("INSERT INTO books VALUES {id: 'b3', title: 'second sequel', pages: 300}");
    expect(inserted).toMatchObject({ kind: 'insert', rowCount: 1 });
    const updated = await service.query("UPDATE books SET pages = 320 WHERE id = 'b3'");
    expect(updated).toMatchObject({ kind: 'update', rowCount: 1 });
    const deleted = await service.query("DELETE FROM books WHERE id = 'b1'");
    expect(deleted).toMatchObject({ kind: 'delete', rowCount: 1 });

    await service.disconnect();
    await expect(service.connect(filepath)).resolves.toBe('Connected to existing database');
    expect(JSON.parse(await service.getDocumentById('books', 'b3'))).toMatchObject({ pages: 320 });
    const selected = await service.query('SELECT id, pages FROM books');
    expect(selected).toMatchObject({ kind: 'select', rowCount: 1, rows: [{ id: 'b3', pages: 320 }] });
    expect((await service.getDocuments('books')).total).toBe(1);
    expect(await service.getCollectionStorage('books')).toMatchObject({
      documentCount: 1,
      indexedFields: ['id', 'title', 'pages'],
    });
  });

  it('returns complete page counts and preserves sorted and ordinary offset pages', async () => {
    await service.create(filepath);
    for (const [id, pages] of [
      ['b1', 30],
      ['b2', 10],
      ['b3', 20],
    ] as const) {
      await service.insertDocument('books', { id, pages });
    }
    const first = await service.getDocuments('books', 'id', undefined, 2, 'pages', 'asc', 0);
    expect(first).toMatchObject({ total: 3, hasMore: true });
    expect(first.documents.map((json) => (JSON.parse(json) as { id: string }).id)).toEqual(['b2', 'b3']);
    const next = await service.getDocuments('books', 'id', undefined, 2, 'pages', 'asc', 2);
    expect(next).toMatchObject({ total: 3, hasMore: false });
    expect(next.documents.map((json) => (JSON.parse(json) as { id: string }).id)).toEqual(['b1']);
    const ordinary = await service.getDocuments('books', 'id', undefined, 2, undefined, 'asc', 2);
    expect(ordinary.documents.map((json) => (JSON.parse(json) as { id: string }).id)).toEqual(['b3']);
  });

  it('reports database bytes separately from the WAL and exposes actual stored compression', async () => {
    await service.create(filepath);
    await service.setFieldIndexed('books', '_content', false);
    await service.insertDocument('books', { id: 'b1', _content: 'a'.repeat(12000) }, { _content: 'gzip' });
    const metadata = await service.getDocumentMetadata('books', 'b1');
    expect(metadata).toMatchObject({ blockSize: 4096, storedSize: 4096, compressions: { _content: 'gzip' } });
    await fs.writeFile(`${filepath}.log`, Buffer.alloc(512));
    const status = await service.getStatus();
    expect(status.size?.logFileBytes).toBe(512);
    expect(status.size?.totalBytes).toBe((await fs.stat(filepath)).size);
    expect(status.size?.totalBytes).toBe(status.size?.dataFileBytes);
  });

  it('bulk edits selected string and numeric IDs and preserves unrelated documents after reopening', async () => {
    await service.create(filepath);
    await service.insertDocument('books', { id: 'a', pages: 10, title: 'first' });
    await service.insertDocument('numeric_books', { id: 42, pages: 20, title: 'second' });
    await service.insertDocument('books', { id: 'untouched', pages: 30, title: 'first' });
    expect(await service.mutateDocuments('books', { ids: ['a', 'a'] }, { field: 'pages', value: 99 })).toEqual({
      affected: 1,
    });
    expect(await service.mutateDocuments('numeric_books', { ids: [42] }, { field: 'pages', value: 99 })).toEqual({
      affected: 1,
    });
    await service.disconnect();
    await service.connect(filepath);
    expect(JSON.parse(await service.getDocumentById('books', 'a'))).toMatchObject({ pages: 99 });
    expect(JSON.parse(await service.rawDbms.getDocumentById('numeric_books', 42))).toMatchObject({ id: 42, pages: 99 });
    expect(await service.mutateDocuments('numeric_books', { all: true })).toEqual({ affected: 1 });
    expect(JSON.parse(await service.getDocumentById('books', 'untouched'))).toMatchObject({ pages: 30 });
  });

  it('rejects invalid bulk edits before touching earlier targets', async () => {
    await service.create(filepath);
    await service.insertDocument('books', { id: 'a', title: 'first' });
    await service.insertDocument('books', { id: 'b', pages: 20 });
    await expect(service.mutateDocuments('books', { all: true }, { field: 'title', value: 'changed' })).rejects.toThrow(
      'missing',
    );
    expect(JSON.parse(await service.getDocumentById('books', 'a'))).toMatchObject({ title: 'first' });
    await expect(
      service.mutateDocuments('books', { ids: ['a'] }, { field: 'title', value: 'x'.repeat(2500) }),
    ).rejects.toThrow();
    expect(JSON.parse(await service.getDocumentById('books', 'a'))).toMatchObject({ title: 'first' });
    await expect(service.mutateDocuments('books', { ids: ['a', 'missing'] })).rejects.toThrow();
    expect((await service.getDocuments('books')).total).toBe(2);
  });

  it('collection-wide deletion includes unloaded pages and removes semantic results', async () => {
    await service.create(filepath);
    for (let i = 0; i < 105; i++) await service.insertDocument('books', { id: `b${i}`, title: 'first' });
    expect((await service.getDocuments('books', 'id', undefined, 100)).hasMore).toBe(true);
    expect(await service.mutateDocuments('books', { all: true })).toEqual({ affected: 105 });
    expect((await service.getDocuments('books')).total).toBe(0);
    expect(await service.semanticSearch('books', 'first', 10)).toEqual([]);
    await service.disconnect();
    await service.connect(filepath);
    expect((await service.getDocuments('books')).total).toBe(0);
  });

  it('Lab report includes optional fields appearing after the first sampled document', async () => {
    await service.create(filepath);
    await service.setFieldIndexed('books', '_notes', false);
    await service.insertDocument('books', { id: 'a', title: 'first' });
    await service.insertDocument('books', { id: 'b', title: 'second', _notes: 'notes '.repeat(1000) });
    const report = await service.recommendCollectionLab({ collection: 'books' });
    expect(report.perField.map((field) => field.field)).toContain('_notes');
  });

  it('resets the database selected when its queued operation begins', async () => {
    await service.create(filepath);
    await service.insertDocument('books', { id: 'b1', title: 'first' });
    const nextPath = path.join(directory, 'next.db');
    const switching = service.connect(nextPath);
    const resetting = service.reset();
    await Promise.all([switching, resetting]);
    expect(service.filepath).toBe(nextPath);
    await service.connect(filepath);
    expect(JSON.parse(await service.getDocumentById('books', 'b1'))).toMatchObject({ title: 'first' });
  });

  it('vacuum preserves contents and indexes and leaves no temporary or backup files', async () => {
    await service.create(filepath);
    await service.setFieldIndexed('books', '_payload', false);
    for (let i = 0; i < 8; i++) {
      await service.insertDocument('books', {
        id: `b${i}`,
        title: i % 2 ? 'second' : 'first',
        _payload: 'x'.repeat(8000),
      });
    }
    for (let i = 0; i < 6; i++) await service.deleteDocument('books', `b${i}`);
    const before = await service.getDocuments('books');
    const summary = await service.vacuum();
    expect(summary.bytesSaved).toBeGreaterThan(0);
    expect(await service.getDocuments('books')).toEqual(before);
    expect((await service.semanticSearch('books', 'second', 2)).length).toBe(2);
    expect(await fs.readdir(directory)).toEqual(expect.arrayContaining(['database.db', 'database.db.log']));
    expect((await fs.readdir(directory)).some((name) => name.includes('.vacuum-'))).toBe(false);
  });

  it('restores and reconnects the original pair if reopening the vacuum target fails', async () => {
    await service.create(filepath);
    await service.setFieldIndexed('books', '_payload', false);
    await service.insertDocument('books', { id: 'b1', title: 'first', _payload: 'x'.repeat(8000) });
    const originalBytes = await fs.readFile(filepath);
    vi.spyOn(SimpleDbms, 'open').mockRejectedValueOnce(new Error('Simulated target reopen failure'));
    await expect(service.vacuum()).rejects.toThrow('Simulated target reopen failure');
    expect(service.isConnected).toBe(true);
    expect(await fs.readFile(filepath)).toEqual(originalBytes);
    expect(JSON.parse(await service.getDocumentById('books', 'b1'))).toMatchObject({ title: 'first' });
    expect((await fs.readdir(directory)).some((name) => name.includes('.vacuum-'))).toBe(false);
  });

  it('closes temporary target handles and keeps the source connected if vacuum copy fails', async () => {
    await service.create(filepath);
    await service.insertDocument('books', { id: 'b1', title: 'first' });
    vi.spyOn(DbmsBack.prototype, 'insertDocument').mockRejectedValueOnce(new Error('Simulated copy failure'));
    await expect(service.vacuum()).rejects.toThrow('Simulated copy failure');
    expect(service.isConnected).toBe(true);
    expect(JSON.parse(await service.getDocumentById('books', 'b1'))).toMatchObject({ title: 'first' });
    expect((await fs.readdir(directory)).some((name) => name.includes('.vacuum-'))).toBe(false);
  });

  it('restores the data file if backing up the original WAL fails mid-swap', async () => {
    await service.create(filepath);
    await service.insertDocument('books', { id: 'b1', title: 'first' });
    const originalBytes = await fs.readFile(filepath);
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    const stamp = (123456).toString(36);
    // A real filesystem failure after the data file has already been backed up.
    const blockedBackup = `${filepath}.log.vacuum-${stamp}.bak`;
    await fs.mkdir(blockedBackup);
    await expect(service.vacuum()).rejects.toThrow();
    expect(service.isConnected).toBe(true);
    expect(await fs.readFile(filepath)).toEqual(originalBytes);
    expect(JSON.parse(await service.getDocumentById('books', 'b1'))).toMatchObject({ title: 'first' });
  });

  it('closes both file handles after an unsuccessful database open', async () => {
    await service.create(filepath);
    await service.disconnect();
    await fs.writeFile(filepath, 'invalid database');
    await expect(service.connect(filepath)).rejects.toThrow('Corrupt file');
    expect(service.isConnected).toBe(false);
    const moved = path.join(directory, 'invalid.db');
    await fs.rename(filepath, moved);
    await fs.rename(`${filepath}.log`, `${moved}.log`);
  });

  it('supports manual and automatic incremental checks without losing live documents', async () => {
    await service.create(filepath);
    await service.setFieldIndexed('books', '_payload', false);
    for (let i = 0; i < 6; i++)
      await service.insertDocument('books', { id: `b${i}`, title: 'first', _payload: 'x'.repeat(8000) });
    for (let i = 0; i < 4; i++) await service.deleteDocument('books', `b${i}`);
    const before = await service.getDocuments('books');
    const manual = await service.runIncrementalCompactionStep();
    expect(manual).toMatchObject({ running: false, lastError: null });
    expect(manual.lastRunAt).not.toBeNull();
    service.setIncrementalCompactionEnabled(true);
    await service.getCollections();
    service.setIncrementalCompactionEnabled(false);
    expect(await service.getDocuments('books')).toEqual(before);
    await service.disconnect();
    await service.connect(filepath);
    expect(await service.getDocuments('books')).toEqual(before);
  });

  it('invalidates Compression Lab storage totals when the collection is reseeded', async () => {
    await service.create(filepath);
    await service.seedWikiLab({ count: 2 });
    const before = await service.getCollectionStorage('wiki_lab');
    await service.seedWikiLab({ count: 4 });
    const after = await service.getCollectionStorage('wiki_lab');
    expect(after.documentCount).toBe(4);
    expect(after.recordBytes).toBeGreaterThan(before.recordBytes);
  });

  it('persists explicit compression defaults and applies them to future writes', async () => {
    await service.create(filepath);
    await service.setFieldIndexed('books', '_body', false);
    await service.insertDocument('books', { id: 'b1', _body: 'a'.repeat(8000) });
    await service.setCompressionDefaults('books', { _body: 'gzip' });
    await service.disconnect();
    await service.connect(filepath);
    expect(await service.getCompressionDefaults('books')).toEqual({ _body: 'gzip' });
    await service.insertDocument('books', { id: 'b2', _body: 'a'.repeat(8000) });
    expect((await service.getDocumentMetadata('books', 'b2')).compressions).toEqual({ _body: 'gzip' });
    expect((await service.getDocumentMetadata('books', 'b1')).compressions).toEqual({});
    await expect(service.setCompressionDefaults('books', { _body: 'invalid' } as never)).rejects.toThrow(
      'Invalid compression defaults',
    );
    await expect(service.setCompressionDefaults('missing', { _body: 'gzip' })).rejects.toThrow(
      'Collection does not exist',
    );
    expect(await service.getCompressionDefaults('books')).toEqual({ _body: 'gzip' });
  });

  it('rejects oversized indexed text before writing, while long unindexed compressed text remains supported', async () => {
    await service.create(filepath);
    const longBody = 'Vector database benchmarking and retrieval. '.repeat(100);
    await expect(
      service.insertDocument('notes', { id: 'note / 1%', title: 'first', body: longBody }, { body: 'gzip' }),
    ).rejects.toThrow(
      /Field "body" exceeds the maximum indexed key size.*disable indexing.*Compression does not reduce/,
    );
    expect(await service.getCollections()).toEqual([]);
    await service.insertDocument('notes', { id: 'note / 1%', title: 'first', body: 'short body' });
    await service.setFieldIndexed('notes', '_body', false);
    await service.insertDocument('notes', { id: 'b2', title: 'second', _body: longBody }, { _body: 'gzip' });
    expect((await service.getDocuments('notes')).total).toBe(2);
    expect(JSON.parse(await service.getDocumentById('notes', 'b2'))).toMatchObject({ _body: longBody });
    expect((await service.getDocumentMetadata('notes', 'b2')).compressions).toEqual({ _body: 'gzip' });
    await service.disconnect();
    await service.connect(filepath);
    expect((await service.getDocuments('notes')).total).toBe(2);
  });

  it('checks UTF-8 composite key bytes and leaves room for two large indexed values', async () => {
    await service.create(filepath);
    await expect(service.insertDocument('notes', { id: 'a', body: 'é'.repeat(1020) })).rejects.toThrow(
      'Field "body" exceeds the maximum indexed key size',
    );
    await expect(service.insertDocument('notes', { id: 'é'.repeat(1020), body: 'small' })).rejects.toThrow(
      'Field "id" exceeds the maximum indexed key size',
    );
    await service.insertDocument('notes', { id: 'a', body: 'a'.repeat(2000) });
    await service.insertDocument('notes', { id: 'b', body: 'b'.repeat(2000) });
    await service.disconnect();
    await service.connect(filepath);
    expect((await service.getDocuments('notes')).total).toBe(2);
  });

  it('preflights replacements, field edits and all SQL assignments before any mutation', async () => {
    await service.create(filepath);
    await service.insertDocument('notes', { id: 'n1', title: 'first', body: 'short', score: 5 });
    const body = 'x'.repeat(4200);
    await expect(
      service.replaceDocument('notes', 'n1', { id: 'n1', title: 'changed', body, score: 9 }),
    ).rejects.toThrow('Field "body" exceeds the maximum indexed key size');
    await expect(service.editDocument('notes', 'n1', 'body', body)).rejects.toThrow(
      'Field "body" exceeds the maximum indexed key size',
    );
    await expect(service.query(`INSERT INTO notes VALUES {id: 'failed', body: '${body}'}`)).rejects.toThrow(
      'Field "body" exceeds the maximum indexed key size',
    );
    await expect(service.query(`UPDATE notes SET score = 9, body = '${body}' WHERE id = 'n1'`)).rejects.toThrow(
      'Field "body" exceeds the maximum indexed key size',
    );
    expect(JSON.parse(await service.getDocumentById('notes', 'n1'))).toMatchObject({
      title: 'first',
      body: 'short',
      score: 5,
    });
    expect((await service.getDocuments('notes')).total).toBe(1);
    await service.insertDocument('notes', { id: 'failed', title: 'second', body: 'small', score: 2 });
    expect((await service.getDocuments('notes')).total).toBe(2);
  });

  it('preserves the Compression Lab title-only index policy on whole-document edits', async () => {
    await service.create(filepath);
    await service.seedWikiLab({ count: 1 });
    const page = await service.getDocuments('wiki_lab');
    const document = JSON.parse(page.documents[0]) as Record<string, unknown>;
    const id = String(document['id']);
    const body = 'long article text '.repeat(500);
    await service.replaceDocument('wiki_lab', id, { ...document, title: 'first revised', body }, { body: 'gzip' });
    expect(JSON.parse(await service.getDocumentById('wiki_lab', id))).toMatchObject({ title: 'first revised', body });
    expect((await service.getCollectionStorage('wiki_lab')).indexedFields).toEqual(['id', 'title']);
  });

  it('Lab reset replaces compressed samples with a raw baseline without appending documents', async () => {
    await service.create(filepath);
    await service.insertDocument('keep', { id: 'safe', title: 'untouched' });
    await service.seedWikiLab({ count: 2 });
    const baseline = await service.getCollectionStorage('wiki_lab');
    const original = await service.getDocuments('wiki_lab');
    await service.setCompressionDefaults('wiki_lab', { body: 'gzip' });
    for (const raw of original.documents) {
      const document = JSON.parse(raw) as Record<string, unknown>;
      await service.replaceDocument('wiki_lab', String(document['id']), document, { body: 'gzip' });
    }
    expect((await service.getCollectionStorage('wiki_lab')).recordBytes).toBeLessThan(baseline.recordBytes);
    await service.seedWikiLab({ count: 2 });
    expect(await service.getCompressionDefaults('wiki_lab')).toEqual({});
    expect((await service.getCollectionStorage('wiki_lab')).recordBytes).toBe(baseline.recordBytes);
    expect((await service.getDocuments('wiki_lab')).documents).toEqual(original.documents);
    await service.seedWikiLab({ count: 2 });
    expect((await service.getDocuments('wiki_lab')).total).toBe(2);
    expect((await service.getCollectionStorage('wiki_lab')).recordBytes).toBe(baseline.recordBytes);
    expect(JSON.parse(await service.getDocumentById('keep', 'safe'))).toMatchObject({ title: 'untouched' });
  });

  it('completes queued lab reports and applies advice without reentering the operation queue', async () => {
    await service.create(filepath);
    await service.setFieldIndexed('notes', '_body', false);
    await service.insertDocument('notes', { id: 'n1', title: 'A short note', _body: 'Repeated text. '.repeat(500) });
    const report = await service.recommendCollectionLab({ collection: 'notes', sampleSize: 10 });
    expect(report.perField.map((field) => field.field)).toContain('_body');
    const applied = await service.applyCollectionLabAdvice({ collection: 'notes', sampleSize: 10 });
    expect(applied.fields).toBe(report.perField.length);
    await service.disconnect();
    await service.connect(filepath);
    expect(await service.getCompressionDefaults('notes')).toEqual(applied.defaults);
    expect((await service.getDocuments('notes')).total).toBe(1);
  });
});
