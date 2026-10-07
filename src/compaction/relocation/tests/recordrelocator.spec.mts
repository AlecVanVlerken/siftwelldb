// @author: Alec Van Vlerken
// @date: 2026-05-05

import assert from 'assert';
import { describe, it } from 'vitest';

import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../../../database/dbmsback.mjs';
import { documentToJSON, JSONtoDocument, type Document } from '../../../database/document.mjs';
import { relocateRecords } from '../../compaction.mjs';

async function makeDbmsBack(hnswConfig?: HnswConfig): Promise<DbmsBack> {
  const data = new MockFile(4096);
  const log = new MockFile(4096);
  const db = new DbmsBack(data, log, hnswConfig);
  await db.create();
  return db;
}

function makeEmbedding(text: string): Float32Array {
  const vector = new Float32Array(4);
  for (let i = 0; i < text.length; i++) {
    vector[i % vector.length] += text.charCodeAt(i);
  }
  return vector;
}

describe('RecordRelocator', () => {
  it('relocates a logical document while preserving id and secondary index access', async () => {
    const source = await makeDbmsBack();
    const first = { id: 'a1', tag: 'db', title: 'record relocation' };
    const second = { id: 'a2', tag: 'db', title: 'other article' };

    await source.insertDocument(JSONtoDocument(JSON.stringify(first), 'articles'));
    await source.insertDocument(JSONtoDocument(JSON.stringify(second), 'articles'));
    await source.commit();

    const before = documentToJSON((await source.getDocument('a1', 'articles')) as Document);
    const result = await relocateRecords(source, [{ collection: 'articles', id: 'a1' }]);
    await source.commit();

    assert.strictEqual(result.relocatedDocuments, 1);
    assert.strictEqual(documentToJSON((await source.getDocument('a1', 'articles')) as Document), before);

    const cursor = await source.cursor('articles', 'tag', 'db');
    const ids: Array<string | number> = [];
    for await (const doc of cursor) {
      ids.push(doc.getId());
    }

    assert.deepStrictEqual(ids.sort(), ['a1', 'a2']);
  });

  it('updates HNSW document locations when relocating an indexed document', async () => {
    const source = await makeDbmsBack({
      dimension: 4,
      embeddingFn: (text) => Promise.resolve(makeEmbedding(text)),
      M: 4,
      efConstruction: 16,
      efSearch: 8,
    });

    const doc = { id: 'semantic-1', body: 'unique relocation search text' };
    await source.insertDocument(JSONtoDocument(JSON.stringify(doc), 'articles'));
    await source.commit();

    const before = await source.semanticSearch('articles', 'unique relocation', 1);
    assert.strictEqual(before.length, 1);
    assert.strictEqual(before[0].getId(), 'semantic-1');

    const result = await relocateRecords(source, [{ collection: 'articles', id: 'semantic-1' }]);
    await source.commit();

    assert.strictEqual(result.relocatedDocuments, 1);

    const after = await source.semanticSearch('articles', 'unique relocation', 1);
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].getId(), 'semantic-1');
    assert.strictEqual(documentToJSON(after[0]), JSON.stringify(doc));
  });
});
