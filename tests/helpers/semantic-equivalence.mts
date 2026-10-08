// @author: Alec Van Vlerken
// @date: 2026-05-08

import assert from 'assert';

import { MockFile } from './mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../../src/database/dbmsback.mjs';
import { documentToJSON, JSONtoDocument, type Document } from '../../src/database/document.mjs';

export type SemanticTextQuery = {
  collection: string;
  query: string;
  k: number;
};

export type SemanticImageQuery = {
  collection: string;
  label: string;
  image: Buffer;
  k: number;
};

export type SemanticEquivalenceSnapshot = {
  textResultIds: Record<string, string[]>;
  imageResultIds: Record<string, string[]>;
  textResultDocuments: Record<string, string[]>;
  imageResultDocuments: Record<string, string[]>;
};

export type SemanticEquivalenceDb = {
  db: DbmsBack;
  data: MockFile;
  log: MockFile;
  hnswConfig: HnswConfig;
};

const semanticVectors: Record<string, number[]> = {
  'brown cat': [10, 0, 0, 0, 0, 0, 0, 0],
  'black dog': [0, 9, 0, 0, 0, 0, 0, 0],
  'white rabbit': [0, 0, 8, 0, 0, 0, 0, 0],
  'orange fox': [0, 0, 0, 7, 0, 0, 0, 0],
  'striped tiger': [0, 0, 0, 0, 6, 0, 0, 0],
  'blue whale': [0, 0, 0, 0, 0, 5, 0, 0],
  'green turtle': [0, 0, 0, 0, 0, 0, 4, 0],
  'red car': [0, 0, 0, 0, 0, 0, 0, 3],
};

export const semanticTextQueries: SemanticTextQuery[] = [
  { collection: 'articles', query: 'brown cat', k: 4 },
  { collection: 'articles', query: 'black dog', k: 4 },
  { collection: 'articles', query: 'orange fox', k: 4 },
  { collection: 'articles', query: 'striped tiger', k: 4 },
];

export const semanticImageQueries: SemanticImageQuery[] = [
  { collection: 'images', label: 'brown cat image', image: Buffer.from('brown cat image'), k: 3 },
  { collection: 'images', label: 'black dog image', image: Buffer.from('black dog image'), k: 3 },
  { collection: 'images', label: 'orange fox image', image: Buffer.from('orange fox image'), k: 3 },
];

export function makeDeterministicHnswConfig(): HnswConfig {
  return {
    dimension: 8,
    embeddingFn: (text) => Promise.resolve(makeDeterministicEmbedding(text)),
    imageEmbeddingFn: (imageData) => Promise.resolve(makeDeterministicEmbedding(imageData.toString('utf-8'))),
    M: 6,
    maxStoredLevel: 4,
    efConstruction: 64,
    efSearch: 64,
  };
}

export async function makeSemanticEquivalenceDb(): Promise<SemanticEquivalenceDb> {
  const data = new MockFile(4096);
  const log = new MockFile(4096);
  const hnswConfig = makeDeterministicHnswConfig();
  const db = new DbmsBack(data, log, hnswConfig);
  await db.create();
  return { db, data, log, hnswConfig };
}

export async function reopenSemanticEquivalenceDb(source: SemanticEquivalenceDb): Promise<DbmsBack> {
  await source.db.close();
  return await DbmsBack.open(source.data, source.log, source.hnswConfig);
}

export async function buildSemanticEquivalenceDataset(
  db: DbmsBack,
  options: { fragmentation?: boolean } = {},
): Promise<void> {
  if (options.fragmentation === true) {
    await db.setFieldIndexed('articles', '_payload', false);
    await db.setFieldIndexed('images', '_payload', false);

    for (let i = 0; i < 18; i++) {
      await db.insertDocument(
        JSONtoDocument(
          JSON.stringify({
            id: `dead${i.toString().padStart(3, '0')}`,
            group: 'deleted',
            category: `dead-${(i % 3).toString()}`,
            body: `deleted filler ${i.toString()}`,
            _payload: 'deleted filler payload '.repeat(260),
          }),
          'articles',
        ),
      );
    }
  }

  const phrases = Object.keys(semanticVectors);
  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i];
    await db.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: `doc${i.toString().padStart(3, '0')}`,
          group: i % 2 === 0 ? 'even' : 'odd',
          category: `cat-${(i % 4).toString()}`,
          rank: i,
          title: phrase,
          body: `${phrase} deterministic semantic document`,
          _payload: `${phrase} payload `.repeat(120),
        }),
        'articles',
      ),
    );
  }

  for (let i = 0; i < semanticImageQueries.length; i++) {
    const image = semanticImageQueries[i];
    await db.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: `img${i.toString().padStart(3, '0')}`,
          group: 'image',
          label: image.label,
          'photo.png': image.image.toString('base64'),
          _payload: `${image.label} image payload `.repeat(80),
        }),
        'images',
      ),
    );
  }

  await db.commit();

  if (options.fragmentation === true) {
    for (let i = 0; i < 18; i++) {
      await db.deleteDocument(`dead${i.toString().padStart(3, '0')}`, 'articles');
    }
    await db.commit();
  }
}

export async function captureSemanticEquivalenceSnapshot(
  db: DbmsBack,
  textQueries: SemanticTextQuery[] = semanticTextQueries,
  imageQueries: SemanticImageQuery[] = semanticImageQueries,
): Promise<SemanticEquivalenceSnapshot> {
  const textResultIds: Record<string, string[]> = {};
  const imageResultIds: Record<string, string[]> = {};
  const textResultDocuments: Record<string, string[]> = {};
  const imageResultDocuments: Record<string, string[]> = {};

  for (const query of textQueries) {
    const key = textQueryKey(query);
    const results = await db.semanticSearch(query.collection, query.query, query.k);
    textResultIds[key] = resultIds(results);
    textResultDocuments[key] = resultDocuments(results);
  }

  for (const query of imageQueries) {
    const key = imageQueryKey(query);
    const results = await db.semanticImageSearch(query.collection, query.image, query.k);
    imageResultIds[key] = resultIds(results);
    imageResultDocuments[key] = resultDocuments(results);
  }

  return {
    textResultIds,
    imageResultIds,
    textResultDocuments,
    imageResultDocuments,
  };
}

export function assertSemanticEquivalence(
  before: SemanticEquivalenceSnapshot,
  after: SemanticEquivalenceSnapshot,
): void {
  assert.deepStrictEqual(after.textResultIds, before.textResultIds);
  assert.deepStrictEqual(after.imageResultIds, before.imageResultIds);
  assert.deepStrictEqual(after.textResultDocuments, before.textResultDocuments);
  assert.deepStrictEqual(after.imageResultDocuments, before.imageResultDocuments);
}

export function semanticSnapshotsEqual(
  before: SemanticEquivalenceSnapshot,
  after: SemanticEquivalenceSnapshot,
): boolean {
  try {
    assertSemanticEquivalence(before, after);
    return true;
  } catch {
    return false;
  }
}

function makeDeterministicEmbedding(input: string): Float32Array {
  const normalized = input.toLowerCase();
  for (const [phrase, vector] of Object.entries(semanticVectors)) {
    if (normalized.includes(phrase)) {
      return new Float32Array(vector);
    }
  }

  const fallback = new Float32Array(8);
  for (let i = 0; i < normalized.length; i++) {
    fallback[i % fallback.length] += normalized.charCodeAt(i) % 17;
  }
  return fallback;
}

function resultIds(results: Document[]): string[] {
  return results.map((doc) => String(doc.getId()));
}

function resultDocuments(results: Document[]): string[] {
  return results.map((doc) => documentToJSON(doc));
}

function textQueryKey(query: SemanticTextQuery): string {
  return `${query.collection}:text:${query.query}:${query.k.toString()}`;
}

function imageQueryKey(query: SemanticImageQuery): string {
  return `${query.collection}:image:${query.label}:${query.k.toString()}`;
}
