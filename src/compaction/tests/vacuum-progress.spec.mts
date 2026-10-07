// @author: Alec Van Vlerken
// @date: 2026-04-28

import assert from 'assert';
import { describe, it } from 'vitest';

import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../../database/dbmsback.mjs';
import { JSONtoDocument, documentToJSON, type Document } from '../../database/document.mjs';
import { CollectionCatalog } from '../vacuum/collectioncatalog.mjs';
import type { VacuumProgress } from '../vacuum/vacuumtypes.mjs';

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

type DbSnapshot = {
  collections: string[];
  docsByCollection: Record<string, Record<string, string>>;
  compressionMeta: Record<string, Record<string, string>>;
};

async function snapshotDb(db: DbmsBack): Promise<DbSnapshot> {
  const catalog = new CollectionCatalog(db);
  const collections = catalog.listCollections();

  const docsByCollection: Record<string, Record<string, string>> = {};
  for (const collection of collections) {
    docsByCollection[collection] = {};

    if (!catalog.hasIdTree(collection)) {
      continue;
    }

    const docs = await db.cursor(collection, 'id');
    for await (const doc of docs) {
      docsByCollection[collection][String(doc.getId())] = documentToJSON(doc);
    }
  }

  const compressionMeta = db.getVacuumCompressionMetaSnapshot() as Record<string, Record<string, string>>;

  return {
    collections,
    docsByCollection,
    compressionMeta,
  };
}

describe('vacuum progress and consistency', () => {
  it('reports progress while preserving compressed documents and semantic search', async () => {
    const source = await makeDbmsBack(testHnswConfig);

    // ---------------------------------------------------------
    // Build a small realistic workload
    // ---------------------------------------------------------
    source.setFieldCompressionDefaults('articles', {
      title: 'gzip',
      body: 'deflate',
    });

    source.setFieldCompressionDefaults('logs', {
      message: 'gzip',
    });

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: 'a1',
          title: 'vacuum systems',
          body: 'introduction to compaction',
          category: 'db',
        }),
        'articles',
      ),
    );

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: 'a2',
          title: 'database internals',
          body: 'free blocks and metadata',
          category: 'db',
        }),
        'articles',
      ),
    );

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: 'a3',
          title: 'semantic search',
          body: 'hnsw index rebuild',
          category: 'ai',
        }),
        'articles',
      ),
    );

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: 'a4',
          title: 'temporary article',
          body: 'this will be deleted',
          category: 'tmp',
        }),
        'articles',
      ),
    );

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: 'u1',
          name: 'Alice',
          city: 'Leuven',
        }),
        'users',
      ),
    );

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: 'u2',
          name: 'Bob',
          city: 'Ghent',
        }),
        'users',
      ),
    );

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: 'l1',
          message: 'initial log entry',
          level: 'info',
        }),
        'logs',
      ),
    );

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: 'l2',
          message: 'second log entry',
          level: 'warn',
        }),
        'logs',
      ),
    );

    // Deletes create holes / fragmentation pressure.
    await source.deleteDocument('a4', 'articles');
    await source.deleteDocument('u2', 'users');

    // Edit also causes delete + reinsert in your DBMS.
    await source.editDocumentByID('articles', 'a2', 'body', 'free blocks and metadata updated');
    await source.editDocumentByID('logs', 'l1', 'message', 'initial log entry edited');

    await source.commit();

    // ---------------------------------------------------------
    // Snapshot + demo info before vacuum
    // ---------------------------------------------------------
    const beforeSnapshot = await snapshotDb(source);

    const semanticBefore = await source.semanticSearch('articles', 'semantic compaction', 5);

    // ---------------------------------------------------------
    // Run vacuum
    // ---------------------------------------------------------
    const temp = makeTempFiles();
    const progressEvents: VacuumProgress[] = [];

    const compacted = await source.vacuumCompactInto(temp.data, temp.log, (progress) => {
      progressEvents.push(progress);
    });

    // ---------------------------------------------------------
    // Snapshot + demo info after vacuum
    // ---------------------------------------------------------
    const afterSnapshot = await snapshotDb(compacted);

    const semanticAfter = await compacted.semanticSearch('articles', 'semantic compaction', 5);

    // ---------------------------------------------------------
    // Proof that logical behavior stayed consistent
    // ---------------------------------------------------------
    assert.deepStrictEqual(afterSnapshot.collections, beforeSnapshot.collections);
    assert.deepStrictEqual(afterSnapshot.docsByCollection, beforeSnapshot.docsByCollection);
    assert.deepStrictEqual(afterSnapshot.compressionMeta, beforeSnapshot.compressionMeta);

    // Spot-check key documents after vacuum.
    const article = (await compacted.getDocument('a2', 'articles')) as Document;
    const user = (await compacted.getDocument('u1', 'users')) as Document;
    const log = (await compacted.getDocument('l1', 'logs')) as Document;

    assert.strictEqual(article.getId(), 'a2');
    assert.strictEqual(user.getId(), 'u1');
    assert.strictEqual(log.getId(), 'l1');

    // Deleted documents must still be gone.
    await assert.rejects(() => compacted.getDocument('a4', 'articles'));
    await assert.rejects(() => compacted.getDocument('u2', 'users'));

    // Semantic search should still work after rebuild.
    assert.strictEqual(semanticBefore.length > 0, true);
    assert.strictEqual(semanticAfter.length > 0, true);

    // At minimum, the same semantic document should still be reachable.
    const beforeIds = new Set(semanticBefore.map((doc) => String(doc.getId())));
    const afterIds = new Set(semanticAfter.map((doc) => String(doc.getId())));
    assert.strictEqual(beforeIds.has('a3'), true);
    assert.strictEqual(afterIds.has('a3'), true);

    // Progress sanity.
    assert.strictEqual(progressEvents.length > 0, true);
    assert.strictEqual(progressEvents[0].phase, 'preflight');
    assert.strictEqual(progressEvents[progressEvents.length - 1].phase, 'done');
  });
});
