// Combined GET Performance Test: B+ Tree vs DBMS
// Tests GET performance as data grows for both systems
//
// Methodology fixes applied:
// - Pre-allocate all key/value/query buffers before the benchmark loop to
//   eliminate GC pressure from per-iteration Buffer.alloc calls
// - Pre-generate random query indices so randomness overhead is outside timing
// - Only the get() call is inside the timed region
// - Output batch-averaged statistics for cleaner trend analysis

import { describe, it, expect } from 'vitest';
import { MockFile } from '../core/mockfile.mjs';
import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { BlockNodeStorage } from '../btree/nodestorage.mjs';
import { BPlusTree } from '../btree/btree.mjs';
import { SimpleDbms } from '../dbms/simpledbms.mjs';
import { writeFileSync } from 'fs';

const RESULTS_DIR = 'src/benchmarking/results/';

// Fisher-Yates shuffle
function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function printBatchSummary(label: string, times: number[], batchSize: number) {
  const batches: { size: number; avgMs: number }[] = [];
  for (let i = 0; i < times.length; i += batchSize) {
    const batch = times.slice(i, i + batchSize);
    batches.push({
      size: i + batch.length,
      avgMs: batch.reduce((s, t) => s + t, 0) / batch.length,
    });
  }
  console.log(`\n  ${label} – batch-averaged GET time (per ${batchSize} ops):`);
  console.log('  ' + '-'.repeat(40));
  for (const b of batches) {
    console.log(`    n=${String(b.size).padStart(7)}  avg=${b.avgMs.toFixed(4)} ms`);
  }
}

describe('GET Performance Comparison', () => {
  const COUNT = 200000;
  const RUNS = 3;
  const COMMIT_INTERVAL = 1000;
  const BATCH_REPORT_SIZE = 20000;

  it('B+ Tree GET performance (200k)', async () => {
    const allGetResults: number[][] = [];

    for (let run = 0; run < RUNS; run++) {
      const dataFile = new MockFile(256);
      const logFile = new MockFile(4096);
      const atomicFile = new AtomicFile(dataFile, logFile);
      const freeBlockFile = new FreeBlockFile(atomicFile, 4096);
      await freeBlockFile.create();
      await freeBlockFile.open();
      const storage = new BlockNodeStorage(freeBlockFile);
      const tree = await BPlusTree.create(storage);

      const getResult: number[] = [];
      const indices = shuffle(Array.from({ length: COUNT }, (_, i) => i));

      // Pre-allocate all insert buffers
      const keyBuffers: Buffer[] = new Array(COUNT);
      const valueBuffers: Buffer[] = new Array(COUNT);
      for (let idx = 0; idx < COUNT; idx++) {
        const i = indices[idx];
        const kb = Buffer.alloc(8);
        kb.writeDoubleBE(i, 0);
        keyBuffers[idx] = kb;
        const vb = Buffer.alloc(4);
        vb.writeUInt32BE(i, 0);
        valueBuffers[idx] = vb;
      }

      // Pre-generate random query indices (each queries a random key among those inserted so far)
      const queryIndices: number[] = new Array(COUNT);
      for (let idx = 0; idx < COUNT; idx++) {
        queryIndices[idx] = Math.floor(Math.random() * (idx + 1));
      }

      // Pre-allocate query key buffers
      const queryBuffers: Buffer[] = new Array(COUNT);
      for (let idx = 0; idx < COUNT; idx++) {
        const qi = indices[queryIndices[idx]];
        const qb = Buffer.alloc(8);
        qb.writeDoubleBE(qi, 0);
        queryBuffers[idx] = qb;
      }

      for (let idx = 0; idx < COUNT; idx++) {
        await tree.insert(keyBuffers[idx], valueBuffers[idx]);

        const start = performance.now();
        await tree.get(queryBuffers[idx]);
        getResult.push(performance.now() - start);

        if ((idx + 1) % COMMIT_INTERVAL === 0) {
          await freeBlockFile.commit();
        }
      }

      await freeBlockFile.commit();
      allGetResults.push(getResult);
      await freeBlockFile.close();
      console.log(`B+ Tree GET: Run ${run + 1}/${RUNS} complete`);
    }

    const avgGetResult = Array.from(
      { length: COUNT },
      (_, i) => allGetResults.reduce((sum, r) => sum + r[i], 0) / RUNS,
    );

    writeFileSync(RESULTS_DIR + 'btree_get_200k.txt', `[${avgGetResult.join(', ')}]`);

    const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    console.log(`B+ Tree GET avg first 1000: ${avg(avgGetResult.slice(0, 1000)).toFixed(4)} ms`);
    console.log(`B+ Tree GET avg last 1000: ${avg(avgGetResult.slice(-1000)).toFixed(4)} ms`);
    printBatchSummary('B+ Tree', avgGetResult, BATCH_REPORT_SIZE);
    expect(avgGetResult.length).toBe(COUNT);
  }, 3600000);

  it('DBMS GET performance (200k)', async () => {
    const allGetResults: number[][] = [];

    for (let run = 0; run < RUNS; run++) {
      const dataFile = new MockFile(256);
      const logFile = new MockFile(4096);
      const db = await SimpleDbms.create(dataFile, logFile);
      const getResult: number[] = [];

      const indices = shuffle(Array.from({ length: COUNT }, (_, i) => i));

      // Pre-allocate documents
      const documents: string[] = new Array(COUNT);
      for (let idx = 0; idx < COUNT; idx++) {
        const i = indices[idx];
        documents[idx] = JSON.stringify({ id: `doc${i}`, value: i });
      }

      // Pre-generate random query IDs
      const queryIds: string[] = new Array(COUNT);
      for (let idx = 0; idx < COUNT; idx++) {
        const qi = indices[Math.floor(Math.random() * (idx + 1))];
        queryIds[idx] = `doc${qi}`;
      }

      for (let idx = 0; idx < COUNT; idx++) {
        await db.insertDocument('test', documents[idx]);

        const start = performance.now();
        await db.getDocumentById('test', queryIds[idx]);
        getResult.push(performance.now() - start);

        if ((idx + 1) % COMMIT_INTERVAL === 0) {
          await db.commit();
        }
      }

      await db.commit();
      allGetResults.push(getResult);
      await db.close();
      console.log(`DBMS GET: Run ${run + 1}/${RUNS} complete`);
    }

    const avgGetResult = Array.from(
      { length: COUNT },
      (_, i) => allGetResults.reduce((sum, r) => sum + r[i], 0) / RUNS,
    );

    writeFileSync(RESULTS_DIR + 'dbms_get_200k.txt', `[${avgGetResult.join(', ')}]`);

    const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    console.log(`DBMS GET avg first 1000: ${avg(avgGetResult.slice(0, 1000)).toFixed(4)} ms`);
    console.log(`DBMS GET avg last 1000: ${avg(avgGetResult.slice(-1000)).toFixed(4)} ms`);
    printBatchSummary('DBMS', avgGetResult, BATCH_REPORT_SIZE);
    expect(avgGetResult.length).toBe(COUNT);
  }, 3600000);
});
