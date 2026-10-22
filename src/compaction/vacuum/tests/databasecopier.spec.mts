// @author: Alec Van Vlerken
// @date: 2026-04-24

import assert from 'assert';
import { describe, it, beforeEach } from 'vitest';

import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../../../database/dbmsback.mjs';
import { safeDictionary } from '../../../database/identity.mjs';
import { Document, JSONtoDocument } from '../../../database/document.mjs';
import { CollectionCatalog } from '../collectioncatalog.mjs';
import { DatabaseCopier } from '../databasecopier.mjs';
import type { VacuumProgress } from '../vacuumtypes.mjs';

//
// Test setup helpers
//
async function makeDbmsBack(hnswConfig?: HnswConfig): Promise<DbmsBack> {
  const data = new MockFile(4096);
  const log = new MockFile(4096);
  const db = new DbmsBack(data, log, hnswConfig);
  await db.create();
  return db;
}

function makeTempFiles() {
  return {
    data: new MockFile(4096),
    log: new MockFile(4096),
  };
}

const testHnswConfig: HnswConfig = {
  dimension: 3,
  embeddingFn: (text: string) => {
    const out = new Float32Array(3);
    out[0] = text.length;
    out[1] = text.charCodeAt(0) || 0;
    out[2] = 1;
    return Promise.resolve(out);
  },
};

describe('databasecopier.mjs', () => {
  let source: DbmsBack;
  let target: DbmsBack;

  beforeEach(async () => {
    source = await makeDbmsBack();
    const temp = makeTempFiles();
    target = new DbmsBack(temp.data, temp.log);
    await target.create();
  });

  // ---------------------------------------------------------
  // copyAll()
  // ---------------------------------------------------------
  it('copies one collection with one document', async () => {
    const doc = JSONtoDocument(
      JSON.stringify({
        id: '1',
        title: 'hello',
      }),
      'articles',
    );

    await source.insertDocument(doc);
    await source.commit();

    const copier = new DatabaseCopier(source, target, new CollectionCatalog(source));
    const result = await copier.copyAll();

    assert.strictEqual(result.collectionsCopied, 1);
    assert.strictEqual(result.documentsCopied, 1);

    const copied = (await target.getDocument('1', 'articles')) as Document;
    assert.strictEqual(copied.getId(), '1');
    assert.strictEqual(copied.getCollectionName(), 'articles');
  });

  it('copies multiple collections', async () => {
    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'a',
        }),
        'articles',
      ),
    );

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '2',
          name: 'b',
        }),
        'users',
      ),
    );

    await source.commit();

    const copier = new DatabaseCopier(source, target, new CollectionCatalog(source));
    const result = await copier.copyAll();

    assert.strictEqual(result.collectionsCopied, 2);
    assert.strictEqual(result.documentsCopied, 2);

    const article = (await target.getDocument('1', 'articles')) as Document;
    const user = (await target.getDocument('2', 'users')) as Document;

    assert.strictEqual(article.getId(), '1');
    assert.strictEqual(user.getId(), '2');
  });

  it('copies metadata-only collection without crashing', async () => {
    source.setFieldCompressionDefaults('articles', { title: 'gzip' });
    await source.commit();

    const copier = new DatabaseCopier(source, target, new CollectionCatalog(source));
    const result = await copier.copyAll();

    assert.strictEqual(result.collectionsCopied, 1);
    assert.strictEqual(result.documentsCopied, 0);

    const targetCompression = target.getVacuumCompressionMetaSnapshot();
    assert.deepStrictEqual(targetCompression['articles'], safeDictionary({ title: 'gzip' }));
  });

  it('returns correct collection and document counts for mixed collections', async () => {
    source.setFieldCompressionDefaults('emptyCollection', { title: 'gzip' });

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'a',
        }),
        'articles',
      ),
    );

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '2',
          title: 'b',
        }),
        'articles',
      ),
    );

    await source.commit();

    const copier = new DatabaseCopier(source, target, new CollectionCatalog(source));
    const result = await copier.copyAll();

    assert.strictEqual(result.collectionsCopied, 2);
    assert.strictEqual(result.documentsCopied, 2);
  });

  it('copies compression defaults before documents', async () => {
    source.setFieldCompressionDefaults('articles', { title: 'gzip' });

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'compressed',
        }),
        'articles',
      ),
    );

    await source.commit();

    const copier = new DatabaseCopier(source, target, new CollectionCatalog(source));
    await copier.copyAll();

    const targetCompression = target.getVacuumCompressionMetaSnapshot();
    assert.deepStrictEqual(targetCompression['articles'], safeDictionary({ title: 'gzip' }));

    const copied = (await target.getDocument('1', 'articles')) as Document;
    assert.strictEqual(copied.getId(), '1');
  });

  it('copies an HNSW-backed collection through normal insert flow', async () => {
    source = await makeDbmsBack(testHnswConfig);

    const temp = makeTempFiles();
    target = new DbmsBack(temp.data, temp.log, testHnswConfig);
    await target.create();

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'semantic hello',
        }),
        'articles',
      ),
    );

    await source.commit();

    const copier = new DatabaseCopier(source, target, new CollectionCatalog(source));
    const result = await copier.copyAll();

    assert.strictEqual(result.collectionsCopied, 1);
    assert.strictEqual(result.documentsCopied, 1);

    const searchResults = await target.semanticSearch('articles', 'semantic', 5);
    assert.strictEqual(searchResults.length > 0, true);
  });

  // ---------------------------------------------------------
  // progress reporting
  // ---------------------------------------------------------
  it('emits progress events while copying documents', async () => {
    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'a',
        }),
        'articles',
      ),
    );

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '2',
          title: 'b',
        }),
        'articles',
      ),
    );

    await source.commit();

    const progressEvents: VacuumProgress[] = [];

    const copier = new DatabaseCopier(source, target, new CollectionCatalog(source), (progress) => {
      progressEvents.push(progress);
    });

    await copier.copyAll();

    assert.strictEqual(progressEvents.length >= 3, true);
    assert.deepStrictEqual(progressEvents[1], {
      phase: 'copy-collection',
      collection: 'articles',
      copiedDocuments: 0,
      totalDocuments: 2,
      processed: 0,
      total: 2,
      unit: 'documents',
      percentage: 0,
    });

    assert.strictEqual(
      progressEvents.some(
        (p) => p.phase === 'copy-collection' && p.collection === 'articles' && p.copiedDocuments === 1,
      ),
      true,
    );

    assert.strictEqual(
      progressEvents.some(
        (p) => p.phase === 'copy-collection' && p.collection === 'articles' && p.copiedDocuments === 2,
      ),
      true,
    );
  });

  it('reports metadata-only copying without inventing a percentage', async () => {
    source.setFieldCompressionDefaults('articles', { title: 'gzip' });
    await source.commit();

    const progressEvents: VacuumProgress[] = [];

    const copier = new DatabaseCopier(source, target, new CollectionCatalog(source), (progress) => {
      progressEvents.push(progress);
    });

    await copier.copyAll();

    assert.deepStrictEqual(progressEvents, [
      { phase: 'copy-collection', collection: 'articles' },
      {
        phase: 'copy-collection',
        collection: 'articles',
        copiedDocuments: 0,
        totalDocuments: 0,
        processed: 0,
        total: 0,
        unit: 'documents',
      },
    ]);
  });
});
