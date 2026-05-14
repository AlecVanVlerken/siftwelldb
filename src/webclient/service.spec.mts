import { describe, expect, it } from 'vitest';
import { DatabaseService } from './service.mjs';

type FakeDbms = {
  cursor: (collection: string, iterableKey: string, value?: string) => AsyncIterable<string>;
  deleteDocumentById: (collection: string, id: string) => Promise<void>;
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
});
