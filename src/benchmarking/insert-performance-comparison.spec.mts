// Combined INSERT Performance Test: B+ Tree vs DBMS
// Tests INSERT performance as data grows for both systems
//
// Methodology fixes applied:
// - Pre-allocate all key/value buffers before the benchmark loop to eliminate
//   GC pressure from per-iteration Buffer.alloc calls
// - Exclude array bookkeeping from timed region
// - Track commit overhead separately so it doesn't pollute insert measurements
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

function printBatchSummary(label: string, insertTimes: number[], batchSize: number) {
  const batches: { size: number; avgMs: number }[] = [];
  for (let i = 0; i < insertTimes.length; i += batchSize) {
    const batch = insertTimes.slice(i, i + batchSize);
    batches.push({
      size: i + batch.length,
      avgMs: batch.reduce((s, t) => s + t, 0) / batch.length,
    });
  }
  console.log(`\n  ${label} – batch-averaged INSERT time (per ${batchSize} ops):`);
  console.log('  ' + '-'.repeat(40));
  for (const b of batches) {
    console.log(`    n=${String(b.size).padStart(7)}  avg=${b.avgMs.toFixed(4)} ms`);
  }
}

describe('INSERT Performance Comparison', () => {
  const COUNT = 400000;
  const RUNS = 3;
  const COMMIT_INTERVAL = 1000;
  const BATCH_REPORT_SIZE = 20000;

  it('B+ Tree INSERT performance (400k)', async () => {
    const allInsertResults: number[][] = [];

    for (let run = 0; run < RUNS; run++) {
      const dataFile = new MockFile(256);
      const logFile = new MockFile(4096);
      const atomicFile = new AtomicFile(dataFile, logFile);
      const freeBlockFile = new FreeBlockFile(atomicFile, 4096);
      await freeBlockFile.create();
      await freeBlockFile.open();
      const storage = new BlockNodeStorage(freeBlockFile);
      const tree = await BPlusTree.create(storage);

      const insertResult: number[] = [];
      const indices = shuffle(Array.from({ length: COUNT }, (_, i) => i));

      // Pre-allocate all key and value buffers to avoid GC pressure in the hot loop
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

      for (let idx = 0; idx < COUNT; idx++) {
        const start = performance.now();
        await tree.insert(keyBuffers[idx], valueBuffers[idx]);
        const elapsed = performance.now() - start;
        insertResult.push(elapsed);

        if ((idx + 1) % COMMIT_INTERVAL === 0) {
          await freeBlockFile.commit();
        }
      }

      await freeBlockFile.commit();
      allInsertResults.push(insertResult);
      await freeBlockFile.close();
      console.log(`B+ Tree INSERT: Run ${run + 1}/${RUNS} complete`);
    }

    const avgInsertResult = Array.from(
      { length: COUNT },
      (_, i) => allInsertResults.reduce((sum, r) => sum + r[i], 0) / RUNS,
    );

    writeFileSync(RESULTS_DIR + 'btree_insert_400k.txt', `[${avgInsertResult.join(', ')}]`);

    const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    console.log(`B+ Tree INSERT avg first 1000: ${avg(avgInsertResult.slice(0, 1000)).toFixed(4)} ms`);
    console.log(`B+ Tree INSERT avg last 1000: ${avg(avgInsertResult.slice(-1000)).toFixed(4)} ms`);
    printBatchSummary('B+ Tree', avgInsertResult, BATCH_REPORT_SIZE);
    expect(avgInsertResult.length).toBe(COUNT);
  }, 3600000);

  it('DBMS INSERT performance (400k)', async () => {
    const allInsertResults: number[][] = [];

    for (let run = 0; run < RUNS; run++) {
      const dataFile = new MockFile(256);
      const logFile = new MockFile(4096);
      const db = await SimpleDbms.create(dataFile, logFile);
      const insertResult: number[] = [];

      const indices = shuffle(Array.from({ length: COUNT }, (_, i) => i));

      // Pre-allocate documents to avoid string allocation in the hot loop
      const documents: string[] = new Array(COUNT);
      for (let idx = 0; idx < COUNT; idx++) {
        const i = indices[idx];
        documents[idx] = JSON.stringify({ id: `doc${i}`, value: i });
      }

      for (let idx = 0; idx < COUNT; idx++) {
        const start = performance.now();
        await db.insertDocument('test', documents[idx]);
        const elapsed = performance.now() - start;
        insertResult.push(elapsed);

        if ((idx + 1) % COMMIT_INTERVAL === 0) {
          await db.commit();
        }
      }

      await db.commit();
      allInsertResults.push(insertResult);
      await db.close();
      console.log(`DBMS INSERT: Run ${run + 1}/${RUNS} complete`);
    }

    const avgInsertResult = Array.from(
      { length: COUNT },
      (_, i) => allInsertResults.reduce((sum, r) => sum + r[i], 0) / RUNS,
    );

    writeFileSync(RESULTS_DIR + 'dbms_insert_400k.txt', `[${avgInsertResult.join(', ')}]`);

    const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    console.log(`DBMS INSERT avg first 1000: ${avg(avgInsertResult.slice(0, 1000)).toFixed(4)} ms`);
    console.log(`DBMS INSERT avg last 1000: ${avg(avgInsertResult.slice(-1000)).toFixed(4)} ms`);
    printBatchSummary('DBMS', avgInsertResult, BATCH_REPORT_SIZE);
    expect(avgInsertResult.length).toBe(COUNT);
  }, 3600000);
});
