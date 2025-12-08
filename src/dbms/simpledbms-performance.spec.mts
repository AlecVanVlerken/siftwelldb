// author: Thomas Dumon
// date: 2025-12-08

import { describe, expect, it, beforeEach } from 'vitest';
import { MockFile } from '../core/mockfile.mjs';
import { SimpleDbms } from './simpledbms.mjs';
import { writeFileSync } from 'fs';

describe('SimpleDbms Performance', () => {
  describe('timing of insertion of a lot of documents', () => {
    it('should insert many documents', async () => {
      const count = 50000;
      const runs = 10;
      const allResults: number[][] = [];

      for (let run = 0; run < runs; run++) {
        // Create fresh dbms for each run
        const dataFile = new MockFile(256);
        const logFile = new MockFile(4096);
        const simpleDbms = await SimpleDbms.create(dataFile, logFile);

        const runResult: number[] = [];

        // Create array of indices and shuffle (Fisher-Yates)
        const indices = Array.from({ length: count }, (_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [indices[i], indices[j]] = [indices[j], indices[i]];
        }

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
          runResult.push(end - start);
        }
        await simpleDbms.commit(); // Commit once at end, not per insert
        allResults.push(runResult);
      }

      // Calculate average for each ith insertion across all runs
      const averageResult: number[] = [];
      for (let i = 0; i < count; i++) {
        let sum = 0;
        for (let run = 0; run < runs; run++) {
          sum += allResults[run][i];
        }
        averageResult.push(sum / runs);
      }

      // Write results to file for plotting (Python list syntax)
      writeFileSync('performance_results.txt', `[${averageResult.join(', ')}]`);
      expect(averageResult.length).toBe(count);
    }, 600000); // 10 minute timeout
  });
});
