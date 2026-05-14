import { describe, expect, it } from 'vitest';
import { DatabaseService } from './service.mjs';

type FakeDbms = {
  cursor: (collection: string, iterableKey: string, value?: string) => AsyncIterable<string>;
  deleteDocumentById: (collection: string, id: string) => Promise<void>;
  insertDocumentObject?: (collection: string, document: unknown) => Promise<void>;
  commit: () => Promise<void>;
};

type ServiceInternals = {
  dbms: FakeDbms | null;
  recordBytesCache: Map<string, number>;
};

function setFakeDbms(service: DatabaseService, dbms: FakeDbms): ServiceInternals {
  const internals = service as unknown as ServiceInternals;
  internals.dbms = dbms;
  internals.recordBytesCache = new Map();
  return internals;
}

function isDocumentRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function* documents(values: string[]): AsyncIterable<string> {
  for (const value of values) {
    await Promise.resolve();
    yield value;
  }
}

describe('DatabaseService', () => {
  it('limits documents read from the DB cursor', async () => {
    const service = new DatabaseService();
    const seen: Array<[string, string, string | undefined]> = [];
    setFakeDbms(service, {
      cursor(collection, iterableKey, value) {
        seen.push([collection, iterableKey, value]);
        return documents([
          JSON.stringify({ id: 'a', title: 'A' }),
          JSON.stringify({ id: 'b', title: 'B' }),
          JSON.stringify({ id: 'c', title: 'C' }),
        ]);
      },
      deleteDocumentById() {
        return Promise.resolve();
      },
      commit() {
        return Promise.resolve();
      },
    });

    await expect(service.getDocuments('books', 'title', 'A', 2)).resolves.toEqual({
      documents: [JSON.stringify({ id: 'b', title: 'B' }), JSON.stringify({ id: 'c', title: 'C' })],
      hasMore: false,
      nextCursor: undefined,
    });
    expect(seen).toEqual([['books', 'title', 'A']]);
  });

  it('sorts documents numerically ascending when sortBy targets a number field', async () => {
    const service = new DatabaseService();
    setFakeDbms(service, {
      cursor() {
        return documents([
          JSON.stringify({ id: 'a', salary: 4200 }),
          JSON.stringify({ id: 'b', salary: 1000 }),
          JSON.stringify({ id: 'c', salary: 7800 }),
        ]);
      },
      deleteDocumentById() {
        return Promise.resolve();
      },
      commit() {
        return Promise.resolve();
      },
    });

    const result = await service.getDocuments('employees', 'id', undefined, 10, 'salary', 'asc');

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeUndefined();
    expect(result.documents.map((d) => (JSON.parse(d) as Record<string, unknown>)['salary'])).toEqual([1000, 4200, 7800]);
  });

  it('sorts documents alphabetically descending when sortBy targets a string field', async () => {
    const service = new DatabaseService();
    setFakeDbms(service, {
      cursor() {
        return documents([
          JSON.stringify({ id: 'a', name: 'Alice' }),
          JSON.stringify({ id: 'b', name: 'Charlie' }),
          JSON.stringify({ id: 'c', name: 'Bob' }),
        ]);
      },
      deleteDocumentById() {
        return Promise.resolve();
      },
      commit() {
        return Promise.resolve();
      },
    });

    const result = await service.getDocuments('employees', 'id', undefined, 10, 'name', 'desc');

    expect(result.documents.map((d) => (JSON.parse(d) as Record<string, unknown>)['name'])).toEqual([
      'Charlie',
      'Bob',
      'Alice',
    ]);
  });

  it('places nullish values first in ascending sort and applies the limit after sorting', async () => {
    const service = new DatabaseService();
    setFakeDbms(service, {
      cursor() {
        return documents([
          JSON.stringify({ id: 'a', salary: 4200 }),
          JSON.stringify({ id: 'b' }),
          JSON.stringify({ id: 'c', salary: 1000 }),
          JSON.stringify({ id: 'd', salary: null }),
        ]);
      },
      deleteDocumentById() {
        return Promise.resolve();
      },
      commit() {
        return Promise.resolve();
      },
    });

    const result = await service.getDocuments('employees', 'id', undefined, 3, 'salary', 'asc');

    expect(result.documents.map((d) => (JSON.parse(d) as Record<string, unknown>)['id'])).toEqual(['b', 'd', 'c']);
  });

  it('commits document deletes and invalidates collection storage cache', async () => {
    const service = new DatabaseService();
    const calls: string[] = [];
    const internals = setFakeDbms(service, {
      cursor() {
        return documents([]);
      },
      async deleteDocumentById(collection, id) {
        await Promise.resolve();
        calls.push(`delete:${collection}:${id}`);
      },
      async commit() {
        await Promise.resolve();
        calls.push('commit');
      },
    });
    internals.recordBytesCache.set('books', 4096);

    await service.deleteDocument('books', 'b1');

    expect(calls).toEqual(['delete:books:b1', 'commit']);
    expect(internals.recordBytesCache.has('books')).toBe(false);
  });

  it('seeds deterministic demo employees when the employees collection is empty', async () => {
    const service = new DatabaseService();
    const inserted: Array<Record<string, unknown>> = [];
    const internals = setFakeDbms(service, {
      cursor() {
        return documents([]);
      },
      deleteDocumentById() {
        return Promise.resolve();
      },
      insertDocumentObject(collection, document) {
        expect(collection).toBe('employees');
        if (!isDocumentRecord(document)) {
          return Promise.reject(new Error('Expected a document object'));
        }
        inserted.push(document);
        return Promise.resolve();
      },
      commit() {
        return Promise.resolve();
      },
    });
    internals.recordBytesCache.set('employees', 4096);

    const result = await service.seedDemoEmployees(3);

    expect(result).toEqual({ collection: 'employees', inserted: 3, skipped: false });
    expect(inserted).toHaveLength(3);
    expect(inserted[0]).toMatchObject({ id: 'emp001' });
    expect(typeof inserted[0]?.['department']).toBe('string');
    expect(internals.recordBytesCache.has('employees')).toBe(false);
  });

  it('skips demo seeding when employees already exist', async () => {
    const service = new DatabaseService();
    const inserted: Array<Record<string, unknown>> = [];
    setFakeDbms(service, {
      cursor() {
        return documents([JSON.stringify({ id: 'emp001' })]);
      },
      deleteDocumentById() {
        return Promise.resolve();
      },
      insertDocumentObject(_collection, document) {
        if (!isDocumentRecord(document)) {
          return Promise.reject(new Error('Expected a document object'));
        }
        inserted.push(document);
        return Promise.resolve();
      },
      commit() {
        return Promise.reject(new Error('commit should not be called'));
      },
    });

    const result = await service.seedDemoEmployees(3);

    expect(result).toEqual({ collection: 'employees', inserted: 0, skipped: true });
    expect(inserted).toHaveLength(0);
  });
});
