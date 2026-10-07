// @author: Alec Van Vlerken
// @date: 2026-05-05

import assert from 'assert';
import { describe, it } from 'vitest';

import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { DbmsBack } from '../../../database/dbmsback.mjs';
import { JSONtoDocument, type Document } from '../../../database/document.mjs';
import { relocateBtreeNodes } from '../../compaction.mjs';

async function makeDbmsBack(): Promise<DbmsBack> {
  const data = new MockFile(4096);
  const log = new MockFile(4096);
  const db = new DbmsBack(data, log);
  await db.create();
  return db;
}

describe('BtreeRelocator', () => {
  it('relocates explicit index roots and keeps reads and cursor queries working', async () => {
    const source = await makeDbmsBack();

    for (const doc of [
      { id: 'a1', tag: 'db', title: 'first' },
      { id: 'a2', tag: 'db', title: 'second' },
      { id: 'a3', tag: 'storage', title: 'third' },
    ]) {
      await source.insertDocument(JSONtoDocument(JSON.stringify(doc), 'articles'));
    }
    await source.commit();

    const beforeMeta = source.getVacuumCollectionMetaSnapshot();
    const oldIdRoot = beforeMeta['articles']['id'][0];
    const oldTagRoot = beforeMeta['articles']['tag'][0];

    const result = await relocateBtreeNodes(source, [
      { collection: 'articles', field: 'id', blockNumber: oldIdRoot },
      { collection: 'articles', field: 'tag', blockNumber: oldTagRoot },
    ]);
    await source.commit();

    const afterMeta = source.getVacuumCollectionMetaSnapshot();
    assert.strictEqual(result.relocatedBtreeNodes, 2);
    assert.notStrictEqual(afterMeta['articles']['id'][0], oldIdRoot);
    assert.notStrictEqual(afterMeta['articles']['tag'][0], oldTagRoot);
    assert.strictEqual(((await source.getDocument('a1', 'articles')) as Document).getId(), 'a1');
    assert.strictEqual(((await source.getDocument('a2', 'articles')) as Document).getFields()['title'], 'second');

    const cursor = await source.cursor('articles', 'tag', 'db');
    const ids: Array<string | number> = [];
    for await (const doc of cursor) {
      ids.push(doc.getId());
    }

    assert.deepStrictEqual(ids.sort(), ['a1', 'a2', 'a3']);
  });
});
