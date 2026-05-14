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
        return documents(['a', 'b', 'c']);
      },
      async deleteDocumentById() {},
      async commit() {},
    });

    await expect(service.getDocuments('books', 'title', 'A', 2)).resolves.toEqual(['a', 'b']);
    expect(seen).toEqual([['books', 'title', 'A']]);
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
    const inserted: unknown[] = [];
    const internals = setFakeDbms(service, {
      cursor() {
        return documents([]);
      },
      async deleteDocumentById() {},
      async insertDocumentObject(collection, document) {
        expect(collection).toBe('employees');
        inserted.push(document);
      },
      async commit() {},
    });
    internals.recordBytesCache.set('employees', 4096);

    const result = await service.seedDemoEmployees(3);

    expect(result).toEqual({ collection: 'employees', inserted: 3, skipped: false });
    expect(inserted).toHaveLength(3);
    expect(inserted[0]).toMatchObject({ id: 'emp001', department: expect.any(String) });
    expect(internals.recordBytesCache.has('employees')).toBe(false);
  });

  it('skips demo seeding when employees already exist', async () => {
    const service = new DatabaseService();
    const inserted: unknown[] = [];
    setFakeDbms(service, {
      cursor() {
        return documents([JSON.stringify({ id: 'emp001' })]);
      },
      async deleteDocumentById() {},
      async insertDocumentObject(_collection, document) {
        inserted.push(document);
      },
      async commit() {
        throw new Error('commit should not be called');
      },
    });

    const result = await service.seedDemoEmployees(3);

    expect(result).toEqual({ collection: 'employees', inserted: 0, skipped: true });
    expect(inserted).toHaveLength(0);
  });
});
