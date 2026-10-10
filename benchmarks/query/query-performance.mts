/** Capped SQL benchmark: existing MockFile storage, no model downloads. */
import fs from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { MockFile } from '../../tests/helpers/mockfile.mjs';
import { SimpleDbms } from '../../src/database/simpledbms.mjs';
import { QueryLanguage } from '../../src/query/querylanguage.mjs';
import type { RecordStore } from '../../src/storage/records/recordstore.mjs';

const sizes = (process.env['QUERY_BENCH_SIZES'] ?? '1000,2000,5000,10000').split(',').map(Number);
const tag = process.env['QUERY_BENCH_TAG'] ?? 'after';
const repetitions = 40;
const results: Record<string, string | number>[] = [];
const raw: Record<string, string | number>[] = [];
for (const n of sizes) {
  let embeddings = 0;
  const db = await SimpleDbms.create(new MockFile(4096), new MockFile(4096), {
    dimension: 4,
    embeddingFn: (text) => {
      embeddings++;
      return Promise.resolve(new Float32Array([text.length, 1, 2, 3]));
    },
  });
  await db.setFieldIndexed('docs', 'body', false);
  for (let i = 0; i < n; i++)
    await db.insertDocumentObject('docs', {
      id: `id${String(i).padStart(6, '0')}`,
      year: i,
      category: `c${i % 10}`,
      title: `title ${i}`,
      body: `body ${i}`,
    });
  await db.commit();
  const ql = new QueryLanguage(db);
  const store = (db as unknown as { dbmsback: { recordStore: RecordStore } }).dbmsback.recordStore;
  const read = store.readRecord.bind(store);
  let reads = 0;
  store.readRecord = (...args) => {
    reads++;
    return read(...args);
  };
  const queries = [
    ['id', "SELECT id FROM docs WHERE id = 'id000000'"],
    ['conjunction', "SELECT id FROM docs WHERE body = 'body 0' AND id = 'id000000'"],
    ['indexed', "SELECT id FROM docs WHERE category = 'c0'"],
    ['unindexed', "SELECT id FROM docs WHERE body = 'body 0'"],
    ['range', 'SELECT id FROM docs WHERE year BETWEEN 10 AND 19'],
    ['primary-range', "SELECT id FROM docs WHERE id BETWEEN 'id000010' AND 'id000019'"],
    ['string-range', "SELECT id FROM docs WHERE category BETWEEN 'c3' AND 'c4'"],
    ['limit', 'SELECT id FROM docs LIMIT 10'],
    ['sort', 'SELECT id FROM docs ORDER BY year DESC LIMIT 10'],
    ['aggregate', 'SELECT category, COUNT(*) AS n FROM docs GROUP BY category'],
    ['update', "UPDATE docs SET title = 'new title', body = 'new body' WHERE id = 'id000000'"],
  ];
  const idRows = (numbers: number[]) => numbers.map((i) => ({ id: `id${String(i).padStart(6, '0')}` }));
  const all = Array.from({ length: n }, (_, i) => i);
  const expected: Record<string, unknown[]> = {
    id: idRows([0]),
    conjunction: idRows([0]),
    indexed: idRows(all.filter((i) => i % 10 === 0)),
    unindexed: idRows([0]),
    range: idRows(all.filter((i) => i >= 10 && i <= 19)),
    'primary-range': idRows(all.filter((i) => i >= 10 && i <= 19)),
    'string-range': idRows(all.filter((i) => i % 10 === 3 || i % 10 === 4)),
    limit: idRows(all.slice(0, 10)),
    sort: idRows(all.slice(-10).reverse()),
    aggregate: Array.from({ length: Math.min(n, 10) }, (_, i) => ({
      category: `c${i}`,
      n: Math.floor((n - 1 - i) / 10) + 1,
    })),
    update: idRows([0]),
  };
  for (const [operation, sql] of queries) {
    if (process.env['QUERY_BENCH_OPERATIONS'] && !process.env['QUERY_BENCH_OPERATIONS'].split(',').includes(operation))
      continue;
    for (let i = 0; i < 5; i++) await ql.execute(sql);
    const samples: number[] = [];
    const startReads = reads,
      startEmbeddings = embeddings;
    let rows = 0;
    for (let i = 0; i < repetitions; i++) {
      const beforeReads = reads,
        beforeEmbeddings = embeddings;
      const start = performance.now();
      const actual = await ql.execute(sql);
      const ms = performance.now() - start;
      rows = actual.length;
      // Outside the timing: verify exact values, including sort/LIMIT order.
      if (['sort', 'limit'].includes(operation)) assert.deepEqual(actual, expected[operation]);
      else
        assert.deepEqual(
          actual.map((row) => JSON.stringify(row)).sort(),
          expected[operation].map((row) => JSON.stringify(row)).sort(),
        );
      samples.push(ms);
      raw.push({
        n,
        operation,
        sample: i,
        ms,
        reads: reads - beforeReads,
        embeddings: embeddings - beforeEmbeddings,
        rows,
      });
    }
    samples.sort((a, b) => a - b);
    results.push({
      n,
      operation,
      p50Ms: samples[Math.floor(samples.length / 2)],
      p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
      reads: (reads - startReads) / repetitions,
      embeddings: (embeddings - startEmbeddings) / repetitions,
      rows,
      samples: repetitions,
    });
    if (operation === 'update') {
      const changed = JSON.parse(await db.getDocumentById('docs', 'id000000')) as Record<string, unknown>;
      assert.deepEqual(changed, { id: 'id000000', year: 0, category: 'c0', title: 'new title', body: 'new body' });
    }
  }
  await db.commit();
  await db.close();
}
const directory = new URL('./results/', import.meta.url);
await fs.mkdir(directory, { recursive: true });
for (const [suffix, rows] of [
  ['', results],
  ['-raw', raw],
] as const) {
  const columns = Object.keys(rows[0]);
  await fs.writeFile(
    new URL(`${tag}${suffix}.csv`, directory),
    [columns.join(','), ...rows.map((row) => columns.map((key) => row[key]).join(','))].join('\n') + '\n',
  );
}
await fs.writeFile(
  new URL(`${tag}.json`, directory),
  JSON.stringify(
    {
      runtime: process.version,
      cpu: os.cpus()[0]?.model,
      platform: process.platform,
      sizes,
      repetitions,
      warmup: 5,
      storage: 'MockFile 4096-byte blocks',
      semantic: '4D deterministic mock encoder; timings exclude commit and setup',
      results,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(results, null, 2));
