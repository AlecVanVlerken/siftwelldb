// Comprehensive B+ Tree Performance Tests
// Outputs time-series data for graphing (same format as btree-performance.spec.mts)

import { describe, it, expect } from 'vitest';
import { MockFile } from '../core/mockfile.mjs';
import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { BlockNodeStorage } from '../btree/nodestorage.mjs';
import { BPlusTree } from '../btree/btree.mjs';
import { writeFileSync } from 'fs';

const RESULTS_DIR = 'src/benchmarking/results/';

// Helper to create a fresh B+ tree
async function createTree(blockSize: number = 4096) {
  const dataFile = new MockFile(256);
  const logFile = new MockFile(4096);
  const atomicFile = new AtomicFile(dataFile, logFile);
  const freeBlockFile = new FreeBlockFile(atomicFile, blockSize);
  await freeBlockFile.create();
  await freeBlockFile.open();
  const storage = new BlockNodeStorage(freeBlockFile);
  const tree = await BPlusTree.create(storage);
  return { tree, freeBlockFile, storage };
}

// Helper to generate key buffer of specific size
function makeKey(i: number, size: number = 12): Buffer {
  const key = Buffer.alloc(size);
  key.write(`key${i.toString().padStart(size - 4, '0')}`.slice(0, size));
  return key;
}

// Helper to generate value buffer of specific size
function makeValue(i: number, size: number = 10): Buffer {
  const base = `val${i}`;
  return Buffer.from(base.padEnd(size, 'x').slice(0, size));
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
  // TEST 1: GET/READ PERFORMANCE (time-series)
  // Output: [[get_times...]] for each tree size
  // ============================================================
  it('GET performance at different tree sizes', async () => {
    const count = 20000;
    const runs = 3;
    const allGetResults: number[][] = [];

    for (let run = 0; run < runs; run++) {
      const { tree, freeBlockFile } = await createTree();
      const getResult: number[] = [];

      // Pre-populate entire tree
      for (let i = 0; i < count; i++) {
        await tree.insert(makeKey(i), makeValue(i));
        if ((i + 1) % COMMIT_INTERVAL === 0) {
          await freeBlockFile.commit();
        }
      }
      await freeBlockFile.commit();

      // Measure get() at each "tree size" by querying random keys
      // We'll query count times, simulating get at different points
      const indices = shuffle(Array.from({ length: count }, (_, i) => i));
      for (let idx = 0; idx < count; idx++) {
        const key = makeKey(indices[idx]);
        const start = performance.now();
        await tree.get(key);
        getResult.push(performance.now() - start);
      }

      allGetResults.push(getResult);
      await freeBlockFile.close();
      console.log(`GET: Run ${run + 1}/${runs} complete`);
    }

    // Average across runs
    const avgGetResult = Array.from({ length: count }, (_, i) =>
      allGetResults.reduce((sum, r) => sum + r[i], 0) / runs
    );

    // Output format: [[get_times...], []] (empty delete for compatibility)
    writeFileSync(
      RESULTS_DIR + 'btree_get_performance.txt',
      `[[${avgGetResult.join(', ')}], []]`
    );

    console.log(`GET: Mean=${(avgGetResult.reduce((a, b) => a + b) / count).toFixed(4)}ms`);
    expect(avgGetResult.length).toBe(count);
  }, 600000);

  // ============================================================
  // TEST 2: KEY SIZE COMPARISON (separate files per key size)
  // ============================================================
  it('performance with different KEY sizes', async () => {
    const count = 15000;
    const runs = 3;
    const keySizes = [8, 32, 128];

    for (const keySize of keySizes) {
      const allInsertResults: number[][] = [];
      const allDeleteResults: number[][] = [];

      for (let run = 0; run < runs; run++) {
        const { tree, freeBlockFile } = await createTree();
        const insertResult: number[] = [];
        const deleteResult: number[] = [];

        const indices = shuffle(Array.from({ length: count }, (_, i) => i));

        // Insert
        for (let idx = 0; idx < count; idx++) {
          const i = indices[idx];
          const key = makeKey(i, keySize);
          const value = makeValue(i, 20);
          const start = performance.now();
          await tree.insert(key, value);
          insertResult.push(performance.now() - start);
          if ((idx + 1) % COMMIT_INTERVAL === 0) {
            await freeBlockFile.commit();
          }
        }
        await freeBlockFile.commit();

        // Delete (re-shuffle)
        const deleteOrder = shuffle(indices);
        for (let idx = 0; idx < count; idx++) {
          const i = deleteOrder[idx];
          const key = makeKey(i, keySize);
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
      const avgInsert = Array.from({ length: count }, (_, i) =>
        allInsertResults.reduce((sum, r) => sum + r[i], 0) / runs
      );
      const avgDelete = Array.from({ length: count }, (_, i) =>
        allDeleteResults.reduce((sum, r) => sum + r[i], 0) / runs
      );

      writeFileSync(
        RESULTS_DIR + `btree_keysize_${keySize}_performance.txt`,
        `[[${avgInsert.join(', ')}], [${avgDelete.join(', ')}]]`
      );

      console.log(`KeySize ${keySize}: Insert=${(avgInsert.reduce((a, b) => a + b) / count).toFixed(4)}ms, Delete=${(avgDelete.reduce((a, b) => a + b) / count).toFixed(4)}ms`);
    }
  }, 900000);

  // ============================================================
  // TEST 3: VALUE SIZE COMPARISON
  // ============================================================
  it('performance with different VALUE sizes', async () => {
    const count = 15000;
    const runs = 3;
    const valueSizes = [10, 100, 500];

    for (const valueSize of valueSizes) {
      const allInsertResults: number[][] = [];
      const allDeleteResults: number[][] = [];

      for (let run = 0; run < runs; run++) {
        const { tree, freeBlockFile } = await createTree();
        const insertResult: number[] = [];
        const deleteResult: number[] = [];

        const indices = shuffle(Array.from({ length: count }, (_, i) => i));

        // Insert
        for (let idx = 0; idx < count; idx++) {
          const i = indices[idx];
          const key = makeKey(i, 12);
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
          const key = makeKey(i, 12);
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
      const avgInsert = Array.from({ length: count }, (_, i) =>
        allInsertResults.reduce((sum, r) => sum + r[i], 0) / runs
      );
      const avgDelete = Array.from({ length: count }, (_, i) =>
        allDeleteResults.reduce((sum, r) => sum + r[i], 0) / runs
      );

      writeFileSync(
        RESULTS_DIR + `btree_valuesize_${valueSize}_performance.txt`,
        `[[${avgInsert.join(', ')}], [${avgDelete.join(', ')}]]`
      );

      console.log(`ValueSize ${valueSize}: Insert=${(avgInsert.reduce((a, b) => a + b) / count).toFixed(4)}ms, Delete=${(avgDelete.reduce((a, b) => a + b) / count).toFixed(4)}ms`);
    }
  }, 900000);

  // ============================================================
  // TEST 4: SEQUENTIAL vs RANDOM access pattern
  // ============================================================
  it('sequential vs random access patterns', async () => {
    const count = 20000;
    const runs = 3;
    const patterns = ['sequential', 'random'];

    for (const pattern of patterns) {
      const allInsertResults: number[][] = [];
      const allDeleteResults: number[][] = [];

      for (let run = 0; run < runs; run++) {
        const { tree, freeBlockFile } = await createTree();
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
      const avgInsert = Array.from({ length: count }, (_, i) =>
        allInsertResults.reduce((sum, r) => sum + r[i], 0) / runs
      );
      const avgDelete = Array.from({ length: count }, (_, i) =>
        allDeleteResults.reduce((sum, r) => sum + r[i], 0) / runs
      );

      writeFileSync(
        RESULTS_DIR + `btree_${pattern}_performance.txt`,
        `[[${avgInsert.join(', ')}], [${avgDelete.join(', ')}]]`
      );

      console.log(`${pattern}: Insert=${(avgInsert.reduce((a, b) => a + b) / count).toFixed(4)}ms, Delete=${(avgDelete.reduce((a, b) => a + b) / count).toFixed(4)}ms`);
    }
  }, 600000);
});

