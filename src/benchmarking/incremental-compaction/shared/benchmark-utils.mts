// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';
import * as fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CollectionCatalog } from '../../../compaction/collectioncatalog.mjs';
import type { IncrementalCompactionPolicy } from '../../../compaction/compaction.mjs';
import { MockFile } from '../../../core/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../../../dbms/dbmsback.mjs';
import { documentToJSON, JSONtoDocument, type Document } from '../../../dbms/document.mjs';
import type { FreeBlockFileStats } from '../../../freeblockfile/freeblockfile.mjs';

export const DEFAULT_K = 1.25;
export const DEFAULT_BLOCK_SIZE = 4096;

export type BenchmarkStatus = 'converged' | 'no-op' | 'plateau-no-safe-progress' | 'budget-exhausted';

export type StorageSample = {
  totalBlocks: number;
  usedBlocks: number;
  freeBlocks: number;
  amplification: number;
  fileBytes: number;
};

export type StepSample = StorageSample & {
  scenario: string;
  step: number;
  didWork: boolean;
  timeMs: number;
  shrunkBlocksThisStep?: number;
  cumulativeShrunkBytes: number;
  stepRelocatedDocuments?: number;
  stepRelocatedBtreeNodes?: number;
  stepRelocatedHnswUnits?: number;
  stepReclaimedTailBlocks?: number;
  relocatedDocuments: number;
  relocatedBtreeNodes: number;
  relocatedHnswUnits: number;
  reclaimedTailBlocks: number;
};

export type QueryTimings = {
  idLookupMs: number;
  cursorQueryMs: number;
  semanticQueryMs?: number;
};

export type ScenarioResult = {
  scenario: string;
  status: BenchmarkStatus;
  before: StorageSample;
  after: StorageSample;
  shrunkBlocks: number;
  shrunkBytes: number;
  stepsTaken: number;
  timeTakenMs: number;
  relocatedDocuments: number;
  relocatedBtreeNodes: number;
  relocatedHnswUnits: number;
  reclaimedTailBlocks: number;
  firstShrinkStep?: number;
  firstShrinkReason?: string;
  cumulativeRecordsBeforeFirstShrink?: number;
  cumulativeBtreeBeforeFirstShrink?: number;
  cumulativeHnswBeforeFirstShrink?: number;
  tailReclaimEvents?: number;
  didRecordsMatter?: boolean;
  didBtreeMatter?: boolean;
  didHnswMatter?: boolean;
  recordsLikelyEnabledFirstShrink?: boolean;
  btreeLikelyEnabledFirstShrink?: boolean;
  hnswLikelyEnabledFirstShrink?: boolean;
  sameIds?: boolean;
  sameDocumentContents?: boolean;
  sameIndexedResults?: boolean;
  sameCursorResults?: boolean;
  sameSemanticResults?: boolean;
  semanticResultsReadable?: boolean;
  postReopenChecksPassed?: boolean;
  queryBefore?: QueryTimings;
  queryAfter?: QueryTimings;
  history: StepSample[];
};

export type DatabaseSnapshot = {
  collections: string[];
  documentCount: number;
  docsByCollection: Record<string, Record<string, string>>;
  indexedResultIds: Record<string, string[]>;
  semanticResultIds: Record<string, string[]>;
};

export type BenchmarkDb = {
  db: DbmsBack;
  data: MockFile;
  log: MockFile;
  hnswConfig?: HnswConfig;
};

export const sharedDir = dirname(fileURLToPath(import.meta.url));
export const benchmarkRootDir = dirname(sharedDir);
export const resultsRootDir = join(benchmarkRootDir, 'results');
export const resultsDir = join(resultsRootDir, 'raw');
export const plotsDir = join(resultsRootDir, 'plots');

export function makeHnswConfig(
  options: Partial<Pick<HnswConfig, 'dimension' | 'M' | 'maxStoredLevel' | 'efConstruction' | 'efSearch'>> = {},
): HnswConfig {
  const dimension = options.dimension ?? 4;
  return {
    dimension,
    embeddingFn: (text) => Promise.resolve(makeEmbedding(text, dimension)),
    M: options.M ?? 4,
    maxStoredLevel: options.maxStoredLevel,
    efConstruction: options.efConstruction ?? 16,
    efSearch: options.efSearch ?? 10,
  };
}

export function makeEmbedding(text: string, dimension = 4): Float32Array {
  const vector = new Float32Array(dimension);
  for (let i = 0; i < text.length; i++) {
    vector[i % vector.length] += text.charCodeAt(i) % 31;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}

export async function makeBenchmarkDb(
  options: { hnsw?: boolean; blockSize?: number; hnswConfig?: HnswConfig } = {},
): Promise<BenchmarkDb> {
  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  const data = new MockFile(blockSize);
  const log = new MockFile(blockSize);
  const hnswConfig = options.hnsw ? (options.hnswConfig ?? makeHnswConfig()) : undefined;
  const db = new DbmsBack(data, log, hnswConfig);
  await db.create();
  return { db, data, log, hnswConfig };
}

export async function reopenBenchmarkDb(source: BenchmarkDb): Promise<DbmsBack> {
  await source.db.close();
  return await DbmsBack.open(source.data, source.log, source.hnswConfig);
}

export function makeDocument(
  collection: string,
  id: string,
  fields: Record<string, string | number | boolean> = {},
): Document {
  return JSONtoDocument(
    JSON.stringify({
      id,
      ...fields,
    }),
    collection,
  );
}

export async function insertDocuments(
  db: DbmsBack,
  collection: string,
  prefix: string,
  count: number,
  options: {
    payloadWords?: number;
    group?: string;
    indexedFields?: number;
    semanticText?: string;
    skipSemanticIndex?: boolean;
  } = {},
): Promise<void> {
  const payload = `${prefix} payload `.repeat(options.payloadWords ?? 20);
  for (let i = 0; i < count; i++) {
    const id = `${prefix}${i.toString().padStart(4, '0')}`;
    const fields: Record<string, string | number | boolean> = {
      group: options.group ?? prefix,
      category: `cat-${(i % 7).toString()}`,
      rank: i % 31,
      active: i % 2 === 0,
      body: `${options.semanticText ?? prefix} ${id}`,
      _payload: payload,
    };
    for (let field = 0; field < (options.indexedFields ?? 0); field++) {
      fields[`idx${field.toString()}`] = `${prefix}-${field.toString()}-${(i % 13).toString()}`;
    }
    await db.insertDocument(makeDocument(collection, id, fields), undefined, {
      skipSemanticIndex: options.skipSemanticIndex,
    });
  }
}

export async function deleteDocuments(db: DbmsBack, collection: string, prefix: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await db.deleteDocument(`${prefix}${i.toString().padStart(4, '0')}`, collection);
  }
}

export async function editDocuments(db: DbmsBack, collection: string, prefix: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await db.editDocumentByID(collection, `${prefix}${i.toString().padStart(4, '0')}`, 'category', `edited-${i % 5}`);
  }
}

export function sampleStats(stats: FreeBlockFileStats): StorageSample {
  return {
    totalBlocks: stats.totalBlocks,
    usedBlocks: stats.usedBlocks,
    freeBlocks: stats.freeBlocks,
    amplification: stats.totalBlocks / Math.max(1, stats.usedBlocks),
    fileBytes: stats.fileSizeBytes,
  };
}

export async function getStorageSample(db: DbmsBack): Promise<StorageSample> {
  return sampleStats(await db.getCompactionStorageStats());
}

export async function runIncrementalUntilStable(
  db: DbmsBack,
  scenario: string,
  policy: IncrementalCompactionPolicy,
  maxSteps: number,
): Promise<ScenarioResult> {
  const before = await getStorageSample(db);
  const start = performance.now();
  const history: StepSample[] = [];
  let relocatedDocuments = 0;
  let relocatedBtreeNodes = 0;
  let relocatedHnswUnits = 0;
  let reclaimedTailBlocks = 0;
  let current = before;
  let previous = before;

  for (let step = 1; step <= maxSteps; step++) {
    const stepStart = performance.now();
    const result = await db.runIncrementalCompactionStep(policy);
    const timeMs = performance.now() - stepStart;
    current = await getStorageSample(db);

    relocatedDocuments += result.relocatedDocuments ?? 0;
    relocatedBtreeNodes += result.relocatedBtreeNodes ?? 0;
    relocatedHnswUnits += result.relocatedHnswUnits ?? 0;
    reclaimedTailBlocks += result.reclaimedTailBlocks ?? 0;

    history.push({
      scenario,
      step,
      didWork: result.didWork,
      timeMs,
      shrunkBlocksThisStep: Math.max(0, previous.totalBlocks - current.totalBlocks),
      cumulativeShrunkBytes: before.fileBytes - current.fileBytes,
      stepRelocatedDocuments: result.relocatedDocuments ?? 0,
      stepRelocatedBtreeNodes: result.relocatedBtreeNodes ?? 0,
      stepRelocatedHnswUnits: result.relocatedHnswUnits ?? 0,
      stepReclaimedTailBlocks: result.reclaimedTailBlocks ?? 0,
      relocatedDocuments,
      relocatedBtreeNodes,
      relocatedHnswUnits,
      reclaimedTailBlocks,
      ...current,
    });

    previous = current;
    if (!result.didWork || current.amplification <= policy.maxAmplification) break;
  }

  const after = await getStorageSample(db);
  return {
    scenario,
    status: determineStatus(before, after, history, policy.maxAmplification),
    before,
    after,
    shrunkBlocks: before.totalBlocks - after.totalBlocks,
    shrunkBytes: before.fileBytes - after.fileBytes,
    stepsTaken: history.length,
    timeTakenMs: performance.now() - start,
    relocatedDocuments,
    relocatedBtreeNodes,
    relocatedHnswUnits,
    reclaimedTailBlocks,
    history,
  };
}

export async function runAndWriteScenario(
  scenario: string,
  build: (db: DbmsBack) => Promise<void>,
  options: {
    hnsw?: boolean;
    hnswConfig?: HnswConfig;
    policy?: IncrementalCompactionPolicy;
    maxSteps?: number;
    assertConverged?: boolean;
    benchmarkQueries?: boolean;
  } = {},
): Promise<ScenarioResult> {
  const { db } = await makeBenchmarkDb({ hnsw: options.hnsw, hnswConfig: options.hnswConfig });
  await build(db);
  const policy = options.policy ?? { maxAmplification: DEFAULT_K, targetBatchDocuments: 4, targetBatchUnits: 4 };
  const queryBefore = options.benchmarkQueries ? await benchmarkQueries(db, options.hnsw === true) : undefined;
  const result = await runIncrementalUntilStable(db, scenario, policy, options.maxSteps ?? 80);
  const queryAfter = options.benchmarkQueries ? await benchmarkQueries(db, options.hnsw === true) : undefined;
  result.queryBefore = queryBefore;
  result.queryAfter = queryAfter;

  if (options.assertConverged) {
    assert.strictEqual(result.status, 'converged');
  }

  await writeScenarioArtifacts(result);
  printScenarioResult(result);
  await db.close();
  return result;
}

export async function snapshotDatabase(
  db: DbmsBack,
  semanticQueries: Array<{ collection: string; query: string; k: number }> = [],
): Promise<DatabaseSnapshot> {
  const catalog = new CollectionCatalog(db);
  const docsByCollection: Record<string, Record<string, string>> = {};
  const indexedResultIds: Record<string, string[]> = {};
  const semanticResultIds: Record<string, string[]> = {};
  let documentCount = 0;

  for (const collection of catalog.listCollections()) {
    docsByCollection[collection] = {};
    if (!catalog.hasIdTree(collection)) continue;

    const docs: Document[] = [];
    for await (const doc of await db.cursor(collection, 'id')) {
      docs.push(doc);
      docsByCollection[collection][String(doc.getId())] = documentToJSON(doc);
      documentCount++;
    }

    indexedResultIds[`${collection}:id:*`] = docs.map((doc) => String(doc.getId())).sort();
    for (const field of catalog.getIndexedFields(collection)) {
      if (field === 'id') continue;
      const values = new Set<string | number>();
      for (const doc of docs) {
        const value = doc.getFields()[field];
        if (typeof value === 'string' || typeof value === 'number') values.add(value);
      }
      for (const value of values) {
        indexedResultIds[`${collection}:${field}:${String(value)}`] = await queryIds(db, collection, field, value);
      }
    }
  }

  for (const semantic of semanticQueries) {
    semanticResultIds[`${semantic.collection}:${semantic.query}`] = (
      await db.semanticSearch(semantic.collection, semantic.query, semantic.k)
    )
      .map((doc) => String(doc.getId()))
      .sort();
  }

  return {
    collections: catalog.listCollections(),
    documentCount,
    docsByCollection,
    indexedResultIds,
    semanticResultIds,
  };
}

export async function queryIds(
  db: DbmsBack,
  collection: string,
  field: string,
  value?: string | number,
): Promise<string[]> {
  const ids: string[] = [];
  const cursor = value === undefined ? await db.cursor(collection, field) : await db.cursor(collection, field, value);
  for await (const doc of cursor) ids.push(String(doc.getId()));
  return ids.sort();
}

export async function benchmarkQueries(db: DbmsBack, includeSemantic: boolean): Promise<QueryTimings> {
  const idStart = performance.now();
  for (let i = 0; i < 80; i++) {
    await db.getDocument(`tail${(i % 20).toString().padStart(4, '0')}`, 'items').catch(() => undefined);
  }
  const idLookupMs = performance.now() - idStart;

  const cursorStart = performance.now();
  for (let i = 0; i < 20; i++) {
    for await (const doc of await db.cursor('items', 'group', 'tail')) void doc;
  }
  const cursorQueryMs = performance.now() - cursorStart;

  if (!includeSemantic) return { idLookupMs, cursorQueryMs };

  const semanticStart = performance.now();
  for (let i = 0; i < 10; i++) {
    await db.semanticSearch('items', 'tail semantic payload', 5);
  }
  return {
    idLookupMs,
    cursorQueryMs,
    semanticQueryMs: performance.now() - semanticStart,
  };
}

export function printScenarioResult(result: ScenarioResult): void {
  annotateResult(result);
  console.log(`--- ${result.scenario.toUpperCase()} ---`);
  console.log(
    `Before: blocks=${result.before.totalBlocks.toString()} used=${result.before.usedBlocks.toString()} ` +
      `free=${result.before.freeBlocks.toString()} amp=${result.before.amplification.toFixed(3)}`,
  );
  console.log(
    `After:  blocks=${result.after.totalBlocks.toString()} used=${result.after.usedBlocks.toString()} ` +
      `free=${result.after.freeBlocks.toString()} amp=${result.after.amplification.toFixed(3)}`,
  );
  console.log(`Status: ${result.status}`);
  console.log(`Steps:  ${result.stepsTaken.toString()} in ${result.timeTakenMs.toFixed(2)} ms`);
  console.log(
    `Work:   records=${result.relocatedDocuments.toString()} btree=${result.relocatedBtreeNodes.toString()} ` +
      `hnsw=${result.relocatedHnswUnits.toString()} tailBlocks=${result.reclaimedTailBlocks.toString()}`,
  );
  console.log(`Shrink: blocks=${result.shrunkBlocks.toString()} bytes=${result.shrunkBytes.toString()}`);
  if (result.firstShrinkStep !== undefined) {
    console.log(
      `First shrink: step=${result.firstShrinkStep.toString()} cause=${result.firstShrinkReason ?? 'unknown'}`,
    );
  }
  if (result.sameDocumentContents !== undefined) {
    console.log(
      `Checks: ids=${String(result.sameIds)} docs=${String(result.sameDocumentContents)} ` +
        `indexes=${String(result.sameIndexedResults)} cursors=${String(result.sameCursorResults)} ` +
        `semanticReadable=${String(result.semanticResultsReadable)} reopen=${String(result.postReopenChecksPassed ?? '')}`,
    );
  }
}

export async function writeScenarioArtifacts(result: ScenarioResult): Promise<void> {
  annotateResult(result);
  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(join(resultsDir, `${result.scenario}.json`), JSON.stringify(result, null, 2));
  await fs.writeFile(join(resultsDir, `${result.scenario}-steps.csv`), stepCsv(result.history));
  await upsertSummary(result);
}

export function runIfMain(metaUrl: string, main: () => Promise<void>): void {
  const entryUrl = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
  if (entryUrl !== metaUrl) return;

  void main().catch((error: unknown) => {
    console.error('Incremental compaction benchmark failed');
    console.error(error);
    process.exitCode = 1;
  });
}

function determineStatus(
  before: StorageSample,
  after: StorageSample,
  history: StepSample[],
  maxAmplification: number,
): BenchmarkStatus {
  if (
    history.length === 0 ||
    (history.length === 1 && !history[0].didWork && before.amplification <= maxAmplification)
  ) {
    return 'no-op';
  }
  if (after.amplification <= maxAmplification) return 'converged';
  if (history.some((step) => !step.didWork)) return 'plateau-no-safe-progress';
  return 'budget-exhausted';
}

function stepCsv(history: StepSample[]): string {
  const header = [
    'scenario',
    'step',
    'didWork',
    'timeMs',
    'totalBlocks',
    'usedBlocks',
    'freeBlocks',
    'amplification',
    'fileBytes',
    'shrunkBlocksThisStep',
    'cumulativeShrunkBytes',
    'stepRelocatedDocuments',
    'stepRelocatedBtreeNodes',
    'stepRelocatedHnswUnits',
    'stepReclaimedTailBlocks',
    'relocatedDocuments',
    'relocatedBtreeNodes',
    'relocatedHnswUnits',
    'reclaimedTailBlocks',
  ];
  const rows = history.map((step) =>
    [
      step.scenario,
      step.step,
      step.didWork,
      step.timeMs.toFixed(3),
      step.totalBlocks,
      step.usedBlocks,
      step.freeBlocks,
      step.amplification.toFixed(4),
      step.fileBytes,
      step.shrunkBlocksThisStep ?? 0,
      step.cumulativeShrunkBytes,
      step.stepRelocatedDocuments ?? 0,
      step.stepRelocatedBtreeNodes ?? 0,
      step.stepRelocatedHnswUnits ?? 0,
      step.stepReclaimedTailBlocks ?? 0,
      step.relocatedDocuments,
      step.relocatedBtreeNodes,
      step.relocatedHnswUnits,
      step.reclaimedTailBlocks,
    ].join(','),
  );
  return [header.join(','), ...rows].join('\n');
}

async function upsertSummary(result: ScenarioResult): Promise<void> {
  const path = join(resultsDir, 'incremental_compaction_summary.csv');
  const header = [
    'scenario',
    'status',
    'totalBlocksBefore',
    'usedBlocksBefore',
    'freeBlocksBefore',
    'amplificationBefore',
    'fileBytesBefore',
    'totalBlocksAfter',
    'usedBlocksAfter',
    'freeBlocksAfter',
    'amplificationAfter',
    'fileBytesAfter',
    'shrunkBlocks',
    'shrunkBytes',
    'stepsTaken',
    'timeTakenMs',
    'relocatedDocuments',
    'relocatedBtreeNodes',
    'relocatedHnswUnits',
    'reclaimedTailBlocks',
    'firstShrinkStep',
    'firstShrinkReason',
    'cumulativeRecordsBeforeFirstShrink',
    'cumulativeBtreeBeforeFirstShrink',
    'cumulativeHnswBeforeFirstShrink',
    'tailReclaimEvents',
    'didRecordsMatter',
    'didBtreeMatter',
    'didHnswMatter',
    'recordsLikelyEnabledFirstShrink',
    'btreeLikelyEnabledFirstShrink',
    'hnswLikelyEnabledFirstShrink',
    'sameIds',
    'sameDocumentContents',
    'sameIndexedResults',
    'sameCursorResults',
    'sameSemanticResults',
    'semanticResultsReadable',
    'postReopenChecksPassed',
  ];
  const row = [
    result.scenario,
    result.status,
    result.before.totalBlocks,
    result.before.usedBlocks,
    result.before.freeBlocks,
    result.before.amplification.toFixed(4),
    result.before.fileBytes,
    result.after.totalBlocks,
    result.after.usedBlocks,
    result.after.freeBlocks,
    result.after.amplification.toFixed(4),
    result.after.fileBytes,
    result.shrunkBlocks,
    result.shrunkBytes,
    result.stepsTaken,
    result.timeTakenMs.toFixed(3),
    result.relocatedDocuments,
    result.relocatedBtreeNodes,
    result.relocatedHnswUnits,
    result.reclaimedTailBlocks,
    result.firstShrinkStep ?? '',
    result.firstShrinkReason ?? '',
    result.cumulativeRecordsBeforeFirstShrink ?? 0,
    result.cumulativeBtreeBeforeFirstShrink ?? 0,
    result.cumulativeHnswBeforeFirstShrink ?? 0,
    result.tailReclaimEvents ?? 0,
    result.didRecordsMatter === true,
    result.didBtreeMatter === true,
    result.didHnswMatter === true,
    result.recordsLikelyEnabledFirstShrink === true,
    result.btreeLikelyEnabledFirstShrink === true,
    result.hnswLikelyEnabledFirstShrink === true,
    result.sameIds ?? '',
    result.sameDocumentContents ?? '',
    result.sameIndexedResults ?? '',
    result.sameCursorResults ?? '',
    result.sameSemanticResults ?? '',
    result.semanticResultsReadable ?? '',
    result.postReopenChecksPassed ?? '',
  ].join(',');

  let existing: string[] = [];
  try {
    existing = (await fs.readFile(path, 'utf-8')).trim().split(/\r?\n/).filter(Boolean);
  } catch {
    existing = [];
  }

  const rows = [header.join(',')];
  rows.push(...existing.slice(1).filter((line) => !line.startsWith(`${result.scenario},`)));
  rows.push(row);
  await fs.writeFile(path, rows.join('\n'));
}

export function annotateResult(result: ScenarioResult): ScenarioResult {
  if (result.tailReclaimEvents !== undefined) return result;

  const firstShrink = result.history.find((step) => (step.shrunkBlocksThisStep ?? 0) > 0);
  const firstShrinkIndex = firstShrink === undefined ? -1 : result.history.indexOf(firstShrink);
  const attributionWindow = firstShrinkIndex >= 0 ? result.history.slice(0, firstShrinkIndex + 1) : result.history;

  const recordsBeforeFirstShrink = attributionWindow.reduce((sum, step) => sum + (step.stepRelocatedDocuments ?? 0), 0);
  const btreeBeforeFirstShrink = attributionWindow.reduce((sum, step) => sum + (step.stepRelocatedBtreeNodes ?? 0), 0);
  const hnswBeforeFirstShrink = attributionWindow.reduce((sum, step) => sum + (step.stepRelocatedHnswUnits ?? 0), 0);

  result.firstShrinkStep = firstShrink?.step;
  result.firstShrinkReason = firstShrink === undefined ? undefined : describeFirstShrink(firstShrink);
  result.cumulativeRecordsBeforeFirstShrink = recordsBeforeFirstShrink;
  result.cumulativeBtreeBeforeFirstShrink = btreeBeforeFirstShrink;
  result.cumulativeHnswBeforeFirstShrink = hnswBeforeFirstShrink;
  result.tailReclaimEvents = result.history.filter((step) => (step.stepReclaimedTailBlocks ?? 0) > 0).length;
  result.didRecordsMatter = result.relocatedDocuments > 0;
  result.didBtreeMatter = result.relocatedBtreeNodes > 0;
  result.didHnswMatter = result.relocatedHnswUnits > 0;
  result.recordsLikelyEnabledFirstShrink = recordsBeforeFirstShrink > 0;
  result.btreeLikelyEnabledFirstShrink = btreeBeforeFirstShrink > 0;
  result.hnswLikelyEnabledFirstShrink = hnswBeforeFirstShrink > 0;

  return result;
}

function describeFirstShrink(step: StepSample): string {
  const causes: string[] = [];
  if ((step.stepRelocatedDocuments ?? 0) > 0) causes.push('record relocation');
  if ((step.stepRelocatedBtreeNodes ?? 0) > 0) causes.push('btree relocation');
  if ((step.stepRelocatedHnswUnits ?? 0) > 0) causes.push('hnsw relocation');
  if ((step.stepReclaimedTailBlocks ?? 0) > 0) causes.push('tail reclaim');
  return causes.length > 0 ? causes.join(' + ') : 'tail size changed';
}
