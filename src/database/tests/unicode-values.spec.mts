import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimpleDbms } from '../simpledbms.mjs';
import { DbmsBack } from '../dbmsback.mjs';
import { Document } from '../document.mjs';
import { RealFile } from '../../storage/file.mjs';
import { FreeBlockFile } from '../../storage/blocks/freeblockfile.mjs';
import { RecordStore } from '../../storage/records/recordstore.mjs';
import { QueryLanguage } from '../../query/querylanguage.mjs';
import { bulkImportArray } from '../bulkimport.mjs';

const directories: string[] = [];
const databases: SimpleDbms[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await db.close();
  for (const directory of directories.splice(0)) {
    if (!path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep))
      throw new Error('Unexpected test directory');
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'siftwell-unicode-values-'));
  directories.push(directory);
  const data = path.join(directory, 'source.db'),
    log = data + '.log';
  const embeddingFn = vi.fn(() => Promise.resolve(new Float32Array([1, 0])));
  const db = await SimpleDbms.create(new RealFile(data), new RealFile(log), { dimension: 2, embeddingFn, M: 4 });
  databases.push(db);
  await db.setFieldIndexed('docs', 'unindexed', false);
  await db.insertDocumentObject('docs', {
    id: 'a',
    indexed: 'original',
    unindexed: 'original',
    payload: Buffer.from([0, 255]),
  });
  await db.commit();
  embeddingFn.mockClear();
  return { db, data, log, embeddingFn };
}

describe('Unicode values before mutation', () => {
  it.each(['\uD800', '\uDFFF', 'before\uD800after', 'abc\uDC00xyz'])(
    'rejects malformed strings across write paths without changing records or indexes: %j',
    async (invalid) => {
      const { db, data, log, embeddingFn } = await fixture();
      const before = await Promise.all([fs.readFile(data), fs.readFile(log)]);
      const stored = await db.getDocumentById('docs', 'a', { encoded: true });
      const backend = (db as unknown as { dbmsback: DbmsBack }).dbmsback;
      const file = (backend as unknown as { freeblockFile: FreeBlockFile }).freeblockFile;
      const allocate = vi.spyOn(file, 'allocateBlock');
      const ql = new QueryLanguage(db);
      for (const field of ['indexed', 'unindexed']) {
        await expect(db.insertDocumentObject('docs', { id: 'bad', [field]: invalid })).rejects.toThrow(
          /unpaired UTF-16/,
        );
        await expect(db.editDocument('docs', 'a', field, invalid)).rejects.toThrow(/unpaired UTF-16/);
        await expect(db.replaceDocument('docs', 'a', { id: 'a', [field]: invalid })).rejects.toThrow(/unpaired UTF-16/);
        await expect(
          ql.execute(`UPDATE docs SET ${field} = ${JSON.stringify(invalid)} WHERE id = 'a'`),
        ).rejects.toThrow(/unpaired UTF-16/);
        await expect(
          ql.execute(`INSERT INTO docs VALUES {id: 'bad', ${field}: ${JSON.stringify(invalid)}}`),
        ).rejects.toThrow(/unpaired UTF-16/);
      }
      const document = new Document('docs', 'bad', [], [['unindexed', invalid]]);
      await expect(backend.insertDocument(document)).rejects.toThrow(/unpaired UTF-16/);
      await expect(new RecordStore(file).writeRecord(document)).rejects.toThrow(/unpaired UTF-16/);
      const imported = await bulkImportArray(db, [{ id: 'bad', unindexed: invalid }], { collection: 'docs' });
      expect(imported).toMatchObject({ totalImported: 0, failedCount: 1 });
      expect(allocate).not.toHaveBeenCalled();
      expect(embeddingFn).not.toHaveBeenCalled();
      expect(await db.getDocumentById('docs', 'a', { encoded: true })).toBe(stored);
      expect(await Promise.all([fs.readFile(data), fs.readFile(log)])).toEqual(before);
      expect(await ql.execute("SELECT id FROM docs WHERE indexed = 'original'")).toEqual([{ id: 'a' }]);
      expect(db.isHealthy).toBe(true);
      await db.reopen(new RealFile(data), new RealFile(log));
      expect(await db.getDocumentById('docs', 'a', { encoded: true })).toBe(stored);
      expect((await db.semanticSearch('docs', 'original', 1)).length).toBe(1);
    },
  );

  it('preserves valid Unicode, replacement characters and long unindexed text across reopen and lookup', async () => {
    const { db, data, log } = await fixture();
    const values = ['Hello', 'é', '日本語', '🙂', 'before🙂after', '\uFFFD'];
    for (const [id, value] of values.entries())
      await db.insertDocumentObject('docs', { id: String(id), indexed: value, unindexed: value.repeat(1000) });
    await db.commit();
    await db.reopen(new RealFile(data), new RealFile(log));
    const ql = new QueryLanguage(db);
    for (const [id, value] of values.entries()) {
      expect(await db.getDocumentObjectById('docs', String(id))).toEqual({
        id: String(id),
        indexed: value,
        unindexed: value.repeat(1000),
      });
      expect(await ql.execute(`SELECT id FROM docs WHERE indexed = ${JSON.stringify(value)}`)).toEqual([
        { id: String(id) },
      ]);
    }
    await expect(ql.execute("SELECT id FROM docs WHERE indexed = '\\uD800'")).rejects.toThrow(/unpaired UTF-16/);
    const collect = async (field: string) => {
      const result = [];
      for await (const row of db.cursorEqual('docs', field, '\uD800')) result.push(row);
      return result;
    };
    await expect(collect('indexed')).rejects.toThrow(/unpaired UTF-16/);
    await expect(collect('unindexed')).rejects.toThrow(/unpaired UTF-16/);
  });
});
