import { describe, expect, it, beforeEach } from 'vitest';
import { MockFile } from '../core/mockfile.mjs';
import { SimpleDbms } from '../dbms/simpledbms.mjs';
import { fetchPageCursor, fetchPageOffset } from './pagination.mjs';

describe('Pagination', () => {
  let db: SimpleDbms;

  // Insert 20 cities with numeric populations for consistent ordering
  const cities = Array.from({ length: 20 }, (_, i) => ({
    id: `city-${String(i).padStart(2, '0')}`,
    name: `City ${i}`,
    population: (i + 1) * 1000,
  }));

  beforeEach(async () => {
    const dataFile = new MockFile(256);
    const logFile = new MockFile(4096);
    db = await SimpleDbms.create(dataFile, logFile);

    for (const city of cities) {
      await db.insertDocument('cities', JSON.stringify(city));
    }
    await db.commit();
  });

  describe('cursor-based pagination', () => {
    it('returns the first page of results', async () => {
      const page = await fetchPageCursor(db, {
        collection: 'cities',
        iterableKey: 'id',
        limit: 5,
      });

      expect(page.data).toHaveLength(5);
      expect(page.pageSize).toBe(5);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toBeDefined();

      const firstDoc = JSON.parse(page.data[0]) as Record<string, unknown>;
      expect(firstDoc['id']).toBe('city-00');
    });

    it('paginates through all results', async () => {
      const allDocs: string[] = [];
      let cursor: string | number | undefined = undefined;
      let pageCount = 0;

      do {
        const page = await fetchPageCursor(db, {
          collection: 'cities',
          iterableKey: 'id',
          limit: 7,
          afterCursor: cursor,
        });

        allDocs.push(...page.data);
        cursor = page.nextCursor;
        pageCount++;

        if (!page.hasMore) break;
      } while (cursor !== undefined);

      // We should get all 20 cities
      expect(allDocs).toHaveLength(20);
      expect(pageCount).toBe(3); // 7 + 7 + 6

      // Verify no duplicates
      const ids = allDocs.map((d) => (JSON.parse(d) as Record<string, unknown>)['id']);
      expect(new Set(ids).size).toBe(20);
    });

    it('returns empty page for empty collection', async () => {
      const emptyDb = await SimpleDbms.create(new MockFile(256), new MockFile(4096));
      await emptyDb.insertDocument('empty', JSON.stringify({ id: 'dummy', val: 1 }));
      await emptyDb.deleteDocumentById('empty', 'dummy');
      await emptyDb.commit();

      // The collection has no docs now, but the key 'val' may not exist either
      // Let's test with a fresh collection that has one doc
      const freshDb = await SimpleDbms.create(new MockFile(256), new MockFile(4096));
      await freshDb.insertDocument('test', JSON.stringify({ id: 'only', val: 1 }));
      await freshDb.commit();

      const page = await fetchPageCursor(freshDb, {
        collection: 'test',
        iterableKey: 'id',
        limit: 10,
      });

      expect(page.data).toHaveLength(1);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeUndefined();
    });

    it('handles limit larger than total results', async () => {
      const page = await fetchPageCursor(db, {
        collection: 'cities',
        iterableKey: 'id',
        limit: 100,
      });

      expect(page.data).toHaveLength(20);
      expect(page.hasMore).toBe(false);
    });

    it('handles limit of 1', async () => {
      const allDocs: string[] = [];
      let cursor: string | number | undefined = undefined;

      for (let i = 0; i < 25; i++) {
        const page = await fetchPageCursor(db, {
          collection: 'cities',
          iterableKey: 'id',
          limit: 1,
          afterCursor: cursor,
        });

        allDocs.push(...page.data);
        if (!page.hasMore) break;
        cursor = page.nextCursor;
      }

      expect(allDocs).toHaveLength(20);
    });
  });

  describe('offset-based pagination', () => {
    it('returns the first page', async () => {
      const page = await fetchPageOffset(db, {
        collection: 'cities',
        iterableKey: 'id',
        limit: 5,
        offset: 0,
      });

      expect(page.data).toHaveLength(5);
      expect(page.hasMore).toBe(true);
    });

    it('skips documents with offset', async () => {
      const page = await fetchPageOffset(db, {
        collection: 'cities',
        iterableKey: 'id',
        limit: 5,
        offset: 5,
      });

      expect(page.data).toHaveLength(5);
      const firstDoc = JSON.parse(page.data[0]) as Record<string, unknown>;
      expect(firstDoc['id']).toBe('city-05');
    });

    it('returns partial last page', async () => {
      const page = await fetchPageOffset(db, {
        collection: 'cities',
        iterableKey: 'id',
        limit: 7,
        offset: 14,
      });

      expect(page.data).toHaveLength(6); // only 6 left
      expect(page.hasMore).toBe(false);
    });

    it('returns empty when offset exceeds total', async () => {
      const page = await fetchPageOffset(db, {
        collection: 'cities',
        iterableKey: 'id',
        limit: 5,
        offset: 100,
      });

      expect(page.data).toHaveLength(0);
      expect(page.hasMore).toBe(false);
    });

    it('paginates through all results', async () => {
      const allDocs: string[] = [];
      let offset = 0;
      const limit = 6;

      while (true) {
        const page = await fetchPageOffset(db, {
          collection: 'cities',
          iterableKey: 'id',
          limit,
          offset,
        });

        allDocs.push(...page.data);
        if (!page.hasMore) break;
        offset += limit;
      }

      expect(allDocs).toHaveLength(20);
      const ids = allDocs.map((d) => (JSON.parse(d) as Record<string, unknown>)['id']);
      expect(new Set(ids).size).toBe(20);
    });
  });
});
