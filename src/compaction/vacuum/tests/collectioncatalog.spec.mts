// @author: Alec Van Vlerken
// @date: 2026-04-24

import assert from 'assert';
import { describe, it } from 'vitest';

import { CollectionCatalog } from '../collectioncatalog.mjs';
import type { DbmsBack } from '../../../database/dbmsback.mjs';
import type { FieldCompressionDefaults } from '../../../database/compression.mjs';
import { safeDictionary, semanticIndexKey } from '../../../database/identity.mjs';

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
        [semanticIndexKey('images', 'default')]: [42, 'hnsw'],
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
        [semanticIndexKey('articles', 'default')]: [42, 'hnsw'],
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
    assert.deepStrictEqual(defaults, safeDictionary({ title: 'gzip', body: 'deflate' }));
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
        [semanticIndexKey('images', 'default')]: [42, 'hnsw'],
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
        [semanticIndexKey('images', 'default')]: [42, 'hnsw'],
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
        [semanticIndexKey('images', 'default')]: [42, 'hnsw'],
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

  it('keeps collection suffixes and HNSW kinds distinct during collection discovery', () => {
    catalog = new CollectionCatalog(
      makeSource(
        {},
        {},
        {
          [semanticIndexKey('a', 'text')]: [1, 'hnsw'],
          [semanticIndexKey('a::text', 'default')]: [2, 'hnsw'],
          [semanticIndexKey('a::b', 'image')]: [3, 'hnsw'],
          [semanticIndexKey('__proto__', 'image')]: [4, 'hnsw'],
        },
      ),
    );
    assert.deepStrictEqual(catalog.listCollections(), ['__proto__', 'a', 'a::b', 'a::text']);
    for (const collection of ['__proto__', 'a', 'a::b', 'a::text'])
      assert.strictEqual(catalog.hasHnsw(collection), true);
    assert.strictEqual(catalog.hasHnsw('a::image'), false);
    assert.strictEqual(catalog.hasHnsw('constructor'), false);
  });

  it('ignores inherited collection and field properties and copies explicit prototype-looking keys safely', () => {
    catalog = new CollectionCatalog(makeSource());
    for (const collection of ['__proto__', 'constructor', 'toString']) {
      assert.strictEqual(catalog.hasCollectionMeta(collection), false);
      assert.strictEqual(catalog.hasIdTree(collection), false);
      assert.deepStrictEqual(catalog.getIndexedFields(collection), []);
      assert.strictEqual(catalog.getCompressionDefaults(collection), undefined);
    }
    const collectionMeta = safeDictionary<Record<string, [number, string]>>();
    collectionMeta['__proto__'] = Object.fromEntries([
      ['id', [1, 'S']],
      ['constructor', [2, 'SS']],
      ['__proto__', [3, 'SS']],
    ]) as Record<string, [number, string]>;
    const compression = safeDictionary<FieldCompressionDefaults>();
    compression['__proto__'] = Object.fromEntries([['__proto__', 'gzip']]) as FieldCompressionDefaults;
    catalog = new CollectionCatalog(makeSource(collectionMeta, compression));
    assert.strictEqual(catalog.hasCollectionMeta('__proto__'), true);
    assert.strictEqual(catalog.hasIdTree('__proto__'), true);
    assert.deepStrictEqual(catalog.getIndexedFields('__proto__'), ['__proto__', 'constructor', 'id']);
    const copied = catalog.getCompressionDefaults('__proto__')!;
    assert.strictEqual(Object.getPrototypeOf(copied), null);
    assert.strictEqual(copied['__proto__'], 'gzip');
    assert.strictEqual(Object.hasOwn(Object.prototype, 'id'), false);
  });
});
