// @author: Alec Van Vlerken
// @date: 2026-04-24

import assert from 'assert';
import { describe, it, beforeEach } from 'vitest';

import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../../database/dbmsback.mjs';
import { JSONtoDocument, type Document } from '../../database/document.mjs';
import { vacuumCompactInto } from '../compaction.mjs';
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

describe('compaction.mjs', () => {
  let source: DbmsBack;
  let temp: { data: MockFile; log: MockFile };

  beforeEach(async () => {
    source = await makeDbmsBack();
    temp = makeTempFiles();
  });

  // ---------------------------------------------------------
  // vacuumCompactInto()
  // ---------------------------------------------------------
  it('runs vacuum compaction and returns a valid result', async () => {
    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'hello',
        }),
        'articles',
      ),
    );

    await source.commit();

    const result = await vacuumCompactInto({
      source,
      tempDataFile: temp.data,
      tempLogFile: temp.log,
      validate: true,
      rebuildHnsw: true,
    });

    assert.strictEqual(result.collectionsCopied, 1);
    assert.strictEqual(result.documentsCopied, 1);
    assert.strictEqual(result.validated, true);

    const copied = (await result.target.getDocument('1', 'articles')) as Document;
    assert.strictEqual(copied.getId(), '1');
    assert.strictEqual(copied.getCollectionName(), 'articles');
  });

  it('passes progress events through the façade', async () => {
    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'hello',
        }),
        'articles',
      ),
    );

    await source.commit();

    const progressEvents: VacuumProgress[] = [];

    const result = await vacuumCompactInto({
      source,
      tempDataFile: temp.data,
      tempLogFile: temp.log,
      validate: true,
      rebuildHnsw: true,
      onProgress: (progress) => {
        progressEvents.push(progress);
      },
    });

    assert.strictEqual(result.collectionsCopied, 1);
    assert.strictEqual(progressEvents.length > 0, true);
    assert.strictEqual(progressEvents[0].phase, 'preflight');
    assert.strictEqual(progressEvents[progressEvents.length - 1].phase, 'done');
  });

  it('returns validated = false when validation is disabled', async () => {
    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'hello',
        }),
        'articles',
      ),
    );

    await source.commit();

    const result = await vacuumCompactInto({
      source,
      tempDataFile: temp.data,
      tempLogFile: temp.log,
      validate: false,
      rebuildHnsw: true,
    });

    assert.strictEqual(result.collectionsCopied, 1);
    assert.strictEqual(result.documentsCopied, 1);
    assert.strictEqual(result.validated, false);
  });

  it('preserves metadata-only collections', async () => {
    source.setFieldCompressionDefaults('articles', { title: 'gzip' });
    await source.commit();

    const result = await vacuumCompactInto({
      source,
      tempDataFile: temp.data,
      tempLogFile: temp.log,
      validate: true,
      rebuildHnsw: true,
    });

    assert.strictEqual(result.collectionsCopied, 1);
    assert.strictEqual(result.documentsCopied, 0);
    assert.strictEqual(result.validated, true);

    const compressionMeta = result.target.getVacuumCompressionMetaSnapshot();
    assert.deepStrictEqual(compressionMeta['articles'], { title: 'gzip' });
  });

  it('forwards errors from the vacuum service', async () => {
    const resultPromise = vacuumCompactInto({
      source,
      tempDataFile: source.getVacuumDataFile() as MockFile,
      tempLogFile: temp.log,
      validate: true,
      rebuildHnsw: true,
    });

    await assert.rejects(() => resultPromise);
  });
});
