// @author: Alec Van Vlerken
// @date: 2026-04-24

import assert from 'assert';
import { describe, it } from 'vitest';

import { CollectionCatalog } from './collectioncatalog.mjs';
import type { DbmsBack } from '../dbms/dbmsback.mjs';
import type { FieldCompressionDefaults } from '../dbms/compression.mjs';

type CollectionMetaSnapshot = Record<string, Record<string, [number, string]>>;
type HnswMetaSnapshot = Record<string, [number, string]>;

//
// Test setup helpers
//
function makeSource(
  collectionMeta: CollectionMetaSnapshot = {},
  compressionMeta: Record<string, FieldCompressionDefaults> = {},
  hnswMeta: HnswMetaSnapshot = {},
): DbmsBack {
  return {
    getVacuumCollectionMetaSnapshot: () => collectionMeta,
    getVacuumCompressionMetaSnapshot: () => compressionMeta,
    getVacuumHnswMetaSnapshot: () => hnswMeta,
  } as unknown as DbmsBack;
}

describe('collectioncatalog.mjs', () => {
  let catalog: CollectionCatalog;

  // ---------------------------------------------------------
  // listCollections()
  // ---------------------------------------------------------
  it('returns collection from regular metadata', () => {
    const source = makeSource({
      articles: {
        id: [1, 'S'],
      },
    });

    catalog = new CollectionCatalog(source);

    assert.deepStrictEqual(catalog.listCollections(), ['articles']);
  });

  it('returns collection from compression metadata only', () => {
    const source = makeSource(
      {},
      {
        articles: { title: 'gzip' },
      },
      {},
    );

    catalog = new CollectionCatalog(source);

    assert.deepStrictEqual(catalog.listCollections(), ['articles']);
  });

  it('returns collection from HNSW metadata only', () => {
    const source = makeSource(
      {},
      {},
      {
        images: [42, 'hnsw'],
      },
    );

    catalog = new CollectionCatalog(source);

    assert.deepStrictEqual(catalog.listCollections(), ['images']);
  });

  it('returns union without duplicates', () => {
    const source = makeSource(
      {
        articles: {
          id: [1, 'S'],
        },
      },
      {
        articles: { title: 'gzip' },
      },
      {
        articles: [42, 'hnsw'],
      },
    );

    catalog = new CollectionCatalog(source);

    assert.deepStrictEqual(catalog.listCollections(), ['articles']);
  });

  it('returns collections in sorted order', () => {
    const source = makeSource(
      {
        zebra: {
          id: [1, 'S'],
        },
        alpha: {
          id: [2, 'S'],
        },
      },
      {
        middle: { title: 'gzip' },
      },
      {},
    );

    catalog = new CollectionCatalog(source);

    assert.deepStrictEqual(catalog.listCollections(), ['alpha', 'middle', 'zebra']);
  });

  // ---------------------------------------------------------
  // getCompressionDefaults()
  // ---------------------------------------------------------
  it('returns undefined if compression defaults are absent', () => {
    const source = makeSource();
    catalog = new CollectionCatalog(source);

    assert.strictEqual(catalog.getCompressionDefaults('articles'), undefined);
  });

  it('returns copied compression defaults if present', () => {
    const source = makeSource(
      {},
      {
        articles: { title: 'gzip', body: 'deflate' },
      },
      {},
    );

    catalog = new CollectionCatalog(source);

    const defaults = catalog.getCompressionDefaults('articles');
    assert.deepStrictEqual(defaults, { title: 'gzip', body: 'deflate' });
    assert.notStrictEqual(defaults, source.getVacuumCompressionMetaSnapshot()['articles']);
  });

  // ---------------------------------------------------------
  // hasHnsw()
  // ---------------------------------------------------------
  it('returns true when collection is in HNSW metadata', () => {
    const source = makeSource(
      {},
      {},
      {
        images: [42, 'hnsw'],
      },
    );

    catalog = new CollectionCatalog(source);

    assert.strictEqual(catalog.hasHnsw('images'), true);
  });

  it('returns false when collection is not in HNSW metadata', () => {
    const source = makeSource(
      {},
      {},
      {
        images: [42, 'hnsw'],
      },
    );

    catalog = new CollectionCatalog(source);

    assert.strictEqual(catalog.hasHnsw('articles'), false);
  });

  // ---------------------------------------------------------
  // hasAnyHnswCollections()
  // ---------------------------------------------------------
  it('returns false when no HNSW-backed collections exist', () => {
    const source = makeSource();
    catalog = new CollectionCatalog(source);

    assert.strictEqual(catalog.hasAnyHnswCollections(), false);
  });

  it('returns true when at least one HNSW-backed collection exists', () => {
    const source = makeSource(
      {},
      {},
      {
        images: [42, 'hnsw'],
      },
    );

    catalog = new CollectionCatalog(source);

    assert.strictEqual(catalog.hasAnyHnswCollections(), true);
  });

  // ---------------------------------------------------------
  // hasCollectionMeta()
  // ---------------------------------------------------------
  it('returns true when regular collection metadata exists', () => {
    const source = makeSource({
      articles: {
        id: [1, 'S'],
      },
    });

    catalog = new CollectionCatalog(source);

    assert.strictEqual(catalog.hasCollectionMeta('articles'), true);
  });

  it('returns false for metadata-only collection', () => {
    const source = makeSource(
      {},
      {
        articles: { title: 'gzip' },
      },
      {},
    );

    catalog = new CollectionCatalog(source);

    assert.strictEqual(catalog.hasCollectionMeta('articles'), false);
  });

  // ---------------------------------------------------------
  // hasIdTree()
  // ---------------------------------------------------------
  it('returns true when collection metadata contains id', () => {
    const source = makeSource({
      articles: {
        id: [1, 'S'],
        title: [2, 'SS'],
      },
    });

    catalog = new CollectionCatalog(source);

    assert.strictEqual(catalog.hasIdTree('articles'), true);
  });

  it('returns false when collection exists only through compression metadata', () => {
    const source = makeSource(
      {},
      {
        articles: { title: 'gzip' },
      },
      {},
    );

    catalog = new CollectionCatalog(source);

    assert.strictEqual(catalog.hasIdTree('articles'), false);
  });

  it('returns false when regular collection metadata exists without id', () => {
    const source = makeSource({
      articles: {
        title: [2, 'SS'],
      },
    });

    catalog = new CollectionCatalog(source);

    assert.strictEqual(catalog.hasIdTree('articles'), false);
  });

  // ---------------------------------------------------------
  // getIndexedFields()
  // ---------------------------------------------------------
  it('returns empty array when no regular collection metadata exists', () => {
    const source = makeSource(
      {},
      {
        articles: { title: 'gzip' },
      },
      {},
    );

    catalog = new CollectionCatalog(source);

    assert.deepStrictEqual(catalog.getIndexedFields('articles'), []);
  });

  it('returns indexed fields in sorted order', () => {
    const source = makeSource({
      articles: {
        title: [3, 'SS'],
        id: [1, 'S'],
        author: [2, 'SS'],
      },
    });

    catalog = new CollectionCatalog(source);

    assert.deepStrictEqual(catalog.getIndexedFields('articles'), ['author', 'id', 'title']);
  });
});
