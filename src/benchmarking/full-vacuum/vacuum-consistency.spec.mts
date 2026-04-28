// @author: Alec Van Vlerken
// @date: 2026-04-28

import assert from 'assert';
import { describe, it } from 'vitest';

import { MockFile } from '../../core/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../../dbms/dbmsback.mjs';
import { JSONtoDocument, documentToJSON, type Document } from '../../dbms/document.mjs';
import { CollectionCatalog } from '../../compaction/collectioncatalog.mjs';

type DbSnapshot = {
  collections: string[];
  countsByCollection: Record<string, number>;
  idsByCollection: Record<string, string[]>;
  docsByCollection: Record<string, Record<string, string>>;
  compressionMeta: Record<string, Record<string, string>>;
};

type QueryExpectation = {
  collection: string;
  field: string;
  value: string | number | Buffer;
};

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

async function snapshotDb(db: DbmsBack): Promise<DbSnapshot> {
  const catalog = new CollectionCatalog(db);
  const collections = catalog.listCollections();

  const countsByCollection: Record<string, number> = {};
  const idsByCollection: Record<string, string[]> = {};
  const docsByCollection: Record<string, Record<string, string>> = {};

  for (const collection of collections) {
    countsByCollection[collection] = 0;
    idsByCollection[collection] = [];
    docsByCollection[collection] = {};

    if (!catalog.hasIdTree(collection)) {
      continue;
    }

    const cursor = await db.cursor(collection, 'id');
    for await (const doc of cursor) {
      const id = String(doc.getId());
      countsByCollection[collection] += 1;
      idsByCollection[collection].push(id);
      docsByCollection[collection][id] = documentToJSON(doc);
    }

    idsByCollection[collection].sort();
  }

  const compressionMeta = db.getVacuumCompressionMetaSnapshot() as Record<string, Record<string, string>>;

  return {
    collections,
    countsByCollection,
    idsByCollection,
    docsByCollection,
    compressionMeta,
  };
}

async function queryIds(
  db: DbmsBack,
  collection: string,
  field: string,
  value: string | number | Buffer,
): Promise<string[]> {
  const ids: string[] = [];
  const cursor = await db.cursor(collection, field, value);

  for await (const doc of cursor) {
    ids.push(String(doc.getId()));
  }

  ids.sort();
  return ids;
}

async function semanticIds(db: DbmsBack, collection: string, query: string, k: number): Promise<string[]> {
  const docs = await db.semanticSearch(collection, query, k);
  return docs.map((doc) => String(doc.getId())).sort();
}

async function buildWorkload(db: DbmsBack): Promise<void> {
  db.setFieldCompressionDefaults('articles', {
    title: 'gzip',
    body: 'deflate',
  });

  db.setFieldCompressionDefaults('users', {
    bio: 'gzip',
  });

  db.setFieldCompressionDefaults('logs', {
    message: 'gzip',
  });

  // ---------------------------------------------------------
  // Articles
  // ---------------------------------------------------------
  await db.insertDocument(
    JSONtoDocument(
      JSON.stringify({
        id: 'a1',
        title: 'vacuum design',
        body: 'designing full compaction for block databases',
        category: 'db',
        score: 10,
      }),
      'articles',
    ),
  );

  await db.insertDocument(
    JSONtoDocument(
      JSON.stringify({
        id: 'a2',
        title: 'metadata rewrite',
        body: 'collection roots and metadata migration',
        category: 'db',
        score: 20,
      }),
      'articles',
    ),
  );

  await db.insertDocument(
    JSONtoDocument(
      JSON.stringify({
        id: 'a3',
        title: 'semantic indexing',
        body: 'hnsw index rebuild after vacuum',
        category: 'ai',
        score: 30,
      }),
      'articles',
    ),
  );

  await db.insertDocument(
    JSONtoDocument(
      JSON.stringify({
        id: 'a4',
        title: 'temporary article',
        body: 'this document will be deleted',
        category: 'tmp',
        score: 40,
      }),
      'articles',
    ),
  );

  await db.insertDocument(
    JSONtoDocument(
      JSON.stringify({
        id: 'a5',
        title: 'query planning',
        body: 'indexed queries should keep working',
        category: 'db',
        score: 50,
      }),
      'articles',
    ),
  );

  // ---------------------------------------------------------
  // Users
  // ---------------------------------------------------------
  await db.insertDocument(
    JSONtoDocument(
      JSON.stringify({
        id: 'u1',
        name: 'Alice',
        city: 'Leuven',
        age: 29,
        bio: 'database engineer and benchmark writer',
      }),
      'users',
    ),
  );

  await db.insertDocument(
    JSONtoDocument(
      JSON.stringify({
        id: 'u2',
        name: 'Bob',
        city: 'Ghent',
        age: 35,
        bio: 'temporary user to be removed',
      }),
      'users',
    ),
  );

  await db.insertDocument(
    JSONtoDocument(
      JSON.stringify({
        id: 'u3',
        name: 'Carol',
        city: 'Leuven',
        age: 31,
        bio: 'works on compaction and indexing',
      }),
      'users',
    ),
  );

  // ---------------------------------------------------------
  // Logs
  // ---------------------------------------------------------
  await db.insertDocument(
    JSONtoDocument(
      JSON.stringify({
        id: 'l1',
        level: 'info',
        service: 'vacuum',
        message: 'vacuum start',
        ts: 1000,
      }),
      'logs',
    ),
  );

  await db.insertDocument(
    JSONtoDocument(
      JSON.stringify({
        id: 'l2',
        level: 'warn',
        service: 'vacuum',
        message: 'temporary log entry',
        ts: 1001,
      }),
      'logs',
    ),
  );

  await db.insertDocument(
    JSONtoDocument(
      JSON.stringify({
        id: 'l3',
        level: 'error',
        service: 'index',
        message: 'index rebuild required',
        ts: 1002,
      }),
      'logs',
    ),
  );

  // ---------------------------------------------------------
  // Fragmentation-producing mutations
  // ---------------------------------------------------------
  await db.deleteDocument('a4', 'articles');
  await db.deleteDocument('u2', 'users');
  await db.deleteDocument('l2', 'logs');

  await db.editDocumentByID('articles', 'a2', 'body', 'collection roots and metadata migration updated');

  await db.editDocumentByID('users', 'u1', 'bio', 'database engineer and consistency benchmark writer');

  await db.editDocumentByID('logs', 'l1', 'message', 'vacuum start edited');

  // Reinsert some documents after deletes/edits.
  await db.insertDocument(
    JSONtoDocument(
      JSON.stringify({
        id: 'a6',
        title: 'post delete insert',
        body: 'inserted after fragmentation already existed',
        category: 'db',
        score: 60,
      }),
      'articles',
    ),
  );

  await db.insertDocument(
    JSONtoDocument(
      JSON.stringify({
        id: 'u4',
        name: 'Dora',
        city: 'Antwerp',
        age: 27,
        bio: 'new user inserted after deletes',
      }),
      'users',
    ),
  );

  await db.insertDocument(
    JSONtoDocument(
      JSON.stringify({
        id: 'l4',
        level: 'info',
        service: 'vacuum',
        message: 'post-delete log insert',
        ts: 1003,
      }),
      'logs',
    ),
  );

  await db.commit();
}

describe('vacuum-consistency.mjs', () => {
  it('keeps the database logically consistent after vacuum compaction', async () => {
    const source = await makeDbmsBack(testHnswConfig);
    await buildWorkload(source);

    const beforeSnapshot = await snapshotDb(source);

    const queryExpectations: QueryExpectation[] = [
      { collection: 'articles', field: 'category', value: 'db' },
      { collection: 'articles', field: 'score', value: 30 },
      { collection: 'users', field: 'city', value: 'Leuven' },
      { collection: 'logs', field: 'service', value: 'vacuum' },
      { collection: 'logs', field: 'level', value: 'error' },
    ];

    const queryResultsBefore: Record<string, string[]> = {};
    for (const q of queryExpectations) {
      const key = `${q.collection}:${q.field}:${String(q.value)}`;
      queryResultsBefore[key] = await queryIds(source, q.collection, q.field, q.value);
    }

    const semanticBefore = await semanticIds(source, 'articles', 'semantic index vacuum', 5);

    const temp = makeTempFiles();
    const compacted = await source.vacuumCompactInto(temp.data, temp.log);

    const afterSnapshot = await snapshotDb(compacted);

    const queryResultsAfter: Record<string, string[]> = {};
    for (const q of queryExpectations) {
      const key = `${q.collection}:${q.field}:${String(q.value)}`;
      queryResultsAfter[key] = await queryIds(compacted, q.collection, q.field, q.value);
    }

    const semanticAfter = await semanticIds(compacted, 'articles', 'semantic index vacuum', 5);

    // ---------------------------------------------------------
    // Same collections exist
    // ---------------------------------------------------------
    assert.deepStrictEqual(afterSnapshot.collections, beforeSnapshot.collections);

    // ---------------------------------------------------------
    // Same document counts
    // ---------------------------------------------------------
    assert.deepStrictEqual(afterSnapshot.countsByCollection, beforeSnapshot.countsByCollection);

    // ---------------------------------------------------------
    // Same document ids
    // ---------------------------------------------------------
    assert.deepStrictEqual(afterSnapshot.idsByCollection, beforeSnapshot.idsByCollection);

    // ---------------------------------------------------------
    // Same document contents
    // ---------------------------------------------------------
    assert.deepStrictEqual(afterSnapshot.docsByCollection, beforeSnapshot.docsByCollection);

    // ---------------------------------------------------------
    // Same compression metadata
    // ---------------------------------------------------------
    assert.deepStrictEqual(afterSnapshot.compressionMeta, beforeSnapshot.compressionMeta);

    // ---------------------------------------------------------
    // Same representative query results
    // ---------------------------------------------------------
    assert.deepStrictEqual(queryResultsAfter, queryResultsBefore);

    // ---------------------------------------------------------
    // Semantic search still works with HNSW enabled
    // ---------------------------------------------------------
    assert.strictEqual(semanticBefore.length > 0, true);
    assert.strictEqual(semanticAfter.length > 0, true);

    // Strong enough consistency check for deterministic stub embeddings:
    // same result ids for the same semantic query.
    assert.deepStrictEqual(semanticAfter, semanticBefore);

    // ---------------------------------------------------------
    // Extra direct spot checks
    // ---------------------------------------------------------
    const a2 = (await compacted.getDocument('a2', 'articles')) as Document;
    const u1 = (await compacted.getDocument('u1', 'users')) as Document;
    const l1 = (await compacted.getDocument('l1', 'logs')) as Document;

    assert.strictEqual(a2.getId(), 'a2');
    assert.strictEqual(u1.getId(), 'u1');
    assert.strictEqual(l1.getId(), 'l1');

    await assert.rejects(() => compacted.getDocument('a4', 'articles'));
    await assert.rejects(() => compacted.getDocument('u2', 'users'));
    await assert.rejects(() => compacted.getDocument('l2', 'logs'));
  });
});
