// @author: Alec Van Vlerken
// @date: 2026-05-06

import assert from 'assert';
import { describe, it } from 'vitest';

import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { DbmsBack } from '../../../database/dbmsback.mjs';
import { JSONtoDocument, type Document } from '../../../database/document.mjs';
import { reclaimFreeTail } from '../../compaction.mjs';

async function makeDbmsBack(data: MockFile, log: MockFile): Promise<DbmsBack> {
  const db = new DbmsBack(data, log);
  await db.create();
  return db;
}

describe('TailReclaimer', () => {
  it('reclaims a free database tail and preserves reopenability', async () => {
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const db = await makeDbmsBack(data, log);

    await db.insertDocument(JSONtoDocument(JSON.stringify({ id: 'keep', title: 'kept document' }), 'articles'));
    await db.commit();

    await db.insertDocument(JSONtoDocument(JSON.stringify({ id: 'drop', title: 'tail document' }), 'articles'));
    await db.commit();

    const beforeSize = (await data.stat()).size;
    await db.deleteDocument('drop', 'articles');

    const removedBlocks = await reclaimFreeTail(db);
    const afterSize = (await data.stat()).size;

    assert(removedBlocks >= 1);
    assert.strictEqual(beforeSize - afterSize, removedBlocks * 4096);
    assert.strictEqual(((await db.getDocument('keep', 'articles')) as Document).getFields()['title'], 'kept document');
    await assert.rejects(() => db.getDocument('drop', 'articles'), /Document not found/);

    await db.close();
    const reopened = await DbmsBack.open(data, log);

    assert.strictEqual(
      ((await reopened.getDocument('keep', 'articles')) as Document).getFields()['title'],
      'kept document',
    );
    await assert.rejects(() => reopened.getDocument('drop', 'articles'), /Document not found/);
    await reopened.close();
  });

  it('returns zero when no free suffix is available', async () => {
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const db = await makeDbmsBack(data, log);

    await db.insertDocument(JSONtoDocument(JSON.stringify({ id: 'only', title: 'live tail' }), 'articles'));
    await db.commit();

    const removedBlocks = await reclaimFreeTail(db);

    assert.strictEqual(removedBlocks, 0);
    assert.strictEqual(((await db.getDocument('only', 'articles')) as Document).getId(), 'only');
    await db.close();
  });
});
