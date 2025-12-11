// Comprehensive DBMS Performance Tests
// Outputs time-series data for graphing (same format as simpledbms-performance.spec.mts)

import { describe, it, expect } from 'vitest';
import { MockFile } from '../core/mockfile.mjs';
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

// Helper to create documents with specified number of indexed fields
function makeDoc(id: string, numIndexedFields: number, fieldSize: number = 20): string {
  const doc: Record<string, unknown> = { id };
  for (let i = 0; i < numIndexedFields; i++) {
    doc[`field${i}`] = `value${i}`.padEnd(fieldSize, 'x');
  }
  // Add a non-indexed field
  doc['_data'] = 'non-indexed-data';
  return JSON.stringify(doc);
}

describe('DBMS Comprehensive Performance', () => {
  const COMMIT_INTERVAL = 500;

  // ============================================================
  // TEST 1: GET/READ PERFORMANCE (time-series)
  // ============================================================
  it('GET performance after populating database', async () => {
    const count = 10000;
    const runs = 3;
    const allGetResults: number[][] = [];

    for (let run = 0; run < runs; run++) {
      const dataFile = new MockFile(256);
      const logFile = new MockFile(4096);
      const db = await SimpleDbms.create(dataFile, logFile);
      const getResult: number[] = [];

      // Pre-populate
      for (let i = 0; i < count; i++) {
        await db.insertDocument('test', makeDoc(`doc${i}`, 1));
        if ((i + 1) % COMMIT_INTERVAL === 0) {
          await db.commit();
        }
      }
      await db.commit();

      // Measure get() for each document (random order)
      const indices = shuffle(Array.from({ length: count }, (_, i) => i));
      for (let idx = 0; idx < count; idx++) {
        const docId = `doc${indices[idx]}`;
        const start = performance.now();
        await db.getDocumentById('test', docId);
        getResult.push(performance.now() - start);
      }

      allGetResults.push(getResult);
      await db.close();
      console.log(`DBMS GET: Run ${run + 1}/${runs} complete`);
    }

    // Average
    const avgGetResult = Array.from({ length: count }, (_, i) =>
      allGetResults.reduce((sum, r) => sum + r[i], 0) / runs
    );

    writeFileSync(
      RESULTS_DIR + 'dbms_get_performance.txt',
      `[[${avgGetResult.join(', ')}], []]`
    );

    console.log(`DBMS GET: Mean=${(avgGetResult.reduce((a, b) => a + b) / count).toFixed(4)}ms`);
    expect(avgGetResult.length).toBe(count);
  }, 600000);

  // ============================================================
  // TEST 2: MULTIPLE COLLECTIONS
  // ============================================================
  it('performance across multiple collections', async () => {
    const collectionCounts = [1, 5, 10];
    const docsPerCollection = 5000;
    const runs = 3;

    for (const numCollections of collectionCounts) {
      const totalDocs = numCollections * docsPerCollection;
      const allInsertResults: number[][] = [];
      const allDeleteResults: number[][] = [];

      for (let run = 0; run < runs; run++) {
        const dataFile = new MockFile(256);
        const logFile = new MockFile(4096);
        const db = await SimpleDbms.create(dataFile, logFile);

        const insertResult: number[] = [];
        const deleteResult: number[] = [];

        // Insert across collections (round-robin)
        for (let i = 0; i < totalDocs; i++) {
          const collection = `collection${i % numCollections}`;
          const docId = `doc${Math.floor(i / numCollections)}`;
          const doc = makeDoc(docId, 1);
          const start = performance.now();
          await db.insertDocument(collection, doc);
          insertResult.push(performance.now() - start);
          if ((i + 1) % COMMIT_INTERVAL === 0) {
            await db.commit();
          }
        }
        await db.commit();

        // Delete (random order)
        const indices = shuffle(Array.from({ length: totalDocs }, (_, i) => i));
        for (let idx = 0; idx < totalDocs; idx++) {
          const i = indices[idx];
          const collection = `collection${i % numCollections}`;
          const docId = `doc${Math.floor(i / numCollections)}`;
          const start = performance.now();
          await db.deleteDocumentById(collection, docId);
          deleteResult.push(performance.now() - start);
          if ((idx + 1) % COMMIT_INTERVAL === 0) {
            await db.commit();
          }
        }

        allInsertResults.push(insertResult);
        allDeleteResults.push(deleteResult);
        await db.close();
      }

      // Average
      const avgInsert = Array.from({ length: totalDocs }, (_, i) =>
        allInsertResults.reduce((sum, r) => sum + r[i], 0) / runs
      );
      const avgDelete = Array.from({ length: totalDocs }, (_, i) =>
        allDeleteResults.reduce((sum, r) => sum + r[i], 0) / runs
      );

      writeFileSync(
        RESULTS_DIR + `dbms_${numCollections}collections_performance.txt`,
        `[[${avgInsert.join(', ')}], [${avgDelete.join(', ')}]]`
      );

      console.log(`${numCollections} collections: Insert=${(avgInsert.reduce((a, b) => a + b) / totalDocs).toFixed(4)}ms, Delete=${(avgDelete.reduce((a, b) => a + b) / totalDocs).toFixed(4)}ms`);
    }
  }, 900000);

  // ============================================================
  // TEST 3: NUMBER OF INDEXED FIELDS
  // ============================================================
  it('performance with different numbers of indexed fields', async () => {
    const count = 10000;
    const runs = 3;
    const indexedFieldCounts = [1, 3, 5];

    for (const numIndexed of indexedFieldCounts) {
      const allInsertResults: number[][] = [];
      const allDeleteResults: number[][] = [];

      for (let run = 0; run < runs; run++) {
        const dataFile = new MockFile(256);
        const logFile = new MockFile(4096);
        const db = await SimpleDbms.create(dataFile, logFile);

        const insertResult: number[] = [];
        const deleteResult: number[] = [];
        const indices = shuffle(Array.from({ length: count }, (_, i) => i));

        // Insert
        for (let idx = 0; idx < count; idx++) {
          const i = indices[idx];
          const doc = makeDoc(`doc${i}`, numIndexed);
          const start = performance.now();
          await db.insertDocument('test', doc);
          insertResult.push(performance.now() - start);
          if ((idx + 1) % COMMIT_INTERVAL === 0) {
            await db.commit();
          }
        }
        await db.commit();

        // Delete (re-shuffle)
        const deleteOrder = shuffle(indices);
        for (let idx = 0; idx < count; idx++) {
          const i = deleteOrder[idx];
          const start = performance.now();
          await db.deleteDocumentById('test', `doc${i}`);
          deleteResult.push(performance.now() - start);
          if ((idx + 1) % COMMIT_INTERVAL === 0) {
            await db.commit();
          }
        }

        allInsertResults.push(insertResult);
        allDeleteResults.push(deleteResult);
        await db.close();
      }

      // Average
      const avgInsert = Array.from({ length: count }, (_, i) =>
        allInsertResults.reduce((sum, r) => sum + r[i], 0) / runs
      );
      const avgDelete = Array.from({ length: count }, (_, i) =>
        allDeleteResults.reduce((sum, r) => sum + r[i], 0) / runs
      );

      writeFileSync(
        RESULTS_DIR + `dbms_${numIndexed}indexed_performance.txt`,
        `[[${avgInsert.join(', ')}], [${avgDelete.join(', ')}]]`
      );

      console.log(`${numIndexed} indexed fields: Insert=${(avgInsert.reduce((a, b) => a + b) / count).toFixed(4)}ms, Delete=${(avgDelete.reduce((a, b) => a + b) / count).toFixed(4)}ms`);
    }
  }, 900000);

  // ============================================================
  // TEST 4: DOCUMENT SIZE (via field size)
  // ============================================================
  it('performance with different document sizes', async () => {
    const count = 10000;
    const runs = 3;
    const docSizes = [
      { name: 'small', fields: 1, fieldSize: 10 },
      { name: 'medium', fields: 3, fieldSize: 50 },
      { name: 'large', fields: 5, fieldSize: 100 },
    ];

    for (const config of docSizes) {
      const allInsertResults: number[][] = [];
      const allDeleteResults: number[][] = [];

      for (let run = 0; run < runs; run++) {
        const dataFile = new MockFile(256);
        const logFile = new MockFile(4096);
        const db = await SimpleDbms.create(dataFile, logFile);

        const insertResult: number[] = [];
        const deleteResult: number[] = [];
        const indices = shuffle(Array.from({ length: count }, (_, i) => i));

        // Insert
        for (let idx = 0; idx < count; idx++) {
          const i = indices[idx];
          const doc = makeDoc(`doc${i}`, config.fields, config.fieldSize);
          const start = performance.now();
          await db.insertDocument('test', doc);
          insertResult.push(performance.now() - start);
          if ((idx + 1) % COMMIT_INTERVAL === 0) {
            await db.commit();
          }
        }
        await db.commit();

        // Delete
        const deleteOrder = shuffle(indices);
        for (let idx = 0; idx < count; idx++) {
          const i = deleteOrder[idx];
          const start = performance.now();
          await db.deleteDocumentById('test', `doc${i}`);
          deleteResult.push(performance.now() - start);
          if ((idx + 1) % COMMIT_INTERVAL === 0) {
            await db.commit();
          }
        }

        allInsertResults.push(insertResult);
        allDeleteResults.push(deleteResult);
        await db.close();
      }

      // Average
      const avgInsert = Array.from({ length: count }, (_, i) =>
        allInsertResults.reduce((sum, r) => sum + r[i], 0) / runs
      );
      const avgDelete = Array.from({ length: count }, (_, i) =>
        allDeleteResults.reduce((sum, r) => sum + r[i], 0) / runs
      );

      writeFileSync(
        RESULTS_DIR + `dbms_${config.name}docs_performance.txt`,
        `[[${avgInsert.join(', ')}], [${avgDelete.join(', ')}]]`
      );

      console.log(`${config.name} docs: Insert=${(avgInsert.reduce((a, b) => a + b) / count).toFixed(4)}ms, Delete=${(avgDelete.reduce((a, b) => a + b) / count).toFixed(4)}ms`);
    }
  }, 900000);
});

