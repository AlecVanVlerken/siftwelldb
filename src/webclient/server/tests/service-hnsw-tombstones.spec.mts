import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, type MockInstance } from 'vitest';

import { RealFile } from '../../../storage/file.mjs';
import type { IncrementalCompactionPolicy } from '../../../compaction/compaction.mjs';
import { DbmsBack, type HnswConfig } from '../../../database/dbmsback.mjs';
import { SimpleDbms } from '../../../database/simpledbms.mjs';
import { DatabaseService, type VacuumSummary } from '../service.mjs';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function keywordVector(input: string): Float32Array {
  const lower = input.toLowerCase();
  if (lower.includes('alpha')) return new Float32Array([0, 0, 0, 0]);
  if (lower.includes('beta')) return new Float32Array([10, 0, 0, 0]);
  if (lower.includes('gamma')) return new Float32Array([20, 0, 0, 0]);
  return new Float32Array([30, 0, 0, 0]);
}

function imageVector(imageData: Buffer): Float32Array {
  return new Float32Array([imageData[0] ?? 0, 0, 0, 0]);
}

function makeHnswConfig(options: { onTextEmbedding?: (text: string) => Promise<void> } = {}): HnswConfig {
  return {
    dimension: 4,
    embeddingFn: async (text) => {
      await options.onTextEmbedding?.(text);
      return keywordVector(text);
    },
    imageEmbeddingFn: (imageData) => Promise.resolve(imageVector(imageData)),
    M: 4,
    efConstruction: 16,
    efSearch: 12,
  };
}

async function makeFixture(
  options: {
    hnswConfig?: HnswConfig;
    incrementalCompactionPolicy?: IncrementalCompactionPolicy;
    incrementalCompactionIntervalMs?: number;
  } = {},
): Promise<{ service: DatabaseService; dir: string; dbPath: string; hnswConfig: HnswConfig }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'simpledbms-webclient-'));
  const dbPath = path.join(dir, 'service.db');
  const hnswConfig = options.hnswConfig ?? makeHnswConfig();
  const service = new DatabaseService({
    hnswConfig,
    incrementalCompactionIntervalMs: options.incrementalCompactionIntervalMs,
    incrementalCompactionPolicy: options.incrementalCompactionPolicy,
  });
  await service.create(dbPath);
  return { service, dir, dbPath, hnswConfig };
}

async function cleanup(fixture: { service: DatabaseService; dir: string }): Promise<void> {
  await fixture.service.disconnect().catch(() => undefined);
  await rm(fixture.dir, { recursive: true, force: true });
}

function logPath(dbPath: string): string {
  return `${dbPath}.log`;
}

function idsFromDocuments(documents: string[]): Array<string | number> {
  return documents.map((raw) => (JSON.parse(raw) as { id: string | number }).id);
}

async function semanticIds(
  service: DatabaseService,
  collection: string,
  query: string,
  limit = 5,
): Promise<Array<string | number>> {
  return idsFromDocuments(await service.semanticSearch(collection, query, limit));
}

async function waitForCompactionResult(service: DatabaseService) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = await service.getStatus();
    const result = status.incrementalCompaction.lastResult;
    if (result) return result;
    await delay(25);
  }
  throw new Error('Timed out waiting for service-level incremental compaction');
}

async function seedArticles(service: DatabaseService): Promise<void> {
  await service.insertDocument('articles', { id: 'alpha', body: 'alpha topic', group: 'deleted' });
  await service.insertDocument('articles', { id: 'beta', body: 'beta topic', group: 'live' });
  await service.insertDocument('articles', { id: 'gamma', body: 'gamma topic', group: 'live' });
}

describe('DatabaseService HNSW tombstone integration', () => {
  it('normal service delete removes ordinary lookup paths and semantic results', async () => {
    const fixture = await makeFixture();
    try {
      await seedArticles(fixture.service);
      await fixture.service.deleteDocument('articles', 'alpha');

      await expect(fixture.service.getDocumentById('articles', 'alpha')).rejects.toThrow();

      const page = await fixture.service.getDocuments('articles', 'id', undefined, 10);
      expect(idsFromDocuments(page.documents)).not.toContain('alpha');

      const results = await semanticIds(fixture.service, 'articles', 'alpha topic', 3);
      expect(results).not.toContain('alpha');
      expect(results).toEqual(expect.arrayContaining(['beta', 'gamma']));
    } finally {
      await cleanup(fixture);
    }
  });

  it('service image search also hides deleted image tombstones', async () => {
    const fixture = await makeFixture();
    try {
      await fixture.service.insertDocument('images', {
        id: 'img1',
        'photo.jpg': Buffer.from([1]).toString('base64'),
      });
      await fixture.service.insertDocument('images', {
        id: 'img2',
        'photo.jpg': Buffer.from([2]).toString('base64'),
      });

      await fixture.service.deleteDocument('images', 'img1');

      const results = idsFromDocuments(await fixture.service.semanticImageSearch('images', Buffer.from([1]), 2));
      expect(results).toEqual(['img2']);
    } finally {
      await cleanup(fixture);
    }
  });

  it('delete and semantic-search behavior survives service reconnect', async () => {
    const fixture = await makeFixture();
    try {
      await seedArticles(fixture.service);
      await fixture.service.deleteDocument('articles', 'alpha');

      await fixture.service.disconnect();
      await fixture.service.connect(fixture.dbPath);

      await expect(fixture.service.getDocumentById('articles', 'alpha')).rejects.toThrow();
      const results = await semanticIds(fixture.service, 'articles', 'alpha topic', 3);
      expect(results).not.toContain('alpha');
      expect(results).toEqual(expect.arrayContaining(['beta', 'gamma']));
    } finally {
      await cleanup(fixture);
    }
  });

  it('background incremental compaction through the service does not resurrect tombstoned semantic docs', async () => {
    const fixture = await makeFixture({
      incrementalCompactionIntervalMs: 25,
      incrementalCompactionPolicy: {
        maxAmplification: 1.02,
        softAmplification: 1.02,
        targetBatchDocuments: 4,
        targetBatchUnits: 4,
        maxStepsPerRun: 80,
      },
    });

    try {
      const fillerPayload = 'free low blocks for service compaction '.repeat(220);
      for (let i = 0; i < 18; i++) {
        await fixture.service.insertDocument('filler', { id: `filler-${i}`, _payload: fillerPayload });
      }

      await seedArticles(fixture.service);
      await fixture.service.insertDocument('articles', {
        id: 'tail-dead',
        body: 'deleted tombstone compaction tail blocker',
      });

      await fixture.service.deleteDocument('articles', 'tail-dead');
      for (let i = 0; i < 18; i++) {
        await fixture.service.deleteDocument('filler', `filler-${i}`);
      }

      fixture.service.setIncrementalCompactionEnabled(true);
      const compaction = await waitForCompactionResult(fixture.service);
      fixture.service.setIncrementalCompactionEnabled(false);

      expect(compaction.didWork).toBe(true);
      const results = await semanticIds(fixture.service, 'articles', 'deleted tombstone compaction tail blocker', 3);
      expect(results).not.toContain('tail-dead');
      expect(results).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']));
    } finally {
      fixture.service.setIncrementalCompactionEnabled(false);
      await cleanup(fixture);
    }
  });

  it('keeps background compaction queued behind semantic search after reconnecting', async () => {
    const searchStarted = deferred();
    const releaseSearch = deferred();
    const hnswConfig = makeHnswConfig({
      onTextEmbedding: async (text) => {
        if (text.includes('hold')) {
          searchStarted.resolve();
          await releaseSearch.promise;
        }
      },
    });
    const fixture = await makeFixture({ hnswConfig, incrementalCompactionIntervalMs: 25 });
    let compaction: MockInstance<SimpleDbms['compactIfNeeded']> | undefined;
    try {
      await seedArticles(fixture.service);
      fixture.service.setIncrementalCompactionEnabled(true);
      await fixture.service.connect(fixture.dbPath);
      await fixture.service.getStatus();
      compaction = vi.spyOn(SimpleDbms.prototype, 'compactIfNeeded');

      const search = fixture.service.semanticSearch('articles', 'hold alpha topic', 2);
      await searchStarted.promise;
      await delay(75);
      expect(compaction).not.toHaveBeenCalled();

      releaseSearch.resolve();
      expect(idsFromDocuments(await search)).toContain('alpha');
      await fixture.service.getStatus();
      expect(compaction).toHaveBeenCalled();
    } finally {
      releaseSearch.resolve();
      fixture.service.setIncrementalCompactionEnabled(false);
      compaction?.mockRestore();
      await cleanup(fixture);
    }
  });

  it('service full vacuum removes HNSW tombstones and reopens a clean live-only graph', async () => {
    const fixture = await makeFixture();
    try {
      await seedArticles(fixture.service);
      await fixture.service.deleteDocument('articles', 'alpha');

      const vacuum: VacuumSummary = await fixture.service.vacuum();
      expect(vacuum.filepath).toBe(fixture.dbPath);

      const results = await semanticIds(fixture.service, 'articles', 'alpha topic', 3);
      expect(results).not.toContain('alpha');
      expect(results).toEqual(expect.arrayContaining(['beta', 'gamma']));

      await fixture.service.disconnect();

      const inspected = await DbmsBack.open(
        new RealFile(fixture.dbPath),
        new RealFile(logPath(fixture.dbPath)),
        fixture.hnswConfig,
      );
      const graph = await inspected.inspectHnswGraphStructure('articles');
      expect(graph).toHaveLength(2);
      expect(graph.some((node) => node.deleted)).toBe(false);
      await inspected.close();
    } finally {
      await cleanup(fixture);
    }
  });

  it('preserves the configured embeddings when restoring the original database after a failed vacuum reopen', async () => {
    const fixture = await makeFixture();
    let reopenSpy: MockInstance<typeof SimpleDbms.open> | undefined;
    try {
      await seedArticles(fixture.service);
      await fixture.service.deleteDocument('articles', 'alpha');
      reopenSpy = vi.spyOn(SimpleDbms, 'open').mockRejectedValueOnce(new Error('Simulated target reopen failure'));
      await expect(fixture.service.vacuum()).rejects.toThrow('Simulated target reopen failure');
      const results = await semanticIds(fixture.service, 'articles', 'alpha topic', 3);
      expect(results).toEqual(expect.arrayContaining(['beta', 'gamma']));
      expect(results).not.toContain('alpha');
      expect((await fixture.service.getDocuments('articles')).total).toBe(2);
    } finally {
      reopenSpy?.mockRestore();
      await cleanup(fixture);
    }
  });

  it('serializes semantic search with full vacuum maintenance', async () => {
    const searchStarted = deferred();
    const releaseSearch = deferred();
    const hnswConfig = makeHnswConfig({
      onTextEmbedding: async (text) => {
        if (text.includes('hold')) {
          searchStarted.resolve();
          await releaseSearch.promise;
        }
      },
    });
    const fixture = await makeFixture({ hnswConfig });

    try {
      await seedArticles(fixture.service);

      const search = fixture.service.semanticSearch('articles', 'hold alpha topic', 2);
      await searchStarted.promise;

      let vacuumFinished = false;
      const vacuum = fixture.service.vacuum().then((summary) => {
        vacuumFinished = true;
        return summary;
      });

      await delay(50);
      expect(vacuumFinished).toBe(false);

      releaseSearch.resolve();
      expect(idsFromDocuments(await search)).toContain('alpha');
      await vacuum;
      expect(vacuumFinished).toBe(true);
    } finally {
      releaseSearch.resolve();
      await cleanup(fixture);
    }
  });
});
