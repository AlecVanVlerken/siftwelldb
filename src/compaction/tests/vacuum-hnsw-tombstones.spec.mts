import { describe, expect, it } from 'vitest';

import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../../database/dbmsback.mjs';
import { parseRawDocument, type Document } from '../../database/document.mjs';
import { vacuumCompactInto } from '../compaction.mjs';

function keywordVector(input: string): Float32Array {
  const lower = input.toLowerCase();
  if (lower.includes('alpha')) return new Float32Array([0, 0, 0, 0]);
  if (lower.includes('beta')) return new Float32Array([10, 0, 0, 0]);
  if (lower.includes('gamma')) return new Float32Array([20, 0, 0, 0]);
  return new Float32Array([30, 0, 0, 0]);
}

async function makeDb(): Promise<{ db: DbmsBack; dataFile: MockFile; logFile: MockFile; hnswConfig: HnswConfig }> {
  const dataFile = new MockFile(4096);
  const logFile = new MockFile(4000096);
  const hnswConfig: HnswConfig = {
    dimension: 4,
    embeddingFn: (text) => Promise.resolve(keywordVector(text)),
    M: 4,
    efConstruction: 16,
    efSearch: 12,
  };
  const db = new DbmsBack(dataFile, logFile, hnswConfig);
  await db.create();
  return { db, dataFile, logFile, hnswConfig };
}

function makeTempFiles(): { dataFile: MockFile; logFile: MockFile } {
  return {
    dataFile: new MockFile(4096),
    logFile: new MockFile(4000096),
  };
}

async function semanticIds(
  db: DbmsBack,
  collection: string,
  query: string,
  k: number,
): Promise<Array<string | number>> {
  return (await db.semanticSearch(collection, query, k)).map((doc) => doc.getId());
}

describe('full vacuum HNSW tombstone cleanup', () => {
  it('keeps empty indexes isolated from live collections with different text and image dimensions', async () => {
    const vector = (dimension: number, value: number) => {
      const result = new Float32Array(dimension);
      result[0] = value;
      return result;
    };
    const imageIndex = {
      dimension: 512,
      embeddingFn: () => Promise.resolve(vector(512, 1)),
      imageEmbeddingFn: (image: Buffer) => Promise.resolve(vector(512, image[0])),
      M: 4,
      efConstruction: 16,
      efSearch: 12,
    };
    const hnswConfig: HnswConfig = {
      ...imageIndex,
      textIndex: {
        ...imageIndex,
        dimension: 384,
        embeddingFn: () => Promise.resolve(vector(384, 1)),
      },
      imageIndex,
    };
    const sourceFiles = makeTempFiles();
    const temp = makeTempFiles();
    const db = new DbmsBack(sourceFiles.dataFile, sourceFiles.logFile, hnswConfig);
    await db.create();
    for (const id of ['alpha', 'beta', 'gamma']) {
      await db.insertDocument(parseRawDocument('articles', { id, title: id }));
    }
    for (const id of ['photo1', 'photo2']) {
      await db.insertDocument(parseRawDocument('photos', { id, label: 'rabbit', 'photo.jpg': Buffer.from([1, 2]) }));
    }
    await db.insertDocument(parseRawDocument('empty', { id: 'deleted', title: 'removed' }));
    await db.deleteDocument('alpha', 'articles');
    await db.deleteDocument('photo1', 'photos');
    await db.deleteDocument('deleted', 'empty');

    const result = await vacuumCompactInto({
      source: db,
      tempDataFile: temp.dataFile,
      tempLogFile: temp.logFile,
      validate: true,
      rebuildHnsw: true,
    });
    await result.target.commit();
    await result.target.close();

    const reopened = await DbmsBack.open(temp.dataFile, temp.logFile, hnswConfig);
    try {
      expect(await semanticIds(reopened, 'articles', 'alpha', 5)).toEqual(expect.arrayContaining(['beta', 'gamma']));
      expect(await semanticIds(reopened, 'articles', 'alpha', 5)).toHaveLength(2);
      expect((await reopened.semanticImageSearch('photos', Buffer.from([1, 2]), 5)).map((doc) => doc.getId())).toEqual([
        'photo2',
      ]);
      expect(await reopened.inspectHnswGraphStructure('articles::image')).toEqual([]);
      expect(await reopened.inspectHnswGraphStructure('empty::text')).toEqual([]);
      expect(await reopened.inspectHnswGraphStructure('empty::image')).toEqual([]);
      expect(await reopened.semanticSearch('empty', 'alpha', 5)).toEqual([]);
      expect(await reopened.semanticImageSearch('articles', Buffer.from([1, 2]), 5)).toEqual([]);
    } finally {
      await reopened.close();
      await db.close();
    }
  });

  it('drops tombstoned HNSW storage and rebuilds a live-only semantic graph after reopen', async () => {
    const { db, hnswConfig } = await makeDb();
    const temp = makeTempFiles();

    await db.insertDocument(parseRawDocument('articles', { id: 'alpha', body: 'alpha topic', group: 'deleted' }));
    await db.insertDocument(parseRawDocument('articles', { id: 'beta', body: 'beta topic', group: 'live' }));
    await db.insertDocument(parseRawDocument('articles', { id: 'gamma', body: 'gamma topic', group: 'live' }));
    await db.insertDocument(parseRawDocument('notes', { id: 'n1', title: 'ordinary collection survives vacuum' }));
    db.setFieldCompressionDefaults('metadataOnly', { title: 'gzip' });

    await db.deleteDocument('alpha', 'articles');

    const sourceGraph = await db.inspectHnswGraphStructure('articles');
    expect(sourceGraph.filter((node) => node.deleted)).toHaveLength(1);
    expect(sourceGraph).toHaveLength(3);

    const result = await vacuumCompactInto({
      source: db,
      tempDataFile: temp.dataFile,
      tempLogFile: temp.logFile,
      validate: true,
      rebuildHnsw: true,
    });

    expect(result.collectionsCopied).toBe(3);
    expect(result.documentsCopied).toBe(3);
    await expect(result.target.getDocument('alpha', 'articles')).rejects.toThrow(/not found|given id/i);
    const copiedNote = (await result.target.getDocument('n1', 'notes')) as Document;
    expect(copiedNote.getId()).toBe('n1');
    expect(result.target.getFieldCompressionDefaults('metadataOnly')).toEqual({ title: 'gzip' });

    const targetGraph = await result.target.inspectHnswGraphStructure('articles');
    expect(targetGraph).toHaveLength(2);
    expect(targetGraph.some((node) => node.deleted)).toBe(false);

    const afterVacuumIds = await semanticIds(result.target, 'articles', 'alpha topic', 3);
    expect(afterVacuumIds).not.toContain('alpha');
    expect(afterVacuumIds).toEqual(expect.arrayContaining(['beta', 'gamma']));

    await result.target.commit();
    await result.target.close();

    const reopened = await DbmsBack.open(temp.dataFile, temp.logFile, hnswConfig);
    const reopenedGraph = await reopened.inspectHnswGraphStructure('articles');
    expect(reopenedGraph).toHaveLength(2);
    expect(reopenedGraph.some((node) => node.deleted)).toBe(false);

    const reopenedIds = await semanticIds(reopened, 'articles', 'alpha topic', 3);
    expect(reopenedIds).not.toContain('alpha');
    expect(reopenedIds).toEqual(expect.arrayContaining(['beta', 'gamma']));

    await reopened.close();
    await db.close();
  });

  it('keeps an all-deleted HNSW collection as a clean empty semantic index', async () => {
    const { db, hnswConfig } = await makeDb();
    const temp = makeTempFiles();

    await db.insertDocument(parseRawDocument('articles', { id: 'alpha', body: 'alpha topic' }));
    await db.insertDocument(parseRawDocument('articles', { id: 'beta', body: 'beta topic' }));
    await db.deleteDocument('alpha', 'articles');
    await db.deleteDocument('beta', 'articles');

    const sourceGraph = await db.inspectHnswGraphStructure('articles');
    expect(sourceGraph).toHaveLength(2);
    expect(sourceGraph.every((node) => node.deleted)).toBe(true);

    const result = await vacuumCompactInto({
      source: db,
      tempDataFile: temp.dataFile,
      tempLogFile: temp.logFile,
      validate: true,
      rebuildHnsw: true,
    });

    expect(result.documentsCopied).toBe(0);
    expect(result.target.getVacuumHnswMetaSnapshot()).toHaveProperty('articles');
    expect(await result.target.inspectHnswGraphStructure('articles')).toEqual([]);
    expect(await result.target.semanticSearch('articles', 'alpha topic', 3)).toEqual([]);

    await result.target.commit();
    await result.target.close();

    const reopened = await DbmsBack.open(temp.dataFile, temp.logFile, hnswConfig);
    expect(reopened.getVacuumHnswMetaSnapshot()).toHaveProperty('articles');
    expect(await reopened.inspectHnswGraphStructure('articles')).toEqual([]);
    expect(await reopened.semanticSearch('articles', 'alpha topic', 3)).toEqual([]);

    await reopened.close();
    await db.close();
  });
});
