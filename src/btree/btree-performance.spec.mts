// B+ Tree Performance Test
// Tests raw B+ tree insert/delete performance without the DBMS layer

import { describe, expect, it } from 'vitest';
import { MockFile } from '../core/mockfile.mjs';
import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { BlockNodeStorage } from './nodestorage.mjs';
import { BPlusTree } from './btree.mjs';
import { writeFileSync } from 'fs';

describe('BPlusTree Performance', () => {
  it('should insert and delete many keys with O(log n) performance', async () => {
    const count = 100000;
    const runs = 10;
    const allInsertResults: number[][] = [];
    const allDeleteResults: number[][] = [];

    for (let run = 0; run < runs; run++) {
      // Create fresh B+ tree for each run
      const dataFile = new MockFile(256);
      const logFile = new MockFile(4096);
      const atomicFile = new AtomicFile(dataFile, logFile);
      const freeBlockFile = new FreeBlockFile(atomicFile, 256);
      await freeBlockFile.create();
      await freeBlockFile.open();
      const storage = new BlockNodeStorage(freeBlockFile);
      const tree = await BPlusTree.create(storage);

      const insertResult: number[] = [];
      const deleteResult: number[] = [];

      // Create array of indices and shuffle (Fisher-Yates)
      const indices = Array.from({ length: count }, (_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }

      // Insert keys in random order
      for (const i of indices) {
        // Create a simple key-value pair
        const keyBuffer = Buffer.alloc(8);
        keyBuffer.writeDoubleBE(i, 0);
        const valueBuffer = Buffer.alloc(4);
        valueBuffer.writeUInt32BE(i, 0);

        const start = performance.now();
        await tree.insert(keyBuffer, valueBuffer);
        const end = performance.now();
        insertResult.push(end - start);
      }

      await freeBlockFile.commit();
      console.log(`Run ${run + 1}: All ${count} keys inserted.`);

      // Shuffle indices again for deletion order
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }

      // Delete keys in random order
      for (const i of indices) {
        const keyBuffer = Buffer.alloc(8);
        keyBuffer.writeDoubleBE(i, 0);

        const start = performance.now();
        await tree.delete(keyBuffer);
        const end = performance.now();
        deleteResult.push(end - start);
      }

      await freeBlockFile.commit();
      console.log(`Run ${run + 1}: All ${count} keys deleted.`);

      allInsertResults.push(insertResult);
      allDeleteResults.push(deleteResult);

      await freeBlockFile.close();
      console.log(`Completed run ${run + 1} of ${runs}`);
    }

    // Calculate average for each ith insertion across all runs
    const averageInsertResult: number[] = [];
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let run = 0; run < runs; run++) {
        sum += allInsertResults[run][i];
      }
      averageInsertResult.push(sum / runs);
    }

    // Calculate average for each ith deletion across all runs
    const averageDeleteResult: number[] = [];
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let run = 0; run < runs; run++) {
        sum += allDeleteResults[run][i];
      }
      averageDeleteResult.push(sum / runs);
    }

    // Write results to file for plotting
    writeFileSync(
      'btree_performance_results.txt',
      `[[${averageInsertResult.join(', ')}], [${averageDeleteResult.join(', ')}]]`,
    );

    // Print some statistics
    const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    const first1000 = averageInsertResult.slice(0, 1000);
    const last1000 = averageInsertResult.slice(-1000);
    console.log(`Insert avg first 1000: ${avg(first1000).toFixed(4)} ms`);
    console.log(`Insert avg last 1000: ${avg(last1000).toFixed(4)} ms`);
    console.log(`Insert ratio: ${(avg(last1000) / avg(first1000)).toFixed(2)}x`);

    const dfirst1000 = averageDeleteResult.slice(0, 1000);
    const dlast1000 = averageDeleteResult.slice(-1000);
    console.log(`Delete avg first 1000: ${avg(dfirst1000).toFixed(4)} ms`);
    console.log(`Delete avg last 1000: ${avg(dlast1000).toFixed(4)} ms`);
    console.log(`Delete ratio: ${(avg(dlast1000) / avg(dfirst1000)).toFixed(2)}x`);

    expect(averageInsertResult.length).toBe(count);
    expect(averageDeleteResult.length).toBe(count);
  }, 1200000); // 20 minute timeout
});
