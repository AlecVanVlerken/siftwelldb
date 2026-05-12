import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AtomicFile } from '../../atomic/atomicfile.mjs';
import { RealFile } from '../../core/file.mjs';
import { MockFile } from '../../core/mockfile.mjs';
import { FreeBlockFile } from '../../freeblockfile/freeblockfile.mjs';
import { HNSWGraphStorage } from '../../hnsw/hnswGraphStorage.mjs';
import { HNSWIndex, type HNSWParams } from '../../hnsw/hnswIndex.mjs';
import { VectorHeapFile } from '../../hnsw/vectorHeapFile.mjs';

export const BASE_DIR = join('src', 'benchmarking', 'hnsw');
export const RESULTS_DIR = join(BASE_DIR, 'results');
export const IMAGES_DIR = join(RESULTS_DIR, 'images');
export const DB_DIR = join(RESULTS_DIR, 'db');

export type StorageMode = 'mock' | 'real';

type RealStorageDescriptor = {
  mode: 'real';
  label: string;
  runDir: string;
  blockSize: number;
  keepFiles: boolean;
  dataPath: string;
  logPath: string;
};

type MockStorageDescriptor = {
  mode: 'mock';
  label: string;
  runDir: string;
  blockSize: number;
  keepFiles: boolean;
  dataFile: MockFile;
  logFile: MockFile;
};

export type StorageDescriptor = RealStorageDescriptor | MockStorageDescriptor;

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

export function ensureBenchmarkDirs(): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(IMAGES_DIR, { recursive: true });
  mkdirSync(DB_DIR, { recursive: true });
}

export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be numeric, got ${raw}.`);
  }
  return value;
}

export function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

export function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`Environment variable ${name} must be boolean-like, got ${raw}.`);
}

export function envNumberList(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const values = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) {
    throw new Error(`Environment variable ${name} must contain at least one numeric value.`);
  }
  return values;
}

export function resolveStorageMode(fallback: StorageMode = 'real'): StorageMode {
  const raw = process.env['HNSW_BENCH_STORAGE'];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (raw === 'real' || raw === 'mock') return raw;
  throw new Error(`HNSW_BENCH_STORAGE must be "real" or "mock", got ${raw}.`);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function percentile(sortedValues: readonly number[], percentileValue: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    Math.max(Math.ceil((percentileValue / 100) * sortedValues.length) - 1, 0),
    sortedValues.length - 1,
  );
  return sortedValues[index];
}

export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

export function renderProgressLine(
  label: string,
  done: number,
  total: number,
  startedAtMs: number,
  extra: string,
): string {
  const elapsedMs = performance.now() - startedAtMs;
  const pct = total > 0 ? ((done / total) * 100).toFixed(1).padStart(5) : '100.0';
  const rate = elapsedMs > 0 ? done / (elapsedMs / 1000) : 0;
  const remainingMs = rate > 0 && total > done ? ((total - done) / rate) * 1000 : 0;
  return (
    `[${label}] ${pct}%  ${done.toLocaleString()} / ${total.toLocaleString()}  ` +
    `elapsed=${formatDurationMs(elapsedMs)}  eta=${formatDurationMs(remainingMs)}  ${extra}`
  );
}

export function createStorageDescriptor(
  label: string,
  mode: StorageMode,
  blockSize: number,
  keepFiles: boolean,
): StorageDescriptor {
  ensureBenchmarkDirs();
  const runDir = join(DB_DIR, sanitizeLabel(label));

  if (mode === 'real') {
    rmSync(runDir, { recursive: true, force: true });
    mkdirSync(runDir, { recursive: true });
    return {
      mode,
      label,
      runDir,
      blockSize,
      keepFiles,
      dataPath: join(runDir, 'db.data'),
      logPath: join(runDir, 'db.log'),
    };
  }

  return {
    mode,
    label,
    runDir,
    blockSize,
    keepFiles,
    dataFile: new MockFile(blockSize),
    logFile: new MockFile(blockSize * 16),
  };
}

function instantiateAtomicFile(descriptor: StorageDescriptor): AtomicFile {
  if (descriptor.mode === 'real') {
    return new AtomicFile(new RealFile(descriptor.dataPath), new RealFile(descriptor.logPath));
  }
  return new AtomicFile(descriptor.dataFile, descriptor.logFile);
}

export async function createFreeBlockFile(descriptor: StorageDescriptor): Promise<FreeBlockFile> {
  const atomicFile = instantiateAtomicFile(descriptor);
  const file = new FreeBlockFile(atomicFile, descriptor.blockSize);
  await file.create();
  return file;
}

export async function openFreeBlockFile(descriptor: StorageDescriptor): Promise<FreeBlockFile> {
  const atomicFile = instantiateAtomicFile(descriptor);
  const file = new FreeBlockFile(atomicFile, descriptor.blockSize);
  await file.open();
  return file;
}

export async function createBenchmarkIndex(args: {
  label: string;
  dimension: number;
  blockSize: number;
  maxStoredLevel: number;
  keepFiles: boolean;
  storageMode: StorageMode;
  params: HNSWParams;
}): Promise<{
  descriptor: StorageDescriptor;
  graphStorage: HNSWGraphStorage;
  vectorHeap: VectorHeapFile;
  index: HNSWIndex;
}> {
  const descriptor = createStorageDescriptor(args.label, args.storageMode, args.blockSize, args.keepFiles);
  const file = await createFreeBlockFile(descriptor);
  const graphStorage = await HNSWGraphStorage.create(file, args.params.M, args.maxStoredLevel);
  const vectorHeap = new VectorHeapFile(file, args.dimension);
  const index = HNSWIndex.create(graphStorage, vectorHeap, args.params);
  return { descriptor, graphStorage, vectorHeap, index };
}

export async function openBenchmarkIndex(args: {
  descriptor: StorageDescriptor;
  metaBlockId: number;
  dimension: number;
  efSearch: number;
  efConstruction?: number;
}): Promise<{
  graphStorage: HNSWGraphStorage;
  vectorHeap: VectorHeapFile;
  index: HNSWIndex;
}> {
  const file = await openFreeBlockFile(args.descriptor);
  const graphStorage = await HNSWGraphStorage.open(file, args.metaBlockId);
  const vectorHeap = new VectorHeapFile(file, args.dimension);
  const index = await HNSWIndex.open(graphStorage, vectorHeap, {
    efSearch: args.efSearch,
    efConstruction: args.efConstruction,
  });
  return { graphStorage, vectorHeap, index };
}

export function writeJsonResult(fileName: string, payload: unknown): string {
  ensureBenchmarkDirs();
  const outputPath = join(RESULTS_DIR, fileName);
  writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  return outputPath;
}

export function cleanupStorage(descriptor: StorageDescriptor): void {
  if (descriptor.mode === 'real' && !descriptor.keepFiles) {
    rmSync(descriptor.runDir, { recursive: true, force: true });
  }
}
