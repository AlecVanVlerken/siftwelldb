// author: Thomas Dumon
// date: 2025-12-08

import { describe, expect, it, beforeEach } from 'vitest';
import { MockFile } from '../core/mockfile.mjs';
import { SimpleDbms } from './simpledbms.mjs';
import { writeFileSync } from 'fs';

describe('SimpleDbms Performance', () => {
  describe('timing of insertion and deletion of a lot of documents', () => {
    it('should insert and delete many documents', async () => {
      const count = 100000;
      const runs = 10;
      const allInsertResults: number[][] = [];
      const allDeleteResults: number[][] = [];

      for (let run = 0; run < runs; run++) {
        // Create fresh dbms for each run
        const dataFile = new MockFile(256);
        const logFile = new MockFile(4096);
        const simpleDbms = await SimpleDbms.create(dataFile, logFile);

        const insertResult: number[] = [];
        const deleteResult: number[] = [];

        // Create array of indices and shuffle (Fisher-Yates)
        const indices = Array.from({ length: count }, (_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [indices[i], indices[j]] = [indices[j], indices[i]];
        }

        // Insert documents in random order
        for (const i of indices) {
          const doc = {
            id: `rapid${i}`,
            value: i,
          };
          //start timer
          const start = performance.now();
          await simpleDbms.insertDocument('rapid', JSON.stringify(doc));
          //stop timer
          const end = performance.now();
          insertResult.push(end - start);
        }
        await simpleDbms.commit();
        console.log(`All ${count} documents inserted.`);

        // Shuffle indices again for deletion order
        for (let i = indices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [indices[i], indices[j]] = [indices[j], indices[i]];
        }
        console.log(`Deletion order randomized.`);
        // Delete documents in random order
        for (const i of indices) {
          //start timer
          const start = performance.now();
          await simpleDbms.deleteDocumentById('rapid', `rapid${i}`);
          //stop timer
          const end = performance.now();
          deleteResult.push(end - start);
        }
        await simpleDbms.commit();
        console.log(`All ${count} documents deleted.`);
        allInsertResults.push(insertResult);
        allDeleteResults.push(deleteResult);

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

      // Write results to file for plotting (Python list syntax)
      writeFileSync(
        'performance_results.txt',
        `[[${averageInsertResult.join(', ')}], [${averageDeleteResult.join(', ')}]]`,
      );
      expect(averageInsertResult.length).toBe(count);
      expect(averageDeleteResult.length).toBe(count);
    }, 1200000); // 20 minute timeout
  });
});
