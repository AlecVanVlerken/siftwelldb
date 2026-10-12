import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DbmsBack, type HnswConfig } from '../../database/dbmsback.mjs';
import { type Document } from '../../database/document.mjs';
import { fetchPageCursor } from '../../database/pagination.mjs';
import { SimpleDbms } from '../../database/simpledbms.mjs';
import { QueryLanguage } from '../../query/querylanguage.mjs';
import { RealFile } from '../../storage/file.mjs';
import type { EncodedDocument, RecordStore } from '../../storage/records/recordstore.mjs';

function embedding(text: string): Promise<Float32Array> {
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return Promise.resolve(new Float32Array([(hash & 65535) / 65535, (hash >>> 16) / 65535, 1]));
}

const config: HnswConfig = {
  dimension: 3,
  embeddingFn: embedding,
  textIndex: {
    dimension: 3,
    embeddingFn: embedding,
    M: 4,
    maxStoredLevel: 3,
    efConstruction: 64,
    efSearch: 64,
  },
  imageIndex: {
    dimension: 4,
    embeddingFn: () => Promise.resolve(new Float32Array([1, 2, 3, 4])),
    imageEmbeddingFn: (image) => {
      const id = image[0];
      return Promise.resolve(new Float32Array([id / 31, (id * id) / 961, Math.sin(id * 0.7), 1]));
    },
    M: 4,
    maxStoredLevel: 3,
    efConstruction: 64,
    efSearch: 64,
  },
};

function backend(db: SimpleDbms): DbmsBack {
  return (db as unknown as { dbmsback: DbmsBack }).dbmsback;
}

async function collectPages(db: SimpleDbms, field: string): Promise<string[]> {
  const rows: string[] = [];
  let afterCursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await fetchPageCursor(db, { collection: 'items', iterableKey: field, limit: 2, afterCursor });
    rows.push(...page.data);
    if (!page.hasMore) return rows;
    expect(page.nextCursor).toBeDefined();
    expect(page.nextCursor).not.toBe(afterCursor);
    afterCursor = page.nextCursor;
  }
  throw new Error('Pagination did not reach the end');
}

async function fullCursor(db: SimpleDbms, field: string): Promise<string[]> {
  const rows: string[] = [];
  for await (const row of db.cursor('items', field)) rows.push(row);
  return rows;
}

async function normalizedGraph(db: DbmsBack, kind: 'text' | 'image') {
  const snapshot = await db.inspectHnswGraphStructureSnapshot('items', kind);
  const store = (db as unknown as { recordStore: RecordStore }).recordStore;
  const identities = new Map<number, string>();
  for (const node of snapshot.nodes) {
    const document = await store.readRecord(node.docId);
    expect(document).not.toBeNull();
    identities.set(node.nodeId, JSON.stringify([document!.getId(), document!.getFields()['title'], node.deleted]));
  }
  const identity = (nodeId: number) => {
    const value = identities.get(nodeId);
    expect(value).toBeDefined();
    return value!;
  };
  return {
    entryPoint: snapshot.entryPoint === null ? null : identity(snapshot.entryPoint),
    currentMaxLevel: snapshot.currentMaxLevel,
    nodes: snapshot.nodes
      .map((node) => ({
        identity: identity(node.nodeId),
        level: node.level,
        vector: node.vector,
        deleted: node.deleted,
        // Inspection sorts physical node IDs; compare exact logical adjacency after addresses move.
        neighbors: node.neighbors.map((layer) => layer.map(identity).sort()),
      }))
      .sort((a, b) => a.identity.localeCompare(b.identity)),
  };
}

describe('real-file candidate discovery and incremental traversal integration', () => {
  it.each([1, 5])(
    'preserves mixed storage across repeated batches of %i, writes, index changes and reopen',
    async (batch) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'siftwell-candidate-integration-'));
      const data = new RealFile(path.join(directory, 'source.db'));
      const log = new RealFile(path.join(directory, 'source.wal'));
      let db: SimpleDbms | undefined;
      let vacuum: DbmsBack | undefined;
      try {
        db = await SimpleDbms.create(data, log, config);
        await db.setFieldIndexed('holes', 'payload', false);
        await db.setFieldIndexed('items', 'payload', false);
        await db.setFieldIndexed('items', 'title', false);
        db.setFieldCompressionDefaults('items', { payload: 'gzip', 'photo.png': 'gzip' });
        for (let id = 0; id < 45; id++) {
          await db.insertDocumentObject(
            'holes',
            { id, payload: 'low address hole '.repeat(500) },
            { skipSemanticIndex: true },
          );
        }
        await db.commit();
        for (let id = 0; id < 30; id++) {
          await db.insertDocumentObject(
            'items',
            {
              id,
              category: `c${id % 3}`,
              title: `original title ${id}`,
              payload: 'multi block contents '.repeat(400),
              'photo.png': Buffer.from([id, 0, 255, 128]),
            },
            { compression: { payload: id % 2 ? 'off' : 'deflate', 'photo.png': 'off' } },
          );
        }
        await db.commit();
        for (let id = 0; id < 45; id++) await db.deleteDocumentById('holes', id);
        for (const id of [0, 1, 2]) await db.deleteDocumentById('items', id);
        await db.commit();
        const source = backend(db);
        // Warm each catalog before ordinary mutations. They must never retain removed indexes or old records.
        await source.listRecordRelocationTargets(1000);
        await source.listBtreeRelocationTargets(1000);
        await source.listHnswRelocationCandidateTargets(1000);
        await db.replaceDocument(
          'items',
          5,
          {
            id: 5,
            category: 'c2',
            title: 'updated title 5',
            payload: 'replacement multi block '.repeat(350),
            'photo.png': Buffer.from([5, 0, 255, 128]),
          },
          { preserveCompression: true },
        );
        await db.insertDocumentObject('items', {
          id: 40,
          category: 'c1',
          title: 'new tail',
          payload: 'new '.repeat(500),
          'photo.png': Buffer.from([40, 0, 255, 128]),
        });
        await db.deleteDocumentById('items', 6);
        await db.setFieldIndexed('items', 'category', false);
        expect(
          (await source.listBtreeRelocationTargets(1000)).some(
            (target) => target.field === 'category' && target.collection === 'items',
          ),
        ).toBe(false);
        await db.setFieldIndexed('items', 'category', true);
        expect(
          (await source.listBtreeRelocationTargets(1000)).some(
            (target) => target.field === 'category' && target.collection === 'items',
          ),
        ).toBe(true);
        await db.commit();
        const expectedIds = [...Array.from({ length: 27 }, (_, index) => index + 3).filter((id) => id !== 6), 40];
        expect(
          (await source.listRecordRelocationTargets(1000))
            .filter((target) => target.collection === 'items')
            .map((target) => target.documentId)
            .sort((a, b) => Number(a) - Number(b)),
        ).toEqual(expectedIds);
        const baselineRows = await fullCursor(db, 'id');
        const baselineCategoryRows = await fullCursor(db, 'category');
        const encoded = new Map<number, EncodedDocument>();
        for (const id of expectedIds) encoded.set(id, (await source.getDocument(id, 'items', true)) as EncodedDocument);
        const semanticIds = (await source.semanticSearch('items', 'maintenance', 10)).map((document) =>
          document.getId(),
        );
        const imageIds = (await source.semanticImageSearch('items', Buffer.from([14, 0, 255, 128]), 10)).map(
          (document) => document.getId(),
        );
        expect(semanticIds).toHaveLength(10);
        expect(imageIds).toHaveLength(10);
        expect([...semanticIds, ...imageIds].every((id) => expectedIds.includes(Number(id)))).toBe(true);
        const textGraph = await normalizedGraph(source, 'text');
        const imageGraph = await normalizedGraph(source, 'image');
        expect(textGraph.nodes.some((node) => node.deleted)).toBe(true);
        expect(imageGraph.nodes.some((node) => node.deleted)).toBe(true);
        const bytesBefore = (await source.getCompactionStorageStats()).fileSizeBytes;
        let moved = 0;
        let recordsMoved = 0;
        let btreeMoved = 0;
        let hnswMoved = 0;
        let reclaimed = 0;
        for (let step = 0; step < 200; step++) {
          const result = await db.runIncrementalCompactionStep({
            maxAmplification: 1.01,
            softAmplification: 1.01,
            targetBatchDocuments: batch,
            targetBatchUnits: batch,
          });
          const units =
            (result.relocatedDocuments ?? 0) + (result.relocatedBtreeNodes ?? 0) + (result.relocatedHnswUnits ?? 0);
          expect(units).toBeLessThanOrEqual(batch);
          moved += units;
          recordsMoved += result.relocatedDocuments ?? 0;
          btreeMoved += result.relocatedBtreeNodes ?? 0;
          hnswMoved += result.relocatedHnswUnits ?? 0;
          reclaimed += result.reclaimedTailBlocks ?? 0;
          if (!result.didWork) break;
        }
        expect(moved).toBeGreaterThan(0);
        expect(recordsMoved).toBeGreaterThan(0);
        expect(btreeMoved).toBeGreaterThan(0);
        expect(hnswMoved).toBeGreaterThan(0);
        expect(reclaimed).toBeGreaterThan(0);
        expect((await source.getCompactionStorageStats()).fileSizeBytes).toBeLessThan(bytesBefore);
        expect(await normalizedGraph(source, 'text')).toEqual(textGraph);
        expect(await normalizedGraph(source, 'image')).toEqual(imageGraph);
        const verify = async (checked: SimpleDbms) => {
          const checkedBackend = backend(checked);
          expect(await fullCursor(checked, 'id')).toEqual(baselineRows);
          expect(await collectPages(checked, 'id')).toEqual(baselineRows);
          expect(await fullCursor(checked, 'category')).toEqual(baselineCategoryRows);
          expect(await collectPages(checked, 'category')).toEqual(baselineCategoryRows);
          for (const id of expectedIds)
            expect(await checkedBackend.getDocument(id, 'items', true)).toEqual(encoded.get(id));
          expect(
            (await checkedBackend.semanticSearch('items', 'maintenance', 10)).map((document) => document.getId()),
          ).toEqual(semanticIds);
          expect(
            (await checkedBackend.semanticImageSearch('items', Buffer.from([14, 0, 255, 128]), 10)).map((document) =>
              document.getId(),
            ),
          ).toEqual(imageIds);
          expect(await new QueryLanguage(checked).execute('SELECT id FROM items ORDER BY id LIMIT 5 OFFSET 2')).toEqual(
            expectedIds.slice(2, 7).map((id) => ({ id })),
          );
        };
        await verify(db);
        await db.commit();
        await db.close();
        db = await SimpleDbms.open(data, log, config);
        await verify(db);
        expect(await normalizedGraph(backend(db), 'text')).toEqual(textGraph);
        expect(await normalizedGraph(backend(db), 'image')).toEqual(imageGraph);
        // Reopen starts fresh discovery; an ordinary new write is eligible without stale positions.
        await backend(db).listRecordRelocationTargets(1);
        await db.insertDocumentObject('fresh', { id: '', category: 'new collection', payload: 'fresh data' });
        expect(
          (await backend(db).listRecordRelocationTargets(1000)).some(
            (target) => target.collection === 'fresh' && target.documentId === '',
          ),
        ).toBe(true);
        await db.commit();
        vacuum = await backend(db).vacuumCompactInto(
          new RealFile(path.join(directory, 'vacuum.db')),
          new RealFile(path.join(directory, 'vacuum.wal')),
        );
        for (const id of expectedIds) {
          expect(await vacuum.getDocument(id, 'items', true)).toEqual(encoded.get(id));
          expect(((await vacuum.getDocument(id, 'items')) as Document).getId()).toBe(id);
        }
        expect((await vacuum.inspectHnswGraphStructure('items', 'text')).every((node) => !node.deleted)).toBe(true);
        expect((await vacuum.inspectHnswGraphStructure('items', 'image')).every((node) => !node.deleted)).toBe(true);
        await vacuum.close();
        vacuum = undefined;
        const reopenedVacuum = await SimpleDbms.open(
          new RealFile(path.join(directory, 'vacuum.db')),
          new RealFile(path.join(directory, 'vacuum.wal')),
          config,
        );
        try {
          expect(await collectPages(reopenedVacuum, 'id')).toEqual(baselineRows);
          expect(await collectPages(reopenedVacuum, 'category')).toEqual(baselineCategoryRows);
        } finally {
          await reopenedVacuum.close();
        }
      } finally {
        await vacuum?.close();
        await db?.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30000,
  );
});
