import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SimpleDbms } from '../../database/simpledbms.mjs';
import type { DbmsBack } from '../../database/dbmsback.mjs';
import { RealFile } from '../../storage/file.mjs';
import { vacuumCompactInto } from '../../compaction/compaction.mjs';
import { QueryLanguage } from '../querylanguage.mjs';
import type { QueryResultRow } from '../ast.mjs';
import type { EncodedFieldEntry } from '../../storage/records/recordstore.mjs';

const decodedRow = (json: string) => JSON.parse(json) as QueryResultRow;
const storedFields = (json: string) => JSON.parse(json) as Record<string, Omit<EncodedFieldEntry, 'key'>>;

describe('SQL cross-feature persistence', () => {
  it('preserves binary/codecs, indexes, semantic isolation and tombstones through relocation and vacuum on real files', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'siftwell-sql-integration-'));
    let data = new RealFile(path.join(directory, 'data.db'));
    let log = new RealFile(path.join(directory, 'data.log'));
    const vector = (text: string) =>
      new Float32Array([text.includes('rabbit') ? 0 : text.includes('fox') ? 10 : 20, 1, 0, 0]);
    const embed = vi.fn((text: string) => Promise.resolve(vector(text)));
    const imageEmbed = vi.fn((bytes: Buffer) => Promise.resolve(new Float32Array([bytes[0], 0, 1, 0])));
    const textIndex = { dimension: 4, embeddingFn: embed, M: 4, efConstruction: 32, efSearch: 32 };
    const config = { ...textIndex, textIndex, imageIndex: { ...textIndex, imageEmbeddingFn: imageEmbed } };
    let db = await SimpleDbms.create(data, log, config);
    let sql = new QueryLanguage(db);
    const backend = () => (db as unknown as { dbmsback: DbmsBack }).dbmsback;
    const bytes = Buffer.from([0, 255, 128, 1, 2]);
    const image = Buffer.from([3, 255, 0, 128]);
    const text = 'rabbit long unindexed text '.repeat(300);
    const compressed = 'compressed metadata '.repeat(300);
    const plain = 'uncompressed metadata '.repeat(300);
    try {
      // Free holes below the records and graphs force actual relocation.
      for (let i = 0; i < 18; i++)
        await db.insertDocumentObject(
          'filler',
          { id: i, payload: Buffer.alloc(12000, i) },
          { skipSemanticIndex: true },
        );
      for (const field of ['body', 'compressed', 'plain']) await db.setFieldIndexed('articles', field, false);
      db.setFieldCompressionDefaults('articles', { body: 'deflate', compressed: 'gzip' });
      await db.insertDocumentObject(
        'articles',
        {
          id: 42,
          title: 'old',
          score: 1,
          active: true,
          body: text,
          compressed,
          plain,
          payload: bytes,
          'photo.png': image,
        },
        { compression: { body: 'gzip', compressed: 'deflate' } },
      );
      await sql.execute("INSERT INTO articles VALUES {id: 43, title: 'fox', score: 2, active: false, body: 'fox'}");
      await sql.execute("INSERT INTO articles VALUES {id: 44, title: 'tiger', score: 3, active: true, body: 'tiger'}");
      await db.setFieldIndexed('other', 'body', false);
      await sql.execute("INSERT INTO other VALUES {id: 42, title: 'isolated', body: 'rabbit other collection'}");
      await sql.execute("INSERT INTO empty VALUES {id: 1, title: 'rabbit'}");
      await db.commit();
      expect(decodedRow((await db.semanticSearch('articles', 'rabbit', 1))[0])['id']).toBe(42);
      expect(decodedRow((await db.semanticImageSearch('articles', image, 1))[0])['id']).toBe(42);
      const encodedBefore = storedFields(await db.getDocumentById('articles', 42, { encoded: true }));
      expect(encodedBefore['body'].compression).toBe('gzip');
      expect(encodedBefore['compressed'].compression).toBe('deflate');
      expect(encodedBefore['plain'].compression).toBe('none');
      embed.mockClear();
      imageEmbed.mockClear();
      await sql.execute("UPDATE articles SET title = 'new', score = 9, active = false WHERE id = 42");
      expect(embed).toHaveBeenCalledTimes(1);
      expect(imageEmbed).toHaveBeenCalledTimes(1);
      expect(await db.getDocumentObjectById('articles', 42)).toEqual({
        id: 42,
        title: 'new',
        score: 9,
        active: false,
        body: text,
        compressed,
        plain,
        payload: bytes,
        'photo.png': image,
      });
      const query = "SELECT id FROM articles WHERE title = 'new' ORDER BY id";
      expect(await sql.execute(query)).toEqual([{ id: 42 }]);
      expect(await sql.execute("SELECT id FROM articles WHERE title = 'old'")).toEqual([]);
      await db.setFieldIndexed('articles', 'title', false);
      expect(await sql.execute(query)).toEqual([{ id: 42 }]);
      await db.setFieldIndexed('articles', 'title', true);
      expect(await sql.execute(query)).toEqual([{ id: 42 }]);
      await sql.execute("UPDATE articles SET body = 'fox changed text' WHERE id = 42");
      expect(decodedRow((await db.semanticSearch('articles', 'fox', 1))[0])['body']).toContain('fox');
      await sql.execute('DELETE FROM articles WHERE id = 43');
      await sql.execute('DELETE FROM empty WHERE id = 1');
      await sql.execute('DELETE FROM filler');
      await db.commit();
      const expected = await db.getDocumentObjectById('articles', 42);
      const encoded = storedFields(await db.getDocumentById('articles', 42, { encoded: true }));
      const graph = await backend().inspectHnswGraphStructure('articles::text');
      expect(graph.some((node) => node.deleted)).toBe(true);
      const semantic = await db.semanticSearch('articles', 'fox', 10);
      expect(semantic.map((row) => decodedRow(row)['id']).sort()).toEqual([42, 44]);
      const check = async () => {
        expect(await db.getDocumentObjectById('articles', 42)).toEqual(expected);
        expect(JSON.parse(await db.getDocumentById('articles', 42, { encoded: true }))).toEqual(encoded);
        expect(await sql.execute(query)).toEqual([{ id: 42 }]);
        expect(await sql.execute('SELECT id FROM articles ORDER BY id')).toEqual([{ id: 42 }, { id: 44 }]);
        expect(await db.semanticSearch('articles', 'fox', 10)).toEqual(semantic);
        expect(JSON.parse((await db.semanticSearch('other', 'rabbit', 10))[0])).toEqual({
          id: 42,
          title: 'isolated',
          body: 'rabbit other collection',
        });
        expect(await db.semanticSearch('empty', 'rabbit', 10)).toEqual([]);
        expect(await db.getDocumentObjectById('other', 42)).toEqual({
          id: 42,
          title: 'isolated',
          body: 'rabbit other collection',
        });
        expect((await db.semanticImageSearch('articles', image, 10)).map((row) => decodedRow(row)['id'])).toEqual([42]);
        expect(db.getFieldIndexConfig('articles')['body']).toBe(false);
        expect(db.getFieldCompressionDefaults('articles')).toEqual({ body: 'deflate', compressed: 'gzip' });
      };
      const reopen = async () => {
        await db.close();
        db = await SimpleDbms.open(data, log, config);
        sql = new QueryLanguage(db);
      };
      await reopen();
      await check();
      const result = await db.compactIfNeeded({
        maxAmplification: 1.05,
        softAmplification: 1.05,
        targetBatchDocuments: 8,
        targetBatchUnits: 8,
        maxStepsPerRun: 80,
      });
      expect(result?.didWork).toBe(true);
      expect(result?.relocatedDocuments).toBeGreaterThan(0);
      expect(result?.relocatedBtreeNodes).toBeGreaterThan(0);
      expect(result?.relocatedHnswUnits).toBeGreaterThan(0);
      await db.commit();
      await check();
      await reopen();
      await check();
      expect((await backend().inspectHnswGraphStructure('articles::text')).filter((node) => node.deleted)).toHaveLength(
        graph.filter((node) => node.deleted).length,
      );
      const vacuumData = new RealFile(path.join(directory, 'vacuum.db'));
      const vacuumLog = new RealFile(path.join(directory, 'vacuum.log'));
      const vacuum = await vacuumCompactInto({
        source: backend(),
        tempDataFile: vacuumData,
        tempLogFile: vacuumLog,
        validate: true,
        rebuildHnsw: true,
      });
      await vacuum.target.commit();
      await vacuum.target.close();
      await db.close();
      data = vacuumData;
      log = vacuumLog;
      db = await SimpleDbms.open(data, log, config);
      sql = new QueryLanguage(db);
      await check();
      expect((await backend().inspectHnswGraphStructure('articles::text')).every((node) => !node.deleted)).toBe(true);
      expect(await backend().inspectHnswGraphStructure('empty::text')).toEqual([]);
    } finally {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});
