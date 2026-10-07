import { describe, expect, it } from 'vitest';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../dbmsback.mjs';
import { parseRawDocument } from '../document.mjs';

function keywordVector(input: string): Float32Array {
  const lower = input.toLowerCase();
  if (lower.includes('alpha')) return new Float32Array([0, 0, 0, 0]);
  if (lower.includes('beta')) return new Float32Array([10, 0, 0, 0]);
  if (lower.includes('gamma')) return new Float32Array([20, 0, 0, 0]);
  return new Float32Array([30, 0, 0, 0]);
}

function imageVector(imageData: Buffer): Float32Array {
  return new Float32Array([imageData[0] ?? 0, 0, 0, 0]);
}

async function makeDb(): Promise<{ db: DbmsBack; dataFile: MockFile; logFile: MockFile; hnswConfig: HnswConfig }> {
  const dataFile = new MockFile(4096);
  const logFile = new MockFile(4000096);
  const hnswConfig: HnswConfig = {
    dimension: 4,
    embeddingFn: (text) => Promise.resolve(keywordVector(text)),
    imageEmbeddingFn: (imageData) => Promise.resolve(imageVector(imageData)),
    M: 4,
    efConstruction: 16,
    efSearch: 12,
  };
  const db = new DbmsBack(dataFile, logFile, hnswConfig);
  await db.create();
  return { db, dataFile, logFile, hnswConfig };
}

async function collectIds(cursor: AsyncIterable<{ getId(): string | number }>): Promise<Array<string | number>> {
  const ids: Array<string | number> = [];
  for await (const doc of cursor) {
    ids.push(doc.getId());
  }
  return ids;
}

describe('DbmsBack - HNSW tombstones', () => {
  it('text semantic search excludes tombstoned entries and keeps live entries searchable after reopen', async () => {
    const { db, dataFile, logFile, hnswConfig } = await makeDb();

    await db.insertDocument(parseRawDocument('articles', { id: 'alpha', body: 'alpha topic' }));
    await db.insertDocument(parseRawDocument('articles', { id: 'beta', body: 'beta topic' }));
    await db.insertDocument(parseRawDocument('articles', { id: 'gamma', body: 'gamma topic' }));

    expect(await db.tombstoneSemanticEntry('alpha', 'articles')).toBe(true);

    const before = await db.semanticSearch('articles', 'alpha topic', 2);
    expect(before.map((doc) => doc.getId())).not.toContain('alpha');
    expect(before.length).toBe(2);

    await db.commit();
    await db.close();

    const reopened = await DbmsBack.open(dataFile, logFile, hnswConfig);
    const after = await reopened.semanticSearch('articles', 'alpha topic', 2);
    expect(after.map((doc) => doc.getId())).not.toContain('alpha');
    expect(after.length).toBe(2);

    const graph = await reopened.inspectHnswGraphStructure('articles');
    expect(graph.some((node) => node.deleted)).toBe(true);
    await reopened.close();
  });

  it('image semantic search excludes tombstoned image entries', async () => {
    const { db } = await makeDb();

    await db.insertDocument(
      parseRawDocument('images', {
        id: 'img1',
        'photo.jpg': Buffer.from([1]).toString('base64'),
      }),
    );
    await db.insertDocument(
      parseRawDocument('images', {
        id: 'img2',
        'photo.jpg': Buffer.from([2]).toString('base64'),
      }),
    );

    expect(await db.tombstoneSemanticEntry('img1', 'images')).toBe(true);

    const results = await db.semanticImageSearch('images', Buffer.from([1]), 1);
    expect(results.map((doc) => doc.getId())).toEqual(['img2']);
    await db.close();
  });

  it('normal delete tombstones the HNSW entry without rebuilding the collection graph', async () => {
    const { db } = await makeDb();

    await db.insertDocument(parseRawDocument('articles', { id: 'alpha', body: 'alpha topic' }));
    await db.insertDocument(parseRawDocument('articles', { id: 'beta', body: 'beta topic' }));
    await db.insertDocument(parseRawDocument('articles', { id: 'gamma', body: 'gamma topic' }));

    const before = await db.inspectHnswGraphStructure('articles');
    await db.deleteDocument('alpha', 'articles');
    const after = await db.inspectHnswGraphStructure('articles');

    expect(after).toHaveLength(before.length);
    expect(after.filter((node) => node.deleted)).toHaveLength(1);
    expect(after.filter((node) => !node.deleted)).toHaveLength(2);

    const results = await db.semanticSearch('articles', 'alpha topic', 2);
    expect(results.map((doc) => doc.getId())).not.toContain('alpha');
    expect(results).toHaveLength(2);
    await db.close();
  });

  it('normal delete removes primary and secondary DBMS paths while semantic search filters the tombstone', async () => {
    const { db } = await makeDb();

    await db.insertDocument(parseRawDocument('articles', { id: 'alpha', body: 'alpha topic', group: 'keep' }));
    await db.insertDocument(parseRawDocument('articles', { id: 'beta', body: 'beta topic', group: 'keep' }));
    await db.insertDocument(parseRawDocument('articles', { id: 'gamma', body: 'gamma topic', group: 'other' }));

    await db.deleteDocument('alpha', 'articles');

    await expect(db.getDocument('alpha', 'articles')).rejects.toThrow(/not found/i);
    const secondaryIds = await collectIds(await db.cursor('articles', 'group', 'keep'));
    expect(secondaryIds).not.toContain('alpha');
    expect(secondaryIds).toContain('beta');

    const semanticIds = (await db.semanticSearch('articles', 'alpha topic', 2)).map((doc) => doc.getId());
    expect(semanticIds).not.toContain('alpha');
    expect(semanticIds).toContain('beta');
    await db.close();
  });

  it('normal-delete tombstones persist across reopen and do not resurrect after later inserts', async () => {
    const { db, dataFile, logFile, hnswConfig } = await makeDb();

    await db.insertDocument(parseRawDocument('articles', { id: 'alpha', body: 'alpha topic' }));
    await db.insertDocument(parseRawDocument('articles', { id: 'beta', body: 'beta topic' }));
    await db.insertDocument(parseRawDocument('articles', { id: 'gamma', body: 'gamma topic' }));
    await db.deleteDocument('alpha', 'articles');
    await db.commit();
    await db.close();

    const reopened = await DbmsBack.open(dataFile, logFile, hnswConfig);
    let results = await reopened.semanticSearch('articles', 'alpha topic', 3);
    expect(results.map((doc) => doc.getId())).not.toContain('alpha');

    await reopened.insertDocument(parseRawDocument('articles', { id: 'delta', body: 'delta topic' }));
    results = await reopened.semanticSearch('articles', 'alpha topic', 3);
    expect(results.map((doc) => doc.getId())).not.toContain('alpha');
    expect(results.map((doc) => doc.getId())).toContain('delta');

    const graph = await reopened.inspectHnswGraphStructure('articles');
    const tombstone = graph.find((node) => node.deleted);
    const deltaNode = graph.find((node) => !node.deleted && node.vector[0] === 30);
    expect(tombstone).toBeDefined();
    expect(deltaNode).toBeDefined();
    expect(deltaNode!.docId).not.toBe(tombstone!.docId);
    await reopened.close();
  });

  it('normal image delete tombstones the image entry and filters image search', async () => {
    const { db } = await makeDb();

    await db.insertDocument(
      parseRawDocument('images', {
        id: 'img1',
        'photo.jpg': Buffer.from([1]).toString('base64'),
      }),
    );
    await db.insertDocument(
      parseRawDocument('images', {
        id: 'img2',
        'photo.jpg': Buffer.from([2]).toString('base64'),
      }),
    );

    await db.deleteDocument('img1', 'images');

    const results = await db.semanticImageSearch('images', Buffer.from([1]), 1);
    expect(results.map((doc) => doc.getId())).toEqual(['img2']);

    const graph = await db.inspectHnswGraphStructure('images');
    expect(graph.filter((node) => node.deleted)).toHaveLength(1);
    await db.close();
  });
});
