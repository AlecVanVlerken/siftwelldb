// Combined INSERT Performance Test: B+ Tree vs DBMS
// Tests INSERT performance as data grows for both systems

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

describe('INSERT Performance Comparison', () => {
  const COUNT = 200000;
  const RUNS = 3;
  const COMMIT_INTERVAL = 1000;

  it('B+ Tree INSERT performance (200k)', async () => {
    const allGetResults: number[][] = [];

    for (let run = 0; run < RUNS; run++) {
      const dataFile = new MockFile(256);
      const logFile = new MockFile(4096);
      const atomicFile = new AtomicFile(dataFile, logFile);
      const freeBlockFile = new FreeBlockFile(atomicFile, 4096);
      await freeBlockFile.create();
      //await freeBlockFile.open();
      const storage = new BlockNodeStorage(freeBlockFile);
      const tree = await BPlusTree.create(storage);

      const getResult: number[] = [];
      const indices = shuffle(Array.from({ length: COUNT }, (_, i) => i));
      const insertedKeys: number[] = [];

      for (let idx = 0; idx < COUNT; idx++) {
        const i = indices[idx];
        const keyBuffer = Buffer.alloc(8);
        keyBuffer.writeDoubleBE(i, 0);
        const valueBuffer = Buffer.alloc(4);
        valueBuffer.writeUInt32BE(i, 0);

        const start = performance.now();
        await tree.insert(keyBuffer, valueBuffer);
        insertedKeys.push(i);
        getResult.push(performance.now() - start);

        if ((idx + 1) % COMMIT_INTERVAL === 0) {
          await freeBlockFile.commit();
        }
      }

      await freeBlockFile.commit();
      allGetResults.push(getResult);
      await freeBlockFile.close();
      console.log(`B+ Tree INSERT: Run ${run + 1}/${RUNS} complete`);
    }

    const avgGetResult = Array.from(
      { length: COUNT },
      (_, i) => allGetResults.reduce((sum, r) => sum + r[i], 0) / RUNS,
    );

    writeFileSync(RESULTS_DIR + 'btree_insert_200k.txt', `[${avgGetResult.join(', ')}]`);

    const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    console.log(`B+ Tree INSERT avg first 1000: ${avg(avgGetResult.slice(0, 1000)).toFixed(4)} ms`);
    console.log(`B+ Tree INSERT avg last 1000: ${avg(avgGetResult.slice(-1000)).toFixed(4)} ms`);
    expect(avgGetResult.length).toBe(COUNT);
  }, 3600000);

  it('DBMS INSERT performance (200k)', async () => {
    const allGetResults: number[][] = [];

    for (let run = 0; run < RUNS; run++) {
      const dataFile = new MockFile(256);
      const logFile = new MockFile(4096);
      const db = await SimpleDbms.create(dataFile, logFile);
      const getResult: number[] = [];

      const indices = shuffle(Array.from({ length: COUNT }, (_, i) => i));
      const insertedIds: string[] = [];

      for (let idx = 0; idx < COUNT; idx++) {
        const i = indices[idx];
        const docId = `doc${i}`;
        const doc = JSON.stringify({ id: docId, value: i });
        const start = performance.now();
        await db.insertDocument('test', doc);
        getResult.push(performance.now() - start);
        insertedIds.push(docId);

        if ((idx + 1) % COMMIT_INTERVAL === 0) {
          await db.commit();
        }
      }

      await db.commit();
      allGetResults.push(getResult);
      await db.close();
      console.log(`DBMS INSERT: Run ${run + 1}/${RUNS} complete`);
    }

    const avgGetResult = Array.from(
      { length: COUNT },
      (_, i) => allGetResults.reduce((sum, r) => sum + r[i], 0) / RUNS,
    );

    writeFileSync(RESULTS_DIR + 'dbms_insert_200k.txt', `[${avgGetResult.join(', ')}]`);

    const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    console.log(`DBMS INSERT avg first 1000: ${avg(avgGetResult.slice(0, 1000)).toFixed(4)} ms`);
    console.log(`DBMS INSERT avg last 1000: ${avg(avgGetResult.slice(-1000)).toFixed(4)} ms`);
    expect(avgGetResult.length).toBe(COUNT);
  }, 3600000);
});
