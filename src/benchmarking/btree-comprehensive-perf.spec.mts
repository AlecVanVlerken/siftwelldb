// Comprehensive B+ Tree Performance Tests
// Same format as btree-performance.spec.mts: X-axis = tree size, Y-axis = operation time

import { describe, it, expect } from 'vitest';
import { MockFile } from '../core/mockfile.mjs';
import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { BlockNodeStorage } from '../btree/nodestorage.mjs';
import { BPlusTree } from '../btree/btree.mjs';
import { writeFileSync } from 'fs';

const RESULTS_DIR = 'src/benchmarking/results/';

// Helper to generate key buffer of specific size
function makeKey(i: number, size: number = 8): Buffer {
  const key = Buffer.alloc(size);
  key.writeDoubleBE(i, 0);
  // Fill rest with zeros (already done by alloc)
  return key;
}

// Helper to generate value buffer of specific size
function makeValue(i: number, size: number = 4): Buffer {
  const val = Buffer.alloc(size);
  val.writeUInt32BE(i, 0);
  return val;
}

// Fisher-Yates shuffle
function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

describe('B+ Tree Comprehensive Performance', () => {
  const COMMIT_INTERVAL = 1000;

  // ============================================================
  // TEST 1: GET PERFORMANCE (time as tree grows)
  // Format: [[get_times...], []] - same as original
  // X-axis = tree size when GET was performed
  // ============================================================
  it('GET performance as tree grows', async () => {
    const count = 20000;
    const runs = 3;
    const allGetResults: number[][] = [];

    for (let run = 0; run < runs; run++) {
      const dataFile = new MockFile(256);
      const logFile = new MockFile(4096);
      const atomicFile = new AtomicFile(dataFile, logFile);
      const freeBlockFile = new FreeBlockFile(atomicFile, 4096);
      await freeBlockFile.create();
      await freeBlockFile.open();
      const storage = new BlockNodeStorage(freeBlockFile);
      const tree = await BPlusTree.create(storage);

      const getResult: number[] = [];

      // Shuffle indices for random insert order
      const indices = shuffle(Array.from({ length: count }, (_, i) => i));
      const insertedKeys: number[] = [];

      // Insert keys one by one, and after each insert, do a GET on a random existing key
      for (let idx = 0; idx < count; idx++) {
        const i = indices[idx];
        await tree.insert(makeKey(i), makeValue(i));
        insertedKeys.push(i);

        // GET a random key from what we've inserted so far
        const randomIdx = Math.floor(Math.random() * insertedKeys.length);
        const queryKey = insertedKeys[randomIdx];

        const start = performance.now();
        await tree.get(makeKey(queryKey));
        getResult.push(performance.now() - start);

        if ((idx + 1) % COMMIT_INTERVAL === 0) {
          await freeBlockFile.commit();
        }
      }

      await freeBlockFile.commit();
      allGetResults.push(getResult);
      await freeBlockFile.close();
      console.log(`GET: Run ${run + 1}/${runs} complete`);
    }

    // Average across runs
    const avgGetResult = Array.from(
      { length: count },
      (_, i) => allGetResults.reduce((sum, r) => sum + r[i], 0) / runs,
    );

    writeFileSync(RESULTS_DIR + 'btree_get_performance.txt', `[[${avgGetResult.join(', ')}], []]`);

    const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    console.log(`GET avg first 1000: ${avg(avgGetResult.slice(0, 1000)).toFixed(4)} ms`);
    console.log(`GET avg last 1000: ${avg(avgGetResult.slice(-1000)).toFixed(4)} ms`);
    expect(avgGetResult.length).toBe(count);
  }, 600000);

  // ============================================================
  // TEST 2: KEY SIZE COMPARISON
  // Format: [[insert_times...], [delete_times...]]
  // ============================================================
  it('performance with different KEY sizes', async () => {
    const count = 15000;
    const runs = 3;
    const keySizes = [8, 32, 128];

    for (const keySize of keySizes) {
      const allInsertResults: number[][] = [];
      const allDeleteResults: number[][] = [];

      for (let run = 0; run < runs; run++) {
        const dataFile = new MockFile(256);
        const logFile = new MockFile(4096);
        const atomicFile = new AtomicFile(dataFile, logFile);
        const freeBlockFile = new FreeBlockFile(atomicFile, 4096);
        await freeBlockFile.create();
        await freeBlockFile.open();
        const storage = new BlockNodeStorage(freeBlockFile);
        const tree = await BPlusTree.create(storage);

        const insertResult: number[] = [];
        const deleteResult: number[] = [];

        const indices = shuffle(Array.from({ length: count }, (_, i) => i));

        // Insert (tree grows: 0 → count)
        for (let idx = 0; idx < count; idx++) {
          const i = indices[idx];
          const key = Buffer.alloc(keySize);
          key.writeDoubleBE(i, 0);
          const value = makeValue(i, 20);

          const start = performance.now();
          await tree.insert(key, value);
          insertResult.push(performance.now() - start);

          if ((idx + 1) % COMMIT_INTERVAL === 0) {
            await freeBlockFile.commit();
          }
        }
        await freeBlockFile.commit();

        // Delete (tree shrinks: count → 0)
        const deleteOrder = shuffle(indices);
        for (let idx = 0; idx < count; idx++) {
          const i = deleteOrder[idx];
          const key = Buffer.alloc(keySize);
          key.writeDoubleBE(i, 0);

          const start = performance.now();
          await tree.delete(key);
          deleteResult.push(performance.now() - start);

          if ((idx + 1) % COMMIT_INTERVAL === 0) {
            await freeBlockFile.commit();
          }
        }

        allInsertResults.push(insertResult);
        allDeleteResults.push(deleteResult);
        await freeBlockFile.close();
      }

      // Average
      const avgInsert = Array.from(
        { length: count },
        (_, i) => allInsertResults.reduce((sum, r) => sum + r[i], 0) / runs,
      );
      const avgDelete = Array.from(
        { length: count },
        (_, i) => allDeleteResults.reduce((sum, r) => sum + r[i], 0) / runs,
      );

      writeFileSync(
        RESULTS_DIR + `btree_keysize_${keySize}_performance.txt`,
        `[[${avgInsert.join(', ')}], [${avgDelete.join(', ')}]]`,
      );

      const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
      console.log(`KeySize ${keySize}: Insert=${avg(avgInsert).toFixed(4)}ms, Delete=${avg(avgDelete).toFixed(4)}ms`);
    }
  }, 900000);

  // ============================================================
  // TEST 3: VALUE SIZE COMPARISON
  // Format: [[insert_times...], [delete_times...]]
  // ============================================================
  it('performance with different VALUE sizes', async () => {
    const count = 15000;
    const runs = 3;
    const valueSizes = [10, 100, 500];

    for (const valueSize of valueSizes) {
      const allInsertResults: number[][] = [];
      const allDeleteResults: number[][] = [];

      for (let run = 0; run < runs; run++) {
        const dataFile = new MockFile(256);
        const logFile = new MockFile(4096);
        const atomicFile = new AtomicFile(dataFile, logFile);
        const freeBlockFile = new FreeBlockFile(atomicFile, 4096);
        await freeBlockFile.create();
        await freeBlockFile.open();
        const storage = new BlockNodeStorage(freeBlockFile);
        const tree = await BPlusTree.create(storage);

        const insertResult: number[] = [];
        const deleteResult: number[] = [];

        const indices = shuffle(Array.from({ length: count }, (_, i) => i));

        // Insert
        for (let idx = 0; idx < count; idx++) {
          const i = indices[idx];
          const key = makeKey(i);
          const value = makeValue(i, valueSize);

          const start = performance.now();
          await tree.insert(key, value);
          insertResult.push(performance.now() - start);

          if ((idx + 1) % COMMIT_INTERVAL === 0) {
            await freeBlockFile.commit();
          }
        }
        await freeBlockFile.commit();

        // Delete
        const deleteOrder = shuffle(indices);
        for (let idx = 0; idx < count; idx++) {
          const i = deleteOrder[idx];
          const key = makeKey(i);

          const start = performance.now();
          await tree.delete(key);
          deleteResult.push(performance.now() - start);

          if ((idx + 1) % COMMIT_INTERVAL === 0) {
            await freeBlockFile.commit();
          }
        }

        allInsertResults.push(insertResult);
        allDeleteResults.push(deleteResult);
        await freeBlockFile.close();
      }

      // Average
      const avgInsert = Array.from(
        { length: count },
        (_, i) => allInsertResults.reduce((sum, r) => sum + r[i], 0) / runs,
      );
      const avgDelete = Array.from(
        { length: count },
        (_, i) => allDeleteResults.reduce((sum, r) => sum + r[i], 0) / runs,
      );

      writeFileSync(
        RESULTS_DIR + `btree_valuesize_${valueSize}_performance.txt`,
        `[[${avgInsert.join(', ')}], [${avgDelete.join(', ')}]]`,
      );

      const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
      console.log(
        `ValueSize ${valueSize}: Insert=${avg(avgInsert).toFixed(4)}ms, Delete=${avg(avgDelete).toFixed(4)}ms`,
      );
    }
  }, 900000);

  // ============================================================
  // TEST 4: SEQUENTIAL vs RANDOM access pattern
  // Format: [[insert_times...], [delete_times...]]
  // ============================================================
  it('sequential vs random access patterns', async () => {
    const count = 20000;
    const runs = 3;
    const patterns = ['sequential', 'random'];

    for (const pattern of patterns) {
      const allInsertResults: number[][] = [];
      const allDeleteResults: number[][] = [];

      for (let run = 0; run < runs; run++) {
        const dataFile = new MockFile(256);
        const logFile = new MockFile(4096);
        const atomicFile = new AtomicFile(dataFile, logFile);
        const freeBlockFile = new FreeBlockFile(atomicFile, 4096);
        await freeBlockFile.create();
        await freeBlockFile.open();
        const storage = new BlockNodeStorage(freeBlockFile);
        const tree = await BPlusTree.create(storage);

        const insertResult: number[] = [];
        const deleteResult: number[] = [];

        // Create indices based on pattern
        let indices = Array.from({ length: count }, (_, i) => i);
        if (pattern === 'random') {
          indices = shuffle(indices);
        }

        // Insert
        for (let idx = 0; idx < count; idx++) {
          const i = indices[idx];
          const key = makeKey(i);
          const value = makeValue(i);

          const start = performance.now();
          await tree.insert(key, value);
          insertResult.push(performance.now() - start);

          if ((idx + 1) % COMMIT_INTERVAL === 0) {
            await freeBlockFile.commit();
          }
        }
        await freeBlockFile.commit();

        // Delete (same pattern)
        if (pattern === 'random') {
          indices = shuffle(indices);
        }
        for (let idx = 0; idx < count; idx++) {
          const i = indices[idx];
          const key = makeKey(i);

          const start = performance.now();
          await tree.delete(key);
          deleteResult.push(performance.now() - start);

          if ((idx + 1) % COMMIT_INTERVAL === 0) {
            await freeBlockFile.commit();
          }
        }

        allInsertResults.push(insertResult);
        allDeleteResults.push(deleteResult);
        await freeBlockFile.close();
      }

      // Average
      const avgInsert = Array.from(
        { length: count },
        (_, i) => allInsertResults.reduce((sum, r) => sum + r[i], 0) / runs,
      );
      const avgDelete = Array.from(
        { length: count },
        (_, i) => allDeleteResults.reduce((sum, r) => sum + r[i], 0) / runs,
      );

      writeFileSync(
        RESULTS_DIR + `btree_${pattern}_performance.txt`,
        `[[${avgInsert.join(', ')}], [${avgDelete.join(', ')}]]`,
      );

      const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
      console.log(`${pattern}: Insert=${avg(avgInsert).toFixed(4)}ms, Delete=${avg(avgDelete).toFixed(4)}ms`);
    }
  }, 600000);
});
