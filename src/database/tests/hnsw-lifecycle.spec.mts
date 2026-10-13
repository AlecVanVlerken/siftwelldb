import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { SimpleDbms } from '../simpledbms.mjs';
import { DbmsBack, type HnswConfig } from '../dbmsback.mjs';
import { RealFile } from '../../storage/file.mjs';
import { HnswIndexNative } from '../../indexes/hnsw/hnswNative.mjs';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const directories: string[] = [];
const databases: SimpleDbms[] = [];
const releases: (() => void)[] = [];
const vector = () => new Float32Array([1, 2, 3]);

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const db of databases.splice(0)) await db.close();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected test directory');
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(config?: HnswConfig) {
  const directory = await mkdtemp(join(tmpdir(), 'siftwell-hnsw-lifecycle-'));
  directories.push(directory);
  const data = join(directory, 'source.db'),
    log = data + '.log';
  const db = await SimpleDbms.create(new RealFile(data), new RealFile(log), config);
  databases.push(db);
  await db.insertDocumentObject('a', { id: 'a', title: 'original' });
  await db.commit();
  return { db, data, log };
}

describe('semantic operation resource lifetime', () => {
  it('finishes accepted searches before disposal and rejects new searches during and after close', async () => {
    const entered = deferred<void>(),
      release = deferred<Float32Array>();
    releases.push(() => release.resolve(vector()));
    const embeddingFn = vi.fn(async (text: string) => {
      if (text === 'held') {
        entered.resolve();
        return release.promise;
      }
      return vector();
    });
    const { db, data, log } = await fixture({ dimension: 3, embeddingFn });
    expect(
      (await db.semanticSearch('a', 'normal', 1)).map((json) => (JSON.parse(json) as Record<string, unknown>)['id']),
    ).toEqual(['a']);
    const search = vi.spyOn(HnswIndexNative.prototype, 'search');
    const close = vi.spyOn(HnswIndexNative.prototype, 'close');
    const pending = db.semanticSearch('a', 'held', 1);
    await entered.promise;
    const queued = db.semanticSearch('a', 'queued', 1);
    const closing = db.close();
    await expect(db.semanticSearch('a', 'too late', 1)).rejects.toThrow(/closing or closed/);
    expect(close).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    release.resolve(vector());
    expect(await pending).toHaveLength(1);
    expect(await queued).toHaveLength(1);
    await Promise.all([closing, db.close(), db.close()]);
    expect(close).toHaveBeenCalledOnce();
    expect(search.mock.invocationCallOrder.every((order) => order < close.mock.invocationCallOrder[0])).toBe(true);
    await expect(db.semanticSearch('a', 'closed', 1)).rejects.toThrow(/closing or closed/);
    expect(embeddingFn.mock.calls.some(([text]) => text === 'too late' || text === 'closed')).toBe(false);
    await db.reopen(new RealFile(data), new RealFile(log));
    expect(await db.semanticSearch('a', 'reopened', 1)).toHaveLength(1);
  });

  it('releases the queue when a held embedding rejects, including overlapping close calls', async () => {
    const entered = deferred<void>(),
      release = deferred<Float32Array>();
    releases.push(() => release.resolve(vector()));
    const { db, data, log } = await fixture({
      dimension: 3,
      embeddingFn: async (text) => {
        if (text === 'held') {
          entered.resolve();
          return release.promise;
        }
        return vector();
      },
    });
    const pending = db.semanticSearch('a', 'held', 1);
    const rejected = expect(pending).rejects.toThrow('encoder rejected');
    await entered.promise;
    const closing = Promise.all([db.close(), db.close()]);
    release.reject(new Error('encoder rejected'));
    await rejected;
    await closing;
    await db.reopen(new RealFile(data), new RealFile(log));
    expect(await db.semanticSearch('a', 'working', 1)).toHaveLength(1);
  });

  it('rejects every native handle operation after repeated disposal', () => {
    const native = new HnswIndexNative(3, 4, 20, 20);
    native.close();
    native.close();
    const operations = [
      () => native.search(vector(), 1),
      () => native.insert(1, vector()),
      () => native.delete(1),
      () => native.relabelDocument(1, 2),
      () => native.size,
      () => native.setEfSearch(20),
      () => native.takeDirtyNodes(),
      () => native.getLevel(1),
      () => native.getNeighborCount(1, 0),
      () => native.getNeighbors(1, 0),
      () => native.getAllNeighbors(1),
      () => native.getEntryDocId(),
      () => native.getMaxLevel(),
      () => native.importNode(1, 0, vector(), false),
      () => native.importSetNeighbors(1, 0, []),
      () => native.importFinish(null, 0),
    ];
    for (const operation of operations) expect(operation).toThrow(/HNSW index is closed/);
  });

  it.each(['imageText', 'image'] as const)('coordinates %s query embedding with shutdown', async (kind) => {
    const entered = deferred<void>(),
      release = deferred<Float32Array>();
    releases.push(() => release.resolve(vector()));
    const hold = () => {
      entered.resolve();
      return release.promise;
    };
    const { db } = await fixture({
      dimension: 3,
      embeddingFn: () => Promise.resolve(vector()),
      textIndex: { dimension: 3, embeddingFn: () => Promise.resolve(vector()) },
      imageIndex: {
        dimension: 3,
        embeddingFn: (text) => (text === 'held' ? hold() : Promise.resolve(vector())),
        imageEmbeddingFn: (bytes) => (bytes.toString() === 'held' ? hold() : Promise.resolve(vector())),
      },
    });
    await db.insertDocumentObject('a', { id: 'image', 'photo.png': Buffer.from('picture') });
    await db.commit();
    const dispose = vi.spyOn(HnswIndexNative.prototype, 'close');
    const pending =
      kind === 'imageText'
        ? db.semanticImageTextSearch('a', 'held', 1)
        : db.semanticImageSearch('a', Buffer.from('held'), 1);
    await entered.promise;
    const closing = db.close();
    expect(dispose).not.toHaveBeenCalled();
    release.resolve(vector());
    expect(await pending).toHaveLength(1);
    await closing;
    expect(dispose).toHaveBeenCalled();
  });
});

describe('configured instance reopening', () => {
  it('serializes overlapping reopens and closes the backend each one replaces', async () => {
    const { db, data, log } = await fixture({ dimension: 3, embeddingFn: () => Promise.resolve(vector()) });
    const opened: DbmsBack[] = [];
    const originalOpen = DbmsBack.open.bind(DbmsBack);
    vi.spyOn(DbmsBack, 'open').mockImplementation(async (...args) => {
      const backend = await originalOpen(...args);
      opened.push(backend);
      return backend;
    });
    try {
      await Promise.all([
        db.reopen(new RealFile(data), new RealFile(log)),
        db.reopen(new RealFile(data), new RealFile(log)),
      ]);
      expect(opened).toHaveLength(2);
      expect(() => opened[0].assertHealthy()).toThrow(/closed/);
      expect(await db.semanticSearch('a', 'query', 1)).toHaveLength(1);
    } finally {
      for (const backend of opened) await backend.close();
    }
  });

  it('waits for a pending reopen before closing its newly opened backend', async () => {
    const { db, data, log } = await fixture({ dimension: 3, embeddingFn: () => Promise.resolve(vector()) });
    const entered = deferred<void>(),
      release = deferred<void>();
    releases.push(() => release.resolve());
    const opened: DbmsBack[] = [];
    const originalOpen = DbmsBack.open.bind(DbmsBack);
    vi.spyOn(DbmsBack, 'open').mockImplementation(async (...args) => {
      const backend = await originalOpen(...args);
      opened.push(backend);
      entered.resolve();
      await release.promise;
      return backend;
    });
    try {
      const reopening = db.reopen(new RealFile(data), new RealFile(log));
      await entered.promise;
      const closing = db.close();
      release.resolve();
      await Promise.all([reopening, closing]);
      expect(() => opened[0].assertHealthy()).toThrow(/closed/);
    } finally {
      release.resolve();
      for (const backend of opened) await backend.close();
    }
  });

  it('preserves custom text/image encoders and dimensions through repeated reopen cycles', async () => {
    const text = vi.fn(() => Promise.resolve(new Float32Array([1, 2, 3, 4, 5])));
    const imageText = vi.fn(() => Promise.resolve(vector()));
    const image = vi.fn(() => Promise.resolve(vector()));
    const { db, data, log } = await fixture({
      dimension: 5,
      embeddingFn: text,
      textIndex: { dimension: 5, M: 4, embeddingFn: text },
      imageIndex: { dimension: 3, M: 4, embeddingFn: imageText, imageEmbeddingFn: image },
    });
    await db.insertDocumentObject('a', { id: 'photo', title: 'photo', 'photo.png': Buffer.from([1, 2, 3]) });
    await db.commit();
    for (let cycle = 0; cycle < 3; cycle++) {
      await db.close();
      await db.reopen(new RealFile(data), new RealFile(log));
      expect(await db.semanticSearch('a', 'text', 1)).toHaveLength(1);
      expect(await db.semanticImageTextSearch('a', 'photo', 1)).toHaveLength(1);
      expect(await db.semanticImageSearch('a', Buffer.from([1, 2, 3]), 1)).toHaveLength(1);
    }
    expect(text).toHaveBeenCalled();
    expect(imageText).toHaveBeenCalled();
    expect(image).toHaveBeenCalled();
  });

  it('reopens ordinary databases without introducing an embedding configuration', async () => {
    const { db, data, log } = await fixture();
    await db.close();
    await db.reopen(new RealFile(data), new RealFile(log));
    expect((JSON.parse(await db.getDocumentById('a', 'a')) as Record<string, unknown>)['title']).toBe('original');
    await expect(db.semanticSearch('a', 'query', 1)).rejects.toThrow(/not configured/);
  });

  it('retains its original configuration after an incompatible target disables semantics', async () => {
    const original = await fixture({ dimension: 3, embeddingFn: () => Promise.resolve(vector()) });
    const other = await fixture({ dimension: 4, embeddingFn: () => Promise.resolve(new Float32Array([1, 2, 3, 4])) });
    await other.db.close();
    const before = await readFile(other.data);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const imported = vi.spyOn(HnswIndexNative.prototype, 'importNode');
    await original.db.reopen(new RealFile(other.data), new RealFile(other.log));
    await expect(original.db.semanticSearch('a', 'query', 1)).rejects.toThrow(/dimension mismatch/);
    expect(imported).not.toHaveBeenCalled();
    await original.db.close();
    expect(await readFile(other.data)).toEqual(before);
    await original.db.reopen(new RealFile(original.data), new RealFile(original.log));
    expect(await original.db.semanticSearch('a', 'query', 1)).toHaveLength(1);
  });
});
