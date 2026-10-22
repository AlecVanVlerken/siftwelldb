// @author: Alec Van Vlerken
// @date: 2026-04-24

import assert from 'assert';
import { describe, it, beforeEach, vi } from 'vitest';

import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../../../database/dbmsback.mjs';
import { safeDictionary } from '../../../database/identity.mjs';
import { JSONtoDocument, type Document } from '../../../database/document.mjs';
import { VacuumService } from '../vacuumservice.mjs';
import { VacuumValidator } from '../vacuumvalidator.mjs';
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

describe('vacuumservice.mjs', () => {
  let source: DbmsBack;
  let temp: { data: MockFile; log: MockFile };

  beforeEach(async () => {
    source = await makeDbmsBack();
    temp = makeTempFiles();
  });

  // ---------------------------------------------------------
  // run()
  // ---------------------------------------------------------
  it('runs the full vacuum workflow and returns a compacted target', async () => {
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

    const service = new VacuumService({
      source,
      tempDataFile: temp.data,
      tempLogFile: temp.log,
      validate: true,
      rebuildHnsw: true,
    });

    const result = await service.run();

    assert.strictEqual(result.collectionsCopied, 1);
    assert.strictEqual(result.documentsCopied, 1);
    assert.strictEqual(result.validated, true);

    const copied = (await result.target.getDocument('1', 'articles')) as Document;
    assert.strictEqual(copied.getId(), '1');
    assert.strictEqual(copied.getCollectionName(), 'articles');
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

    const service = new VacuumService({
      source,
      tempDataFile: temp.data,
      tempLogFile: temp.log,
      validate: false,
      rebuildHnsw: true,
    });

    const result = await service.run();

    assert.strictEqual(result.collectionsCopied, 1);
    assert.strictEqual(result.documentsCopied, 1);
    assert.strictEqual(result.validated, false);
  });

  it('preserves metadata-only collections', async () => {
    source.setFieldCompressionDefaults('articles', { title: 'gzip' });
    await source.commit();

    const service = new VacuumService({
      source,
      tempDataFile: temp.data,
      tempLogFile: temp.log,
      validate: true,
      rebuildHnsw: true,
    });

    const result = await service.run();

    assert.strictEqual(result.collectionsCopied, 1);
    assert.strictEqual(result.documentsCopied, 0);
    assert.strictEqual(result.validated, true);

    const compressionMeta = result.target.getVacuumCompressionMetaSnapshot();
    assert.deepStrictEqual(compressionMeta['articles'], safeDictionary({ title: 'gzip' }));
  });

  it('emits progress phases in the expected order', async () => {
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

    const service = new VacuumService({
      source,
      tempDataFile: temp.data,
      tempLogFile: temp.log,
      validate: true,
      rebuildHnsw: true,
      onProgress: (progress) => {
        progressEvents.push(progress);
      },
    });

    await service.run();

    assert.strictEqual(progressEvents.length > 0, true);
    assert.strictEqual(progressEvents[0].phase, 'preflight');
    assert.strictEqual(
      progressEvents.some((p) => p.phase === 'create-target'),
      true,
    );
    assert.strictEqual(
      progressEvents.some((p) => p.phase === 'copy-collection'),
      true,
    );
    assert.strictEqual(
      progressEvents.some((p) => p.phase === 'commit-target'),
      true,
    );
    assert.strictEqual(
      progressEvents.some((p) => p.phase === 'validate'),
      true,
    );
    assert.strictEqual(progressEvents[progressEvents.length - 1].phase, 'done');
    assert.strictEqual(progressEvents[1].phase, 'commit-source');
  });

  it('reports actual phase counts for each collection without an overall percentage', async () => {
    for (const [collection, count] of [
      ['articles', 3],
      ['users', 2],
    ] as const) {
      for (let id = 1; id <= count; id++) {
        await source.insertDocument(JSONtoDocument(JSON.stringify({ id, title: `${collection}-${id}` }), collection));
      }
    }
    source.setFieldCompressionDefaults('empty', { title: 'gzip' });
    const events: VacuumProgress[] = [];
    const service = new VacuumService({
      source,
      tempDataFile: temp.data,
      tempLogFile: temp.log,
      onProgress: (progress) => events.push(progress),
    });
    const result = await service.run();

    for (const phase of ['copy-collection', 'validate'] as const) {
      for (const [collection, total] of [
        ['articles', 3],
        ['users', 2],
      ] as const) {
        const updates = events.filter(
          (event) => event.phase === phase && event.collection === collection && event.total !== undefined,
        );
        assert.strictEqual(updates[0].processed, 0);
        assert.strictEqual(updates[updates.length - 1].processed, total);
        assert.strictEqual(updates[updates.length - 1].percentage, 100);
        let previous = -1;
        for (const update of updates) {
          assert.strictEqual(update.total, total);
          assert.strictEqual(update.unit, 'documents');
          assert.ok(update.processed! >= previous && update.processed! <= total);
          assert.strictEqual(update.percentage, Math.floor((update.processed! / total) * 100));
          previous = update.processed!;
        }
      }
    }
    assert.ok(events.filter((event) => event.collection === 'empty').every((event) => event.percentage === undefined));
    assert.ok(
      events
        .filter((event) => !['copy-collection', 'validate'].includes(event.phase))
        .every((event) => event.percentage === undefined),
    );
    assert.strictEqual(events.at(-1)?.phase, 'done');
    await result.target.close();
  });

  it('reports the lifecycle of an empty database without a fabricated denominator', async () => {
    const events: VacuumProgress[] = [];
    const result = await new VacuumService({
      source,
      tempDataFile: temp.data,
      tempLogFile: temp.log,
      onProgress: (progress) => events.push(progress),
    }).run();
    assert.deepStrictEqual(
      events.map((event) => event.phase),
      [
        'preflight',
        'commit-source',
        'create-target',
        'copy-collection',
        'commit-target',
        'validate',
        'validate',
        'done',
      ],
    );
    assert.ok(events.every((event) => event.percentage === undefined));
    assert.strictEqual(result.documentsCopied, 0);
    await result.target.close();
  });

  it('does not report done until validation succeeds and closes failed output', async () => {
    const events: VacuumProgress[] = [];
    const failure = new Error('controlled validation failure');
    let releaseValidation!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    let enteredValidation!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredValidation = resolve;
    });
    const validate = vi.spyOn(VacuumValidator.prototype, 'validate').mockImplementationOnce(async () => {
      enteredValidation();
      await hold;
      throw failure;
    });
    const close = vi.spyOn(DbmsBack.prototype, 'close');
    try {
      const operation = new VacuumService({
        source,
        tempDataFile: temp.data,
        tempLogFile: temp.log,
        onProgress: (progress) => events.push(progress),
      }).run();
      await entered;
      assert.strictEqual(events.at(-1)?.phase, 'validate');
      assert.strictEqual(
        events.some((event) => event.phase === 'done'),
        false,
      );
      releaseValidation();
      await assert.rejects(operation, (error) => error === failure);
      assert.strictEqual(
        events.some((event) => event.phase === 'done'),
        false,
      );
      assert.strictEqual(close.mock.calls.length, 1);
    } finally {
      releaseValidation();
      validate.mockRestore();
      close.mockRestore();
    }
  });

  // ---------------------------------------------------------
  // preflight checks
  // ---------------------------------------------------------
  it('rejects when temporary data file is the same object as the source data file', async () => {
    const service = new VacuumService({
      source,
      tempDataFile: source.getVacuumDataFile() as MockFile,
      tempLogFile: temp.log,
      validate: true,
      rebuildHnsw: true,
    });

    await assert.rejects(() => service.run());
  });

  it('rejects when temporary log file is the same object as the source log file', async () => {
    const service = new VacuumService({
      source,
      tempDataFile: temp.data,
      tempLogFile: source.getVacuumLogFile() as MockFile,
      validate: true,
      rebuildHnsw: true,
    });

    await assert.rejects(() => service.run());
  });

  it('rejects when HNSW-backed collections exist but HNSW rebuilding is disabled', async () => {
    source = await makeDbmsBack(testHnswConfig);
    temp = makeTempFiles();

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

    const service = new VacuumService({
      source,
      tempDataFile: temp.data,
      tempLogFile: temp.log,
      validate: true,
      rebuildHnsw: false,
    });

    await assert.rejects(() => service.run());
  });

  it('rejects when HNSW-backed collections exist but no HNSW config is available', async () => {
    const sourceWithHnsw = await makeDbmsBack(testHnswConfig);

    await sourceWithHnsw.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'semantic hello',
        }),
        'articles',
      ),
    );
    await sourceWithHnsw.commit();

    const reopenedWithoutConfig = await DbmsBack.open(
      sourceWithHnsw.getVacuumDataFile(),
      sourceWithHnsw.getVacuumLogFile(),
    );

    const freshTemp = makeTempFiles();

    const service = new VacuumService({
      source: reopenedWithoutConfig,
      tempDataFile: freshTemp.data,
      tempLogFile: freshTemp.log,
      validate: true,
      rebuildHnsw: true,
    });

    await assert.rejects(() => service.run());
  });

  // ---------------------------------------------------------
  // HNSW path
  // ---------------------------------------------------------
  it('creates a target with HNSW config and preserves semantic search capability', async () => {
    source = await makeDbmsBack(testHnswConfig);
    temp = makeTempFiles();

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

    const service = new VacuumService({
      source,
      tempDataFile: temp.data,
      tempLogFile: temp.log,
      validate: true,
      rebuildHnsw: true,
    });

    const result = await service.run();

    assert.strictEqual(result.collectionsCopied, 1);
    assert.strictEqual(result.documentsCopied, 1);
    assert.strictEqual(result.validated, true);

    const searchResults = await result.target.semanticSearch('articles', 'semantic', 5);
    assert.strictEqual(searchResults.length > 0, true);
  });
});
