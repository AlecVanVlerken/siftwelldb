import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { SimpleDbms } from '../../database/simpledbms.mjs';
import type { DbmsBack } from '../../database/dbmsback.mjs';
import type { RecordStore } from '../../storage/records/recordstore.mjs';
import { QueryLanguage } from '../querylanguage.mjs';
import { QueryMutationError } from '../executor.mjs';

let db: SimpleDbms;
let sql: QueryLanguage;
let data: MockFile;
let log: MockFile;
const backend = () => (db as unknown as { dbmsback: DbmsBack }).dbmsback;
const recordStore = () => (backend() as unknown as { recordStore: RecordStore }).recordStore;
const ids = async (query: string) => (await sql.execute(query)).map((r) => r['id']).sort();
beforeEach(async () => {
  data = new MockFile(4096);
  log = new MockFile(4096);
  db = await SimpleDbms.create(data, log);
  sql = new QueryLanguage(db);
  for (const document of [
    { id: 'a', team: 'A', score: 1 },
    { id: 'b', team: 'A', score: 2 },
    { id: 'c', team: 'B', score: 3 },
  ])
    await db.insertDocumentObject('docs', document);
});
afterEach(async () => {
  await db.commit();
  await db.close();
  vi.restoreAllMocks();
});

describe('query correctness regressions', () => {
  it('falls back when UTF-8 key encoding cannot preserve string-bound order', async () => {
    await db.insertDocumentObject('encoded', { id: 'a', tag: '\ue000' });
    await db.insertDocumentObject('encoded', { id: 'b', tag: '\uffff' });
    const query = "SELECT id FROM encoded WHERE tag > '\ud800' ORDER BY id";
    expect(await sql.execute(query)).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect((await sql.execute(`EXPLAIN ${query}`))[1]['detail']).toContain('full scan');
    await db.setFieldIndexed('encoded', 'tag', false);
    expect(await sql.execute(query)).toEqual([{ id: 'a' }, { id: 'b' }]);
    await db.insertDocumentObject('encodedids', { id: '\ud800', score: 1 });
    await db.insertDocumentObject('encodedids', { id: '\ue000', score: 2 });
    expect(await sql.execute("SELECT score FROM encodedids WHERE id < '\ue000'")).toEqual([{ score: 1 }]);
    await db.commit();
    await db.close();
    db = await SimpleDbms.open(data, log);
    sql = new QueryLanguage(db);
    expect(await sql.execute(query)).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(await sql.execute("SELECT score FROM encodedids WHERE id < '\ue000'")).toEqual([{ score: 1 }]);
  });
  it('preserves arbitrary binary fields and their stored type during SQL UPDATE and reopen', async () => {
    const bytes = Buffer.from([0, 255, 1, 128, 42]);
    await db.insertDocumentObject('binary', { id: 'a', title: 'old', payload: bytes });
    await db.editDocument('binary', 'a', 'title', 'direct');
    expect(Buffer.isBuffer((await db.getDocumentObjectById('binary', 'a'))['payload'])).toBe(true);
    await sql.execute("UPDATE binary SET title = 'sql' WHERE id = 'a'");
    expect(await db.getDocumentObjectById('binary', 'a')).toEqual({
      id: 'a',
      title: 'sql',
      payload: bytes,
    });
    await db.commit();
    await db.close();
    db = await SimpleDbms.open(data, log);
    sql = new QueryLanguage(db);
    expect((await db.getDocumentObjectById('binary', 'a'))['payload']).toEqual(bytes);
    expect(db.describeCollection('binary').map((field) => field.name)).not.toContain('payload');
  });
  it('treats prototype names as ordinary absent fields and preserves aliases named __proto__', async () => {
    expect(await ids('SELECT id FROM docs WHERE constructor IS NULL')).toEqual(['a', 'b', 'c']);
    expect(await sql.execute('SELECT COUNT(constructor) AS n FROM docs')).toEqual([{ n: 0 }]);
    const row = (await sql.execute("SELECT team AS __proto__ FROM docs WHERE id = 'a'"))[0];
    expect(Object.hasOwn(row, '__proto__')).toBe(true);
    expect(JSON.stringify(row)).toBe('{"__proto__":"A"}');
  });
  it('explains the actual DISTINCT/sort order and skips document reads for LIMIT 0', async () => {
    expect(
      (await sql.execute('EXPLAIN SELECT DISTINCT team FROM docs ORDER BY team LIMIT 1')).map((row) => row['stage']),
    ).toEqual(['collection', 'scan', 'project', 'distinct', 'sort', 'slice']);
    expect(
      (await sql.execute('EXPLAIN SELECT team FROM docs ORDER BY team LIMIT 1')).map((row) => row['stage']),
    ).toEqual(['collection', 'scan', 'sort', 'slice', 'project']);
    expect(await sql.execute('EXPLAIN SELECT * FROM docs LIMIT 0')).toEqual([
      { stage: 'collection', detail: 'docs' },
      { stage: 'scan', detail: 'no document reads (LIMIT 0)' },
    ]);
  });
  it.each([
    'DELETE FROM docs WHERE',
    'DELETE FROM docs WHERE ORDER BY id',
    'DELETE FROM docs LIMIT',
    'SELECT * FROM docs WHERE',
    'SELECT * FROM docs LIMIT',
    'SELECT * FROM docs ORDER BY',
    'SELECT id,,team FROM docs',
    'SELECT id, FROM docs',
    'SELECT * FROM docs ORDER BY id ASC nonsense',
    'SELECT * FROM docs LIMIT 1 WHERE score = 1',
    'SELECT * FROM docs WHERE score = 1 WHERE score = 2',
    'SELECT score * 2 FROM docs',
    'SELECT ABS(score) FROM docs',
    'SELECT SUM(*) FROM docs',
    'SELECT COUNT(DISTINCT *) FROM docs',
    'SELECT * FROM docs LIMIT 9007199254740992',
    'UPDATE docs SET score = 2,',
    'UPDATE docs SET score = 2, score = 3',
    'UPDATE docs SET score = 2 WHERE',
    'DELETE FROM docs; DELETE FROM docs',
  ])('rejects malformed SQL without changing documents: %s', async (query) => {
    await expect(sql.execute(query)).rejects.toThrow();
    expect(await sql.execute('SELECT * FROM docs')).toEqual([
      { id: 'a', team: 'A', score: 1 },
      { id: 'b', team: 'A', score: 2 },
      { id: 'c', team: 'B', score: 3 },
    ]);
  });
  it('supports numeric and empty-string IDs through insertion, updates, deletion and reopen', async () => {
    expect(await sql.execute('INSERT INTO numbers VALUES {id: 7, score: 1}')).toEqual([{ id: 7 }]);
    expect(await sql.execute("INSERT INTO emptyids VALUES {id: '', score: 1}")).toEqual([{ id: '' }]);
    expect(await sql.execute('UPDATE numbers SET score = 2 WHERE id = 7')).toEqual([{ id: 7 }]);
    expect(await sql.execute('SELECT * FROM numbers WHERE score = 2')).toEqual([{ id: 7, score: 2 }]);
    await db.commit();
    await db.close();
    db = await SimpleDbms.open(data, log);
    sql = new QueryLanguage(db);
    expect(await sql.execute('SELECT * FROM numbers WHERE id = 7')).toEqual([{ id: 7, score: 2 }]);
    expect(await sql.execute('DELETE FROM numbers WHERE id = 7')).toEqual([{ id: 7 }]);
    expect(await sql.execute("DELETE FROM emptyids WHERE id = ''")).toEqual([{ id: '' }]);
    expect(await sql.execute('SELECT * FROM numbers')).toEqual([]);
  });
  it('preserves quoted text, SQL keywords, braces, commas and newlines', async () => {
    await db.setFieldIndexed('docs', 'note', false);
    const value = "O'Brien, some where text (a) {key: 1}\nsecond line";
    expect(await sql.execute(`INSERT INTO docs VALUES {id: 'd', note: '${value.replaceAll("'", "''")}'}`)).toEqual([
      { id: 'd' },
    ]);
    expect(await ids("SELECT id FROM docs WHERE note CONTAINS 'second' AND NOT(score = 1) OR id = 'd'")).toEqual(['d']);
    await sql.execute("UPDATE docs SET note = 'some where text, O''Brien' WHERE id = 'd'");
    expect(await sql.execute("SELECT note FROM docs WHERE id = 'd'")).toEqual([{ note: "some where text, O'Brien" }]);
    expect(await ids('SELECT id FROM docs WHERE NOT(score = 1)AND(score < 3)')).toEqual(['b']);
  });
  it('resolves HAVING aliases and aggregates used only in HAVING or ORDER BY', async () => {
    expect(
      await sql.execute('SELECT team, count( * ) AS n FROM docs GROUP BY team HAVING n > 1 ORDER BY n DESC'),
    ).toEqual([{ team: 'A', n: 2 }]);
    expect(
      await sql.execute(
        'SELECT team FROM docs GROUP BY team HAVING count( distinct score ) > 1 ORDER BY COUNT( * ) DESC',
      ),
    ).toEqual([{ team: 'A' }]);
    expect(
      await sql.execute(
        'SELECT COUNT(DISTINCT team) AS n FROM docs HAVING count( DISTINCT team ) = 2 ORDER BY count( distinct team )',
      ),
    ).toEqual([{ n: 2 }]);
  });
  it('returns one global aggregate row for empty input and no grouped rows', async () => {
    expect(
      await sql.execute(
        'SELECT COUNT(*) AS n, SUM(score) AS total, AVG(score) AS avg, MIN(score) AS lo, MAX(score) AS hi FROM docs WHERE score > 100',
      ),
    ).toEqual([{ n: 0, total: null, avg: null, lo: null, hi: null }]);
    expect(await sql.execute('SELECT team, COUNT(*) FROM docs WHERE score > 100 GROUP BY team')).toEqual([]);
  });
  it('uses literal CONTAINS and separate LIKE wildcards/escapes across newlines', async () => {
    await db.setFieldIndexed('text', 'body', false);
    for (const [id, body] of [
      ['a', 'literal a_b % .*[]\nsecond'],
      ['b', 'axb'],
      ['c', '😀'],
    ])
      await db.insertDocumentObject('text', { id, body });
    for (const value of ['a_b', '%', '.*[]', 'SECOND'])
      expect(await ids(`SELECT id FROM text WHERE body CONTAINS '${value}'`)).toEqual(['a']);
    expect(await ids("SELECT id FROM text WHERE body LIKE '%a_b%'")).toEqual(['a', 'b']);
    expect(await ids(String.raw`SELECT id FROM text WHERE body LIKE '%a\_b%'`)).toEqual(['a']);
    expect(await ids("SELECT id FROM text WHERE body LIKE '_'")).toEqual(['c']);
  });
  it.each(["team != 'A'", "team NOT IN ('A')", "NOT(team = 'A')", "team NOT LIKE 'A'", "team NOT BETWEEN 'A' AND 'A'"])(
    'excludes absent fields under negated predicates: %s',
    async (predicate) => {
      await db.insertDocumentObject('docs', { id: 'missing' });
      expect(await ids(`SELECT id FROM docs WHERE ${predicate}`)).toEqual(['c']);
      expect(await ids('SELECT id FROM docs WHERE team IS NULL')).toEqual(['missing']);
    },
  );
  it('keeps indexed and unindexed strict equality results identical, including numeric/boolean key collisions', async () => {
    await db.insertDocumentObject('mixed', { id: 1, flag: true });
    await db.insertDocumentObject('mixed', { id: 2, flag: 1 });
    expect(await ids('SELECT id FROM docs WHERE team = 1')).toEqual([]);
    expect(await ids('SELECT id FROM docs WHERE id = 1')).toEqual([]);
    expect(await ids('SELECT id FROM mixed WHERE flag = true')).toEqual([1]);
    expect(await ids('SELECT id FROM mixed WHERE flag = 1')).toEqual([2]);
    await db.setFieldIndexed('docs', 'team', false);
    await db.setFieldIndexed('mixed', 'flag', false);
    expect(await ids('SELECT id FROM docs WHERE team = 1')).toEqual([]);
    expect(await ids('SELECT id FROM mixed WHERE flag = true')).toEqual([1]);
    expect(await ids('SELECT id FROM mixed WHERE flag = 1')).toEqual([2]);
  });
  it('preflights all final documents before changing any and forbids adding fields', async () => {
    await expect(sql.execute(`UPDATE docs SET score = 9, team = '${'x'.repeat(4200)}'`)).rejects.toThrow(
      'maximum indexed key size',
    );
    await expect(sql.execute('UPDATE docs SET missing = 1')).rejects.toThrow('cannot be edited');
    expect(await sql.execute('SELECT score FROM docs ORDER BY id')).toEqual([{ score: 1 }, { score: 2 }, { score: 3 }]);
    await db.insertDocumentObject('docs', { id: 'd', score: 4 });
    await expect(sql.execute("UPDATE docs SET score = 9, team = 'C'")).rejects.toThrow('cannot be edited');
    expect(await sql.execute('SELECT score FROM docs ORDER BY id')).toEqual([
      { score: 1 },
      { score: 2 },
      { score: 3 },
      { score: 4 },
    ]);
  });
  it('performs one semantic replacement and preserves numeric ID, binary data, compression and persisted indexes', async () => {
    await db.commit();
    await db.close();
    const embedding = vi.fn(() => Promise.resolve(new Float32Array([0, 1])));
    const config = { dimension: 2, embeddingFn: embedding };
    db = await SimpleDbms.create(new MockFile(4096), new MockFile(4096), config);
    sql = new QueryLanguage(db);
    await db.setFieldIndexed('articles', 'body', false);
    const body = 'long text '.repeat(500);
    await db.insertDocumentObject(
      'articles',
      { id: 42, title: 'old', body, 'photo.png': Buffer.from('bytes') },
      { compression: { body: 'gzip' } },
    );
    embedding.mockClear();
    const updatedBody = 'some where text '.repeat(500);
    expect(await sql.execute(`UPDATE articles SET title = 'new', body = '${updatedBody}' WHERE id = 42`)).toEqual([
      { id: 42 },
    ]);
    expect(embedding).toHaveBeenCalledTimes(1);
    const nodes = await backend().inspectHnswGraphStructure('articles');
    expect(nodes.filter((node) => !node.deleted)).toHaveLength(1);
    expect(nodes.filter((node) => node.deleted)).toHaveLength(1);
    expect(JSON.parse(await db.getDocumentById('articles', 42))).toEqual({
      id: 42,
      title: 'new',
      body: updatedBody,
      'photo.png': Buffer.from('bytes').toString('base64'),
    });
    const encoded = JSON.parse(await db.getDocumentById('articles', 42, { encoded: true })) as {
      body: { compression: string };
    };
    expect(encoded.body.compression).toBe('gzip');
    expect(await ids("SELECT id FROM articles WHERE title = 'new'")).toEqual([42]);
    await sql.execute('DELETE FROM articles WHERE id = 42');
    expect(await db.semanticSearch('articles', 'new', 10)).toEqual([]);
  });
  it('preserves a document on encoder failure and explicitly reports prior completed documents', async () => {
    await db.commit();
    await db.close();
    let calls = 0;
    const embedding = () => {
      if (++calls === 4) return Promise.reject(new Error('encoder offline'));
      return Promise.resolve(new Float32Array([0, 1]));
    };
    data = new MockFile(4096);
    log = new MockFile(4096);
    const config = { dimension: 2, embeddingFn: embedding };
    db = await SimpleDbms.create(data, log, config);
    sql = new QueryLanguage(db);
    await db.insertDocumentObject('docs', { id: 'a', title: 'old', body: 'old' });
    await db.insertDocumentObject('docs', { id: 'b', title: 'old', body: 'old' });
    try {
      await sql.execute("UPDATE docs SET title = 'new', body = 'new'");
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(QueryMutationError);
      expect((error as QueryMutationError).affectedIds).toEqual(['a']);
      expect((error as Error).message).toContain('Partial changes may be staged');
    }
    expect(await sql.execute('SELECT * FROM docs ORDER BY id')).toEqual([
      { id: 'a', title: 'new', body: 'new' },
      { id: 'b', title: 'old', body: 'old' },
    ]);
    // Deliberately commit the known partial result, then verify recoverability.
    await db.commit();
    await db.close();
    db = await SimpleDbms.open(data, log, config);
    sql = new QueryLanguage(db);
    expect(await sql.execute('SELECT * FROM docs ORDER BY id')).toEqual([
      { id: 'a', title: 'new', body: 'new' },
      { id: 'b', title: 'old', body: 'old' },
    ]);
    await sql.execute("UPDATE docs SET title = 'recovered' WHERE id = 'b'");
    expect(await ids("SELECT id FROM docs WHERE title = 'recovered'")).toEqual(['b']);
    const semanticRows = (await db.semanticSearch('docs', 'new', 10)).map(
      (row) => JSON.parse(row) as Record<string, unknown>,
    );
    expect(semanticRows.sort((a, b) => String(a['id']).localeCompare(String(b['id'])))).toEqual([
      { id: 'a', title: 'new', body: 'new' },
      { id: 'b', title: 'recovered', body: 'old' },
    ]);
  });
  it('bounds exact and LIMIT reads while preserving global sort, grouping and DISTINCT', async () => {
    const read = vi.spyOn(recordStore(), 'readRecord');
    expect(await ids("SELECT id FROM docs WHERE score = 1 AND id = 'a'")).toEqual(['a']);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockClear();
    expect(await sql.execute("SELECT id FROM docs WHERE id = 'absent'")).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    read.mockClear();
    expect(await sql.execute('SELECT id FROM docs LIMIT 1')).toEqual([{ id: 'a' }]);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockClear();
    expect(await sql.execute('SELECT id FROM docs LIMIT 0')).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(await sql.execute('SELECT id FROM docs ORDER BY score DESC LIMIT 1')).toEqual([{ id: 'c' }]);
    expect(await sql.execute('SELECT DISTINCT team FROM docs ORDER BY team DESC LIMIT 1')).toEqual([{ team: 'B' }]);
    expect(await sql.execute('SELECT COUNT(*) AS n FROM docs LIMIT 1')).toEqual([{ n: 3 }]);
  });
  it('uses bounded string ranges with duplicates and agrees with a scan after index removal', async () => {
    for (let i = 0; i < 40; i++)
      await db.insertDocumentObject('range', { id: i, tag: String(Math.floor(i / 2)).padStart(2, '0') });
    const read = vi.spyOn(recordStore(), 'readRecord');
    const query = "SELECT id FROM range WHERE tag > '05' AND tag <= '07' ORDER BY id";
    expect(await ids(query)).toEqual([12, 13, 14, 15]);
    expect(read.mock.calls.length).toBeLessThan(10);
    const explain = await sql.execute(`EXPLAIN ${query}`);
    expect(explain.find((r) => r['stage'] === 'scan')?.['detail']).toContain('bounded index range');
    await db.setFieldIndexed('range', 'tag', false);
    expect(await ids(query)).toEqual([12, 13, 14, 15]);
    read.mockClear();
    expect(await sql.execute('SELECT id FROM range WHERE id > 12 AND id <= 15 ORDER BY id')).toEqual([
      { id: 13 },
      { id: 14 },
      { id: 15 },
    ]);
    expect(read.mock.calls.length).toBeLessThan(6);
  });
  it('keeps Unicode, empty-string and prefix bounds equivalent across index changes and reopen', async () => {
    const values = ['', '\u0000', 'A', 'AA', 'A\u0000', 'B', '\u00e9', '\uffff', '\u{1f600}'];
    for (let i = 0; i < values.length; i++) await db.insertDocumentObject('unicode', { id: i, tag: values[i] });
    const queries = [
      "SELECT id FROM unicode WHERE tag > 'A' AND tag <= 'B' ORDER BY id",
      "SELECT id FROM unicode WHERE tag BETWEEN '' AND 'A' ORDER BY id",
      `SELECT id FROM unicode WHERE tag >= '${values[7]}' ORDER BY id`,
      "SELECT id FROM unicode WHERE tag < 'AA' ORDER BY id",
    ];
    const expected = [
      [{ id: 3 }, { id: 4 }, { id: 5 }],
      [{ id: 0 }, { id: 1 }, { id: 2 }],
      [{ id: 7 }, { id: 8 }],
      [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 4 }],
    ];
    for (let i = 0; i < queries.length; i++) expect(await sql.execute(queries[i])).toEqual(expected[i]);
    await db.setFieldIndexed('unicode', 'tag', false);
    for (let i = 0; i < queries.length; i++) expect(await sql.execute(queries[i])).toEqual(expected[i]);
    await db.commit();
    await db.close();
    db = await SimpleDbms.open(data, log);
    sql = new QueryLanguage(db);
    for (let i = 0; i < queries.length; i++) expect(await sql.execute(queries[i])).toEqual(expected[i]);
    await db.setFieldIndexed('unicode', 'tag', true);
    for (let i = 0; i < queries.length; i++) expect(await sql.execute(queries[i])).toEqual(expected[i]);
  });
  it('reports completed IDs after replacement/deletion failures and persists consistent subsequent writes', async () => {
    const realReplace = db.replaceDocument.bind(db);
    const replace = vi.spyOn(db, 'replaceDocument');
    // Inject before the second replacement; the first has completed normally.
    let count = 0;
    replace.mockImplementation(async (...args) => {
      if (++count === 2) throw new Error('replacement offline');
      await realReplace(...args);
    });
    await expect(sql.execute('UPDATE docs SET score = 9')).rejects.toMatchObject({ affectedIds: ['a'] });
    replace.mockRestore();
    expect(await sql.execute('SELECT id, score FROM docs ORDER BY id')).toEqual([
      { id: 'a', score: 9 },
      { id: 'b', score: 2 },
      { id: 'c', score: 3 },
    ]);
    const remove = vi.spyOn(db, 'deleteDocumentById');
    const realRemove = backend().deleteDocument.bind(backend());
    let deleted = 0;
    remove.mockImplementation(async (collection, id) => {
      if (++deleted === 2) throw new Error('delete offline');
      await realRemove(id, collection);
    });
    await expect(sql.execute('DELETE FROM docs')).rejects.toMatchObject({ affectedIds: ['a'] });
    remove.mockRestore();
    await sql.execute("UPDATE docs SET score = 7 WHERE id = 'b'");
    await db.commit();
    await db.close();
    db = await SimpleDbms.open(data, log);
    sql = new QueryLanguage(db);
    expect(await sql.execute('SELECT id, score FROM docs ORDER BY id')).toEqual([
      { id: 'b', score: 7 },
      { id: 'c', score: 3 },
    ]);
    expect(await ids('SELECT id FROM docs WHERE score = 9')).toEqual([]);
    expect(await ids('SELECT id FROM docs WHERE score = 7')).toEqual(['b']);
  });
});
