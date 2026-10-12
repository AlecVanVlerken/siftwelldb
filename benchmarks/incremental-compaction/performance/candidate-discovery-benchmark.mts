/** Real-file before/after comparison, including actual relocation, commit and tail trimming. */
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import type { DbmsBack, HnswConfig } from '../../../src/database/dbmsback.mjs';
import type { Document } from '../../../src/database/document.mjs';
import type { BlockNodeStorage } from '../../../src/indexes/btree/nodestorage.mjs';
import type { HNSWIndex } from '../../../src/indexes/hnsw/hnswIndex.mjs';
import type { FreeBlockFile } from '../../../src/storage/blocks/freeblockfile.mjs';
import type { RecordStore } from '../../../src/storage/records/recordstore.mjs';

type Runtime = {
  DbmsBack: typeof import('../../../src/database/dbmsback.mjs').DbmsBack;
  RealFile: typeof import('../../../src/storage/file.mjs').RealFile;
  parseRawDocument: typeof import('../../../src/database/document.mjs').parseRawDocument;
  BlockNodeStorage: typeof import('../../../src/indexes/btree/nodestorage.mjs').BlockNodeStorage;
  HNSWIndex: typeof import('../../../src/indexes/hnsw/hnswIndex.mjs').HNSWIndex;
};
type Work = {
  decodedDocuments: number;
  chainTraversals: number;
  chainBlocks: number;
  blockReads: number;
  btreeNodesEnumerated: number;
  hnswUnitsEnumerated: number;
  returnedCandidates: number;
};
type Sample = Work & {
  label: string;
  workload: string;
  n: number;
  batch: number;
  repeat: number;
  step: number;
  discoveryMs: number;
  relocationMs: number;
  totalStepMs: number;
  relocatedDocuments: number;
  relocatedBtreeNodes: number;
  relocatedHnswUnits: number;
  reclaimedTailBlocks: number;
  totalStepBlockReads: number;
};

const repository = path.resolve(import.meta.dirname, '../../..');
const label = process.env['COMPACTION_BENCH_LABEL'] ?? 'after';
const sourceRoot = path.resolve(process.env['COMPACTION_BENCH_ROOT'] ?? repository);
const sizes = (process.env['COMPACTION_BENCH_SIZES'] ?? '1000,5000,10000').split(',').map(Number);
const batches = (process.env['COMPACTION_BENCH_BATCHES'] ?? '1,5,10,50').split(',').map(Number);
const repeats = Number(process.env['COMPACTION_BENCH_REPEATS'] ?? 3);
const steps = Number(process.env['COMPACTION_BENCH_STEPS'] ?? 3);
const workload = process.env['COMPACTION_BENCH_WORKLOAD'] ?? 'records-btree';
const configuredDataDirectory = process.env['COMPACTION_BENCH_DATA_DIR'];
const directory = configuredDataDirectory ?? (await mkdtemp(path.join(os.tmpdir(), 'siftwell-candidate-benchmark-')));
const resultDirectory = path.join(repository, 'benchmarks/incremental-compaction/results/raw');
const samples: Sample[] = [];
const runtime = await loadRuntime(sourceRoot);
const semantic = workload === 'mixed-hnsw' ? makeSemanticConfig() : undefined;

function work(): Work {
  return {
    decodedDocuments: 0,
    chainTraversals: 0,
    chainBlocks: 0,
    blockReads: 0,
    btreeNodesEnumerated: 0,
    hnswUnitsEnumerated: 0,
    returnedCandidates: 0,
  };
}

async function loadRuntime(root: string): Promise<Runtime> {
  const module = (relative: string) => pathToFileURL(path.join(root, relative)).href;
  const [database, file, document, btree, hnsw] = await Promise.all([
    import(module('src/database/dbmsback.mts')) as Promise<typeof import('../../../src/database/dbmsback.mjs')>,
    import(module('src/storage/file.mts')) as Promise<typeof import('../../../src/storage/file.mjs')>,
    import(module('src/database/document.mts')) as Promise<typeof import('../../../src/database/document.mjs')>,
    import(module('src/indexes/btree/nodestorage.mts')) as Promise<
      typeof import('../../../src/indexes/btree/nodestorage.mjs')
    >,
    import(module('src/indexes/hnsw/hnswIndex.mts')) as Promise<
      typeof import('../../../src/indexes/hnsw/hnswIndex.mjs')
    >,
  ]);
  return {
    DbmsBack: database.DbmsBack,
    RealFile: file.RealFile,
    parseRawDocument: document.parseRawDocument,
    BlockNodeStorage: btree.BlockNodeStorage,
    HNSWIndex: hnsw.HNSWIndex,
  };
}

function makeSemanticConfig(): HnswConfig {
  return {
    dimension: 128,
    embeddingFn: (text) => Promise.resolve(Float32Array.from({ length: 128 }, (_, i) => (text.length + i) % 31)),
    M: 4,
    maxStoredLevel: 3,
    efConstruction: 16,
    efSearch: 16,
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function seed(n: number): Promise<{ data: string; log: string }> {
  const data = path.join(directory, `seed-${workload}-${n}.db`);
  const log = path.join(directory, `seed-${workload}-${n}.wal`);
  if (await exists(data)) return { data, log };
  const db = new runtime.DbmsBack(new runtime.RealFile(data), new runtime.RealFile(log), semantic);
  await db.create();
  try {
    await db.setFieldIndexed('holes', 'payload', false);
    await db.setFieldIndexed('items', 'payload', false);
    await db.setFieldIndexed('items', 'binary', false);
    // A low-address pool of holes lets every timed step perform real downward moves.
    for (let i = 0; i < Math.ceil(n / 4); i++) {
      await db.insertDocument(runtime.parseRawDocument('holes', { id: i, payload: 'filler '.repeat(50) }), undefined, {
        skipSemanticIndex: true,
      });
    }
    await db.commit();
    for (let i = 0; i < n; i++) {
      await db.insertDocument(
        runtime.parseRawDocument('items', {
          id: i,
          category: `c${i % 11}`,
          rank: i,
          payload: 'live payload '.repeat(i % 5 === 0 ? 750 : 50),
          binary: Buffer.from([i % 256, 0, 255, 128]),
        }),
        { payload: i % 5 === 0 ? 'off' : 'gzip', binary: 'off' },
      );
    }
    await db.commit();
    for (let i = 0; i < Math.ceil(n / 4); i++) await db.deleteDocument(i, 'holes');
    if (semantic) {
      for (let i = 0; i < Math.floor(n / 20); i++) await db.deleteDocument(i, 'items');
    }
    await db.commit();
  } finally {
    await db.close();
  }
  return { data, log };
}

/** The counted work belongs to discovery only; total block reads include all step phases. */
function instrument(db: DbmsBack) {
  const internals = db as unknown as { recordStore: RecordStore; freeblockFile: FreeBlockFile };
  let active = 0;
  let firstStart = Infinity;
  let lastEnd = 0;
  let totalReads = 0;
  let current = work();
  let relocationMs = 0;
  const store = internals.recordStore;
  const readRecord = store.readRecord.bind(store);
  const readChain = store.readRecordBlockChain.bind(store);
  const readBlock = internals.freeblockFile.readBlock.bind(internals.freeblockFile);
  store.readRecord = (...args) => {
    if (active > 0) current.decodedDocuments++;
    return readRecord(...args);
  };
  store.readRecordBlockChain = async (...args) => {
    const counted = active > 0;
    if (counted) current.chainTraversals++;
    const chain = await readChain(...args);
    if (counted) current.chainBlocks += chain.length;
    return chain;
  };
  internals.freeblockFile.readBlock = (...args) => {
    totalReads++;
    if (active > 0) current.blockReads++;
    return readBlock(...args);
  };
  // Preserve methods for receiver-aware .apply() calls and exact restoration below.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const listNodes = runtime.BlockNodeStorage.prototype.listNodeBlocks;
  runtime.BlockNodeStorage.prototype.listNodeBlocks = async function (this: BlockNodeStorage, ...args) {
    const nodes = await listNodes.apply(this, args);
    if (active > 0) current.btreeNodesEnumerated += nodes.length;
    return nodes;
  };
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const listHnsw = runtime.HNSWIndex.prototype.listRelocationTargets;
  runtime.HNSWIndex.prototype.listRelocationTargets = async function (this: HNSWIndex, ...args) {
    const units = await listHnsw.apply(this, args);
    if (active > 0) current.hnswUnitsEnumerated += units.length;
    return units;
  };
  for (const name of [
    'listRecordRelocationTargets',
    'listBtreeRelocationTargets',
    'listHnswRelocationCandidateTargets',
  ] as const) {
    const original = db[name].bind(db);
    db[name] = async (...args) => {
      firstStart = Math.min(firstStart, performance.now());
      active++;
      try {
        const targets = await original(...args);
        current.returnedCandidates += targets.length;
        return targets;
      } finally {
        active--;
        lastEnd = performance.now();
      }
    };
  }
  const relocateRecord = db.relocateDocument.bind(db);
  db.relocateDocument = async (...args) => {
    const start = performance.now();
    try {
      return await relocateRecord(...args);
    } finally {
      relocationMs += performance.now() - start;
    }
  };
  const relocateTree = db.relocateBtreeNode.bind(db);
  db.relocateBtreeNode = async (...args) => {
    const start = performance.now();
    try {
      return await relocateTree(...args);
    } finally {
      relocationMs += performance.now() - start;
    }
  };
  const relocateHnsw = db.relocateHnswUnit.bind(db);
  db.relocateHnswUnit = async (...args) => {
    const start = performance.now();
    try {
      return await relocateHnsw(...args);
    } finally {
      relocationMs += performance.now() - start;
    }
  };
  return {
    reset() {
      assert.equal(active, 0);
      current = work();
      firstStart = Infinity;
      lastEnd = 0;
      totalReads = 0;
      relocationMs = 0;
    },
    result() {
      return {
        ...current,
        discoveryMs: Number.isFinite(firstStart) ? lastEnd - firstStart : 0,
        relocationMs,
        totalStepBlockReads: totalReads,
      };
    },
    restore() {
      runtime.BlockNodeStorage.prototype.listNodeBlocks = listNodes;
      runtime.HNSWIndex.prototype.listRelocationTargets = listHnsw;
    },
  };
}

async function measure(n: number, batch: number, repeat: number, source: { data: string; log: string }) {
  const data = path.join(directory, `${label}-${workload}-${n}-${batch}-${repeat}.db`);
  const log = `${data}.wal`;
  await copyFile(source.data, data);
  await copyFile(source.log, log);
  const db = await runtime.DbmsBack.open(new runtime.RealFile(data), new runtime.RealFile(log), semantic);
  const counters = instrument(db);
  try {
    for (let step = 0; step < steps; step++) {
      counters.reset();
      const start = performance.now();
      const result = await db.runIncrementalCompactionStep({
        maxAmplification: 1.01,
        softAmplification: 1.01,
        targetBatchDocuments: batch,
        targetBatchUnits: batch,
      });
      const totalStepMs = performance.now() - start;
      assert(result.didWork, `No actual compaction work: ${label} n=${n} batch=${batch} step=${step}`);
      assert(
        (result.relocatedDocuments ?? 0) + (result.relocatedBtreeNodes ?? 0) + (result.relocatedHnswUnits ?? 0) > 0,
        'A measurement must relocate units, rather than measure only a free-tail no-op',
      );
      samples.push({
        label,
        workload,
        n,
        batch,
        repeat,
        step,
        totalStepMs,
        ...counters.result(),
        relocatedDocuments: result.relocatedDocuments ?? 0,
        relocatedBtreeNodes: result.relocatedBtreeNodes ?? 0,
        relocatedHnswUnits: result.relocatedHnswUnits ?? 0,
        reclaimedTailBlocks: result.reclaimedTailBlocks ?? 0,
      });
    }
    // Reading is deliberately outside measured phases. Every run checks live tail contents and references.
    const last = (await db.getDocument(n - 1, 'items')) as Document;
    assert.equal(last.getId(), n - 1);
    assert.deepEqual(last.getFields()['binary'], Buffer.from([(n - 1) % 256, 0, 255, 128]));
    await db.commit();
  } finally {
    counters.restore();
    await db.close();
    await rm(data, { force: true });
    await rm(log, { force: true });
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 === 1
    ? sorted[Math.floor(sorted.length / 2)]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}

function csv(rows: Record<string, string | number>[]): string {
  const keys = Object.keys(rows[0] ?? {});
  return `${keys.join(',')}\n${rows.map((row) => keys.map((key) => String(row[key])).join(',')).join('\n')}\n`;
}

await mkdir(directory, { recursive: true });
try {
  for (const n of sizes) {
    const source = await seed(n);
    for (const batch of batches) {
      for (let repeat = 0; repeat < repeats; repeat++) await measure(n, batch, repeat, source);
      console.log(`${label} ${workload}: n=${n}, batch=${batch}, ${repeats} repeats × ${steps} actual steps`);
    }
  }
  const summaries: Record<string, string | number>[] = [];
  for (const n of sizes) {
    for (const batch of batches) {
      for (const phase of ['cold', 'reused']) {
        const selected = samples.filter(
          (sample) => sample.n === n && sample.batch === batch && (sample.step === 0) === (phase === 'cold'),
        );
        assert(selected.length > 0);
        const numeric = Object.keys(selected[0]).filter(
          (key) => !['label', 'workload', 'n', 'batch', 'repeat', 'step'].includes(key),
        );
        summaries.push({
          label,
          workload,
          n,
          batch,
          phase,
          samples: selected.length,
          ...Object.fromEntries(
            numeric.map((key) => [key, median(selected.map((sample) => Number(sample[key as keyof Sample])))]),
          ),
        });
      }
    }
  }
  await mkdir(resultDirectory, { recursive: true });
  const prefix = path.join(resultDirectory, `candidate-discovery-${workload}-${label}`);
  await writeFile(`${prefix}-samples.csv`, csv(samples));
  await writeFile(`${prefix}-summary.csv`, csv(summaries));
  await writeFile(
    `${prefix}.json`,
    JSON.stringify(
      {
        sourceRoot,
        label,
        node: process.version,
        platform: process.platform,
        sizes,
        batches,
        repeats,
        steps,
        workload,
        summaries,
      },
      null,
      2,
    ),
  );
  console.log(`Results: ${prefix}-summary.csv`);
  // Confirm the seed still exists; measurement copies never mutate or truncate it.
  assert((await readFile(path.join(directory, `seed-${workload}-${sizes[0]}.db`))).length > 0);
} finally {
  if (configuredDataDirectory === undefined) await rm(directory, { recursive: true, force: true });
}
