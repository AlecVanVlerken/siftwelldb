import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { SimpleDbms } from '../simpledbms.mjs';
import { BulkImportError, bulkImportArray, bulkImportStream, parseJsonLines, streamJsonLines } from '../bulkimport.mjs';
import type { DbmsBack } from '../dbmsback.mjs';

type InsertionTree = { insert(key: Buffer, pointer: Buffer): Promise<void> };

function secondaryTree(db: SimpleDbms): InsertionTree {
  const back = (db as unknown as { dbmsback: DbmsBack }).dbmsback;
  const entry = (back as unknown as { treeCache: Map<string, { tree: InsertionTree }> }).treeCache.get('people:name');
  if (!entry) throw new Error('Expected the secondary name index');
  return entry.tree;
}

describe('bulk import mutation safety', () => {
  it('rejects a non-object JSONL document safely and continues the following batch', async () => {
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const db = await SimpleDbms.create(data, log);
    const result = await bulkImportStream(db, streamJsonLines('{"id":"a"}\nnull\n{"id":"b"}'), {
      collection: 'people',
    });
    expect(result).toMatchObject({ totalImported: 2, failedCount: 1, batchesCommitted: 1 });
    expect(db.isHealthy).toBe(true);
    await db.close();
    const reopened = await SimpleDbms.open(data, log);
    expect(JSON.parse(await reopened.getDocumentById('people', 'b'))).toEqual({ id: 'b' });
    await reopened.close();
  });

  it('stops an unsafe insertion and preserves acknowledged batches when reopened', async () => {
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const db = await SimpleDbms.create(data, log);
    await db.insertDocumentObject('people', { id: 'seed', name: 'existing' });
    await db.commit();
    const tree = secondaryTree(db);
    const insert = tree.insert.bind(tree);
    const fault = new Error('secondary insertion failed');
    const spy = vi.spyOn(tree, 'insert').mockImplementation(async (key, pointer) => {
      if (key.includes(Buffer.from('broken'))) throw fault;
      await insert(key, pointer);
    });
    let consumed = 0;
    function* source() {
      for (const id of ['a', 'b', 'staged', 'broken', 'never']) {
        consumed++;
        yield { id, name: 'imported' };
      }
    }
    const error = await bulkImportStream(db, source(), { collection: 'people', batchSize: 2 }).catch(
      (failure: unknown) => failure,
    );
    spy.mockRestore();
    expect(error).toBeInstanceOf(BulkImportError);
    expect(error).toMatchObject({
      progress: { totalImported: 3, totalCommitted: 2, batchesCommitted: 1, failedCount: 1 },
      cause: { cause: fault },
    });
    expect(consumed).toBe(4);
    expect(db.isHealthy).toBe(false);
    await expect(db.commit()).rejects.toThrow('close and reopen');
    await db.close();
    const reopened = await SimpleDbms.open(data, log);
    const primary: string[] = [];
    for await (const json of reopened.cursor('people', 'id')) primary.push((JSON.parse(json) as { id: string }).id);
    const secondary: string[] = [];
    for await (const json of reopened.cursorEqual('people', 'name', 'imported'))
      secondary.push((JSON.parse(json) as { id: string }).id);
    expect(primary).toEqual(['a', 'b', 'seed']);
    expect(secondary).toEqual(['a', 'b']);
    await reopened.insertDocumentObject('people', { id: 'later', name: 'healthy' });
    await reopened.commit();
    await reopened.close();
  });

  it('reports a failed commit without counting its batch as acknowledged durable progress', async () => {
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const db = await SimpleDbms.create(data, log);
    await db.commit();
    const fault = new Error('WAL sync failed');
    const sync = vi.spyOn(log, 'sync').mockRejectedValueOnce(fault);
    const error = await bulkImportArray(db, [{ id: 'a', name: 'one' }], {
      collection: 'people',
      batchSize: 1,
    }).catch((failure: unknown) => failure);
    sync.mockRestore();
    expect(error).toBeInstanceOf(BulkImportError);
    expect(error).toMatchObject({
      progress: { totalImported: 1, totalCommitted: 0, batchesCommitted: 0, failedCount: 0 },
    });
    expect(db.isHealthy).toBe(false);
    await expect(db.commit()).rejects.toThrow();
    // A pending WAL may replay this unacknowledged batch; progress deliberately
    // reports acknowledged commits rather than promising the batch was rolled back.
    await log.sync();
    await db.close();
  });

  it.each([NaN, Infinity, -Infinity])('continues after safely rejecting a non-finite value (%s)', async (value) => {
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const db = await SimpleDbms.create(data, log);
    const result = await bulkImportArray(
      db,
      [
        { id: 'a', score: 1 },
        { id: 'invalid', score: value },
        { id: 'b', score: 2 },
      ],
      { collection: 'people', batchSize: 10 },
    );
    expect(result).toMatchObject({ totalImported: 2, batchesCommitted: 1, failedCount: 1 });
    expect(db.isHealthy).toBe(true);
    await db.close();
    const reopened = await SimpleDbms.open(data, log);
    const ids: string[] = [];
    for await (const json of reopened.cursor('people', 'id')) ids.push((JSON.parse(json) as { id: string }).id);
    expect(ids).toEqual(['a', 'b']);
    await reopened.close();
  });
});

describe('Bulk Import', () => {
  let db: SimpleDbms;

  beforeEach(async () => {
    const dataFile = new MockFile(256);
    const logFile = new MockFile(4096);
    db = await SimpleDbms.create(dataFile, logFile);
  });

  describe('bulkImportArray', () => {
    it('imports an array of documents', async () => {
      const docs = [
        { id: 'doc1', name: 'Alice', age: 30 },
        { id: 'doc2', name: 'Bob', age: 25 },
        { id: 'doc3', name: 'Charlie', age: 35 },
      ];

      const result = await bulkImportArray(db, docs, {
        collection: 'people',
        batchSize: 10,
      });

      expect(result.totalImported).toBe(3);
      expect(result.failedCount).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Verify documents are in the database
      const doc1 = JSON.parse(await db.getDocumentById('people', 'doc1')) as Record<string, unknown>;
      expect(doc1['name']).toBe('Alice');

      const doc3 = JSON.parse(await db.getDocumentById('people', 'doc3')) as Record<string, unknown>;
      expect(doc3['name']).toBe('Charlie');
    });

    it('commits in batches', async () => {
      const docs = Array.from({ length: 25 }, (_, i) => ({
        id: `item-${i}`,
        value: i,
      }));

      const batches: number[] = [];
      const result = await bulkImportArray(db, docs, {
        collection: 'items',
        batchSize: 10,
        onBatchComplete: (info) => batches.push(info.batchNumber),
      });

      expect(result.totalImported).toBe(25);
      expect(result.batchesCommitted).toBe(3); // 10 + 10 + 5
      expect(batches).toEqual([1, 2, 3]);
    });

    it('handles empty array', async () => {
      const result = await bulkImportArray(db, [], {
        collection: 'empty',
        batchSize: 10,
      });

      expect(result.totalImported).toBe(0);
      expect(result.batchesCommitted).toBe(0);
    });

    it('reports batch info correctly', async () => {
      const docs = Array.from({ length: 15 }, (_, i) => ({
        id: `d-${i}`,
        val: i,
      }));

      const infos: { batchCount: number; totalImported: number; batchNumber: number }[] = [];
      await bulkImportArray(db, docs, {
        collection: 'test',
        batchSize: 10,
        onBatchComplete: (info) => infos.push({ ...info }),
      });

      expect(infos[0]).toEqual({ batchCount: 10, totalImported: 10, batchNumber: 1 });
      expect(infos[1]).toEqual({ batchCount: 5, totalImported: 15, batchNumber: 2 });
    });

    it('handles duplicate IDs gracefully', async () => {
      const docs = [
        { id: 'dup', name: 'First' },
        { id: 'dup', name: 'Second' },
        { id: 'unique', name: 'Third' },
      ];

      const result = await bulkImportArray(db, docs, {
        collection: 'test',
        batchSize: 10,
      });

      // The second 'dup' should fail because the B+ tree doesn't allow duplicates
      expect(result.totalImported).toBe(2);
      expect(result.failedCount).toBe(1);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe('bulkImportStream', () => {
    it('imports from an async generator', async () => {
      function* generate() {
        for (let i = 0; i < 10; i++) {
          yield { id: `stream-${i}`, value: i * 10 };
        }
      }

      const result = await bulkImportStream(db, generate(), {
        collection: 'streamed',
        batchSize: 4,
      });

      expect(result.totalImported).toBe(10);
      expect(result.batchesCommitted).toBe(3); // 4 + 4 + 2

      const doc = JSON.parse(await db.getDocumentById('streamed', 'stream-5')) as Record<string, unknown>;
      expect(doc['value']).toBe(50);
    });

    it('handles errors in stream without stopping', async () => {
      function* generate() {
        yield { id: 'ok1', val: 1 };
        yield { id: 'ok1', val: 2 }; // duplicate, will fail
        yield { id: 'ok2', val: 3 };
      }

      const result = await bulkImportStream(db, generate(), {
        collection: 'test',
        batchSize: 100,
      });

      expect(result.totalImported).toBe(2);
      expect(result.failedCount).toBe(1);
    });
  });

  describe('parseJsonLines', () => {
    it('parses JSONL text', () => {
      const text = '{"id":"a","x":1}\n{"id":"b","x":2}\n{"id":"c","x":3}';
      const result = parseJsonLines(text);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ id: 'a', x: 1 });
      expect(result[2]).toEqual({ id: 'c', x: 3 });
    });

    it('skips empty lines', () => {
      const text = '{"id":"a"}\n\n{"id":"b"}\n\n';
      const result = parseJsonLines(text);
      expect(result).toHaveLength(2);
    });

    it('handles single line', () => {
      const result = parseJsonLines('{"id":"solo"}');
      expect(result).toHaveLength(1);
    });
  });

  describe('streamJsonLines', () => {
    it('yields objects one at a time', () => {
      const text = '{"id":"x1","val":10}\n{"id":"x2","val":20}';
      const results: Record<string, unknown>[] = [];

      for (const obj of streamJsonLines(text)) {
        results.push(obj);
      }

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ id: 'x1', val: 10 });
    });

    it('can be used with bulkImportStream', async () => {
      const jsonl = Array.from({ length: 50 }, (_, i) => JSON.stringify({ id: `j-${i}`, n: i })).join('\n');

      const result = await bulkImportStream(db, streamJsonLines(jsonl), {
        collection: 'jsonl',
        batchSize: 20,
      });

      expect(result.totalImported).toBe(50);
      expect(result.batchesCommitted).toBe(3); // 20 + 20 + 10

      const doc = JSON.parse(await db.getDocumentById('jsonl', 'j-49')) as Record<string, unknown>;
      expect(doc['n']).toBe(49);
    });
  });

  describe('large dataset import', () => {
    it('imports 500 documents efficiently', async () => {
      const docs = Array.from({ length: 500 }, (_, i) => ({
        id: `large-${String(i).padStart(4, '0')}`,
        category: `cat-${i % 10}`,
        value: Math.random() * 1000,
        description: `Document number ${i} in the large dataset test`,
      }));

      const result = await bulkImportArray(db, docs, {
        collection: 'large',
        batchSize: 50,
      });

      expect(result.totalImported).toBe(500);
      expect(result.batchesCommitted).toBe(10);
      expect(result.failedCount).toBe(0);

      // Spot-check some documents
      const first = JSON.parse(await db.getDocumentById('large', 'large-0000')) as Record<string, unknown>;
      expect(first['description']).toBe('Document number 0 in the large dataset test');

      const last = JSON.parse(await db.getDocumentById('large', 'large-0499')) as Record<string, unknown>;
      expect(last['description']).toBe('Document number 499 in the large dataset test');

      // Verify we can paginate through them
      let count = 0;
      for await (const _ of db.cursor('large', 'id')) {
        void _;
        count++;
      }
      expect(count).toBe(500);
    });
  });
});
