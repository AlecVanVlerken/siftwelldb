import assert from 'assert';
import { describe, it } from 'vitest';

import { MockFile } from '../core/mockfile.mjs';
import { DbmsBack } from '../dbms/dbmsback.mjs';
import { JSONtoDocument, type Document } from '../dbms/document.mjs';
import { CompactionMetricsCollector } from './compactionmetrics.mjs';

async function makeDb(): Promise<DbmsBack> {
  const db = new DbmsBack(new MockFile(4096), new MockFile(4096));
  await db.create();
  return db;
}

describe('CompactionMetricsCollector', () => {
  it('collects sane storage metrics without changing logical contents', async () => {
    const db = await makeDb();
    await db.insertDocument(JSONtoDocument(JSON.stringify({ id: 'a1', title: 'alpha' }), 'articles'));
    await db.insertDocument(JSONtoDocument(JSON.stringify({ id: 'a2', title: 'beta' }), 'articles'));
    await db.commit();

    const metrics = await new CompactionMetricsCollector(db).collect();

    assert(metrics.fileSizeBytes > 0);
    assert(metrics.liveDataBytes > 0);
    assert(metrics.totalBlocks >= metrics.usedBlocks);
    assert.strictEqual(metrics.wastedBytes, metrics.freeBlocks * 4096);
    assert.strictEqual(metrics.amplification, metrics.fileSizeBytes / metrics.liveDataBytes);
    assert.strictEqual(((await db.getDocument('a1', 'articles')) as Document).getId(), 'a1');
  });

  it('reports a free tail when one is present', async () => {
    const db = await makeDb();
    await db.insertDocument(JSONtoDocument(JSON.stringify({ id: 'keep', title: 'kept' }), 'articles'));
    await db.commit();
    await db.insertDocument(JSONtoDocument(JSON.stringify({ id: 'drop', title: 'tail' }), 'articles'));
    await db.commit();
    await db.deleteDocument('drop', 'articles');
    await db.commit();

    const metrics = await new CompactionMetricsCollector(db).collect();

    assert((metrics.freeTailBlocks ?? 0) >= 1);
    assert(metrics.freeBlocks >= (metrics.freeTailBlocks ?? 0));
  });
});
