import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DbmsBack, type HnswConfig } from '../dbmsback.mjs';
import { Document, parseRawDocument } from '../document.mjs';
import { semanticIndexKey } from '../identity.mjs';
import { RealFile } from '../../storage/file.mjs';
import { FreeBlockFile } from '../../storage/blocks/freeblockfile.mjs';
import { HNSWGraphStorage } from '../../indexes/hnsw/hnswGraphStorage.mjs';
import { HNSWIndex } from '../../indexes/hnsw/hnswIndex.mjs';
import { HnswIndexNative } from '../../indexes/hnsw/hnswNative.mjs';
import { AtomicFile } from '../../storage/wal/atomicfile.mjs';
import { RecordStore } from '../../storage/records/recordstore.mjs';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';

const directories: string[] = [];
const databases: DbmsBack[] = [];
const embeddingFn = () => Promise.resolve(new Float32Array([1, 2, 3]));
type Internals = { freeblockFile: FreeBlockFile; hnswIndexCache: Map<string, HNSWIndex> };
const internals = (db: DbmsBack) => db as unknown as Internals;
const nativeSize = (index: HNSWIndex) => (index as unknown as { rustIdx: HnswIndexNative }).rustIdx.size;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await db.close();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected test directory');
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(config: HnswConfig) {
  const directory = await mkdtemp(join(tmpdir(), 'siftwell-hnsw-membership-'));
  directories.push(directory);
  const data = join(directory, 'source.db');
  const log = data + '.log';
  const open = async () => {
    const db = await DbmsBack.open(new RealFile(data), new RealFile(log), config);
    databases.push(db);
    return db;
  };
  const db = new DbmsBack(new RealFile(data), new RealFile(log), config);
  await db.create();
  databases.push(db);
  return { db, open, data, directory };
}

async function insert(db: DbmsBack, collection: string, count: number) {
  for (let i = 0; i < count; i++)
    await db.insertDocument(
      parseRawDocument(collection, { id: String(i).padStart(3, '0'), title: 'identical embedding' }),
    );
}

async function stripDirectory(db: DbmsBack, collection: string) {
  const root = db.getVacuumHnswMetaSnapshot()[semanticIndexKey(collection, 'default')][0];
  const file = internals(db).freeblockFile;
  const raw = await file.readBlock(root);
  raw.fill(0, 31); // Previous format ends after the 30-byte dimension prefix.
  await file.writeBlock(root, raw.subarray(1));
}

describe('complete persisted HNSW membership', () => {
  it.each([0, 1, 2])('preserves a graph with %i entries and a tombstone-only state', async (count) => {
    const state = await fixture({ dimension: 3, M: 4, embeddingFn });
    let db = state.db;
    await db.ensureHnswCollection('a');
    await insert(db, 'a', count);
    for (let i = 0; i < count; i++) await db.deleteDocument(String(i).padStart(3, '0'), 'a');
    await db.commit();
    await db.close();
    db = await state.open();
    const graph = await db.inspectHnswGraphStructure('a');
    expect(graph).toHaveLength(count);
    expect(graph.every((node) => node.deleted)).toBe(true);
    expect(nativeSize(internals(db).hnswIndexCache.get(semanticIndexKey('a', 'default'))!)).toBe(0);
    expect(await db.semanticSearch('a', 'query', 5)).toEqual([]);
  });

  it.each([4, 16])('preserves 250 duplicate embeddings, tombstones and every relocation unit with M=%i', async (M) => {
    const state = await fixture({ dimension: 3, M, embeddingFn });
    let db = state.db;
    await insert(db, 'a', 250);
    const pointer = await db.getDocumentBlockId('a', '200');
    await db.deleteDocument('200', 'a');
    await db.commit();
    for (let cycle = 0; cycle < 3; cycle++) {
      const graph = await db.inspectHnswGraphStructure('a');
      expect(graph).toHaveLength(250);
      expect(graph.filter((node) => !node.deleted)).toHaveLength(249);
      expect(graph.find((node) => node.docId === pointer)?.deleted).toBe(true);
      expect(nativeSize(internals(db).hnswIndexCache.get(semanticIndexKey('a', 'default'))!)).toBe(249);
      const units = await db.listHnswRelocationCandidateTargets(1000);
      expect(units.filter((unit) => unit.kind === 'hnsw-graph')).toHaveLength(250);
      expect(units.filter((unit) => unit.kind === 'hnsw-vector')).toHaveLength(250);
      expect(units.filter((unit) => unit.hnswUnitState === 'tombstoned-retained')).toHaveLength(2);
      expect(((await db.getDocument('199', 'a')) as Document).getId()).toBe('199');
      await db.close();
      db = await state.open();
    }
    await db.deleteCollection('a');
    await db.commit();
    const diagnostic = await HNSWGraphStorage.create(internals(db).freeblockFile, M, 4, 3);
    const remaining = [];
    for await (const node of diagnostic.scanPhysicalNodes()) remaining.push(node);
    expect(remaining).toEqual([]);
    await diagnostic.freeMetadataBlock();
  });

  it('relocates disconnected members and tombstones, isolates similar names, and vacuums live membership', async () => {
    const state = await fixture({ dimension: 3, M: 4, embeddingFn });
    let db = state.db;
    await insert(db, 'a', 45);
    await insert(db, 'a::b', 30);
    await db.deleteDocument('044', 'a');
    const key = semanticIndexKey('a', 'default');
    const graph = await HNSWGraphStorage.open(internals(db).freeblockFile, db.getVacuumHnswMetaSnapshot()[key][0]);
    const disconnected = (await db.inspectHnswGraphStructure('a')).find((node) => node.nodeId !== graph.entryPoint)!;
    const node = await graph.getNode(disconnected.nodeId);
    node.neighbors = node.neighbors.map(() => []);
    await graph.saveNode(node);
    await db.commit();
    await db.close();
    db = await state.open();
    const targets = await db.listHnswRelocationCandidateTargets(1000);
    const scans = vi.spyOn(HNSWIndex.prototype, 'listRelocationTargets');
    for (const kind of ['hnsw-graph', 'hnsw-vector'] as const) {
      const target = (await db.listHnswRelocationCandidateTargets(1000)).find(
        (unit) => unit.collection === 'a' && unit.kind === kind,
      )!;
      await db.relocateHnswUnit({ ...target, collection: 'a', kind });
      await db.commit();
    }
    expect(scans).not.toHaveBeenCalled();
    expect(await db.listHnswRelocationCandidateTargets(1000)).toHaveLength(targets.length);
    const vacuum = await db.vacuumCompactInto(
      new RealFile(join(state.directory, 'vacuum.db')),
      new RealFile(join(state.directory, 'vacuum.log')),
    );
    databases.push(vacuum);
    expect(await vacuum.inspectHnswGraphStructure('a')).toHaveLength(44);
    expect((await vacuum.inspectHnswGraphStructure('a')).every((node) => !node.deleted)).toBe(true);
    await db.deleteCollection('a');
    await db.commit();
    await db.close();
    db = await state.open();
    expect(await db.inspectHnswGraphStructure('a::b')).toHaveLength(30);
    expect(await db.getCollections()).toEqual(['a::b']);
  });

  it('migrates old pages including disconnected members, with exact collection ownership', async () => {
    const state = await fixture({ dimension: 3, M: 4, embeddingFn });
    let db = state.db;
    await insert(db, 'a', 40);
    await insert(db, 'a::b', 40);
    for (const collection of ['a', 'a::b']) {
      const root = db.getVacuumHnswMetaSnapshot()[semanticIndexKey(collection, 'default')][0];
      const graph = await HNSWGraphStorage.open(internals(db).freeblockFile, root);
      for await (const node of graph.scanNodes()) {
        node.neighbors = node.neighbors.map(() => []);
        await graph.saveNode(node);
      }
      await stripDirectory(db, collection);
    }
    await db.commit();
    await db.close();
    db = await state.open();
    for (const collection of ['a', 'a::b']) expect(await db.inspectHnswGraphStructure(collection)).toHaveLength(40);
    await db.close();
    db = await state.open();
    expect(await db.inspectHnswGraphStructure('a')).toHaveLength(40);
    await db.deleteCollection('a');
    expect(await db.inspectHnswGraphStructure('a::b')).toHaveLength(40);
  });

  it('retains ambiguous disconnected legacy tombstones and refuses incomplete cleanup', async () => {
    const state = await fixture({ dimension: 3, M: 4, maxStoredLevel: 4, embeddingFn });
    const db = state.db;
    await insert(db, 'a', 45);
    const root = db.getVacuumHnswMetaSnapshot()[semanticIndexKey('a', 'default')][0];
    const graph = await HNSWGraphStorage.open(internals(db).freeblockFile, root);
    const nodes = [];
    for await (const node of graph.scanNodes()) nodes.push(node);
    const entryPage = Math.floor(graph.entryPoint! / 4294967296);
    const orphanPage = nodes.map((node) => Math.floor(node.nodeId / 4294967296)).find((page) => page !== entryPage)!;
    for (const node of nodes) {
      if (Math.floor(node.nodeId / 4294967296) === orphanPage) {
        node.deleted = true;
      }
      node.neighbors = node.neighbors.map(() => []);
      await graph.saveNode(node);
    }
    await stripDirectory(db, 'a');
    await db.commit();
    await db.close();
    const before = await readFile(state.data);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reopened = await state.open();
    await expect(reopened.semanticSearch('a', 'query', 1)).rejects.toThrow(/not configured/);
    await expect(reopened.deleteCollection('a')).rejects.toThrow(/ownership.*unverified/);
    expect(reopened.isHealthy).toBe(true);
    expect(await readFile(state.data)).toEqual(before);
    expect(((await reopened.getDocument('000', 'a')) as Document).getId()).toBe('000');
  });

  it('cleans complete semantic storage while opened without an embedding provider', async () => {
    const state = await fixture({ dimension: 3, M: 4, embeddingFn });
    await insert(state.db, 'a', 50);
    await state.db.deleteDocument('049', 'a');
    await state.db.commit();
    await state.db.close();
    const offline = await DbmsBack.open(new RealFile(state.data), new RealFile(state.data + '.log'));
    databases.push(offline);
    await offline.deleteCollection('a');
    await offline.commit();
    const diagnostic = await HNSWGraphStorage.create(internals(offline).freeblockFile, 4, 4, 3);
    const nodes = [];
    for await (const node of diagnostic.scanPhysicalNodes()) nodes.push(node);
    expect(nodes).toEqual([]);
    await diagnostic.freeMetadataBlock();
  });

  it('does not guess which identical-layout text/image index owns disconnected legacy members', async () => {
    const config = { dimension: 3, M: 4, embeddingFn };
    const state = await fixture({
      ...config,
      textIndex: config,
      imageIndex: { ...config, imageEmbeddingFn: embeddingFn },
    });
    for (let i = 0; i < 10; i++)
      await state.db.insertDocument(
        parseRawDocument('a', { id: String(i), title: 'same', 'photo.png': Buffer.from([1, 2, 3]) }),
      );
    const file = internals(state.db).freeblockFile;
    for (const [root] of Object.values(state.db.getVacuumHnswMetaSnapshot())) {
      const graph = await HNSWGraphStorage.open(file, root);
      for await (const node of graph.scanNodes()) {
        node.neighbors = node.neighbors.map(() => []);
        await graph.saveNode(node);
      }
      const raw = await file.readBlock(root);
      raw.fill(0, 31);
      await file.writeBlock(root, raw.subarray(1));
    }
    await state.db.commit();
    await state.db.close();
    const before = await readFile(state.data);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reopened = await state.open();
    await expect(reopened.semanticSearch('a', 'query', 1)).rejects.toThrow(/ownership is ambiguous/);
    expect(Object.keys(reopened.getVacuumHnswMetaSnapshot())).toHaveLength(2);
    expect(((await reopened.getDocument('0', 'a')) as Document).getFields()['photo.png']).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(await readFile(state.data)).toEqual(before);
  });

  it('adds metadata overflow created by relocation to the reused candidate inventory', async () => {
    // Small pages exercise a directory boundary without thousands of inserts.
    const data = new MockFile(256),
      log = new MockFile(4096);
    const db = new DbmsBack(data, log, { dimension: 3, M: 4, maxStoredLevel: 2, embeddingFn });
    const file = new FreeBlockFile(new AtomicFile(data, log), 256);
    const storage = db as unknown as { freeblockFile: FreeBlockFile; recordStore: RecordStore };
    storage.freeblockFile = file;
    storage.recordStore = new RecordStore(file);
    databases.push(db);
    await db.create();
    await insert(db, 'a', 106);
    const before = await db.listHnswRelocationCandidateTargets(1000);
    expect(before.filter((unit) => unit.kind === 'hnsw-meta')).toHaveLength(1);
    const scans = vi.spyOn(HNSWIndex.prototype, 'listRelocationTargets');
    const node = before.find((unit) => unit.kind === 'hnsw-graph')!;
    await db.relocateHnswUnit({ collection: 'a', kind: 'hnsw-graph', nodeId: node.nodeId });
    const after = await db.listHnswRelocationCandidateTargets(1000);
    expect(after.filter((unit) => unit.kind === 'hnsw-meta')).toHaveLength(2);
    const overflow = after.find(
      (unit) =>
        unit.kind === 'hnsw-meta' &&
        !before.some((old) => old.kind === 'hnsw-meta' && old.blockNumber === unit.blockNumber),
    )!;
    await db.relocateHnswUnit({ ...overflow, collection: 'a', kind: 'hnsw-meta' });
    expect(
      (await db.listHnswRelocationCandidateTargets(1000)).some(
        (unit) => unit.kind === 'hnsw-meta' && unit.blockNumber === overflow.blockNumber,
      ),
    ).toBe(false);
    expect(scans).not.toHaveBeenCalled();
    expect(await db.inspectHnswGraphStructure('a')).toHaveLength(106);
  });
});
