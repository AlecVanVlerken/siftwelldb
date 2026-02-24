// @author: Alec Van Vlerken
// @date: 2026-02-20
//
// Workload runner for an existing on-disk DB created by large_dataset_loader.
//
// - Opens existing DB (SimpleDbms + RealFile)
// - Runs random GETs + occasional range scans
// - Logs once per second to CSV

import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SimpleDbms } from '../../dbms/simpledbms.mjs';
import { RealFile } from '../../core/file.mjs';

const BASE_DIR = join('src', 'benchmarking', 'large-dataset');

const DB_DIR = join(BASE_DIR, 'db');
const DATA_PATH = join(DB_DIR, 'db.data');
const LOG_PATH = join(DB_DIR, 'db.log');

const RESULTS_DIR = join(BASE_DIR, 'results');
const WORKLOAD_CSV = join(RESULTS_DIR, 'workload.csv');
const LOADER_PROGRESS = join(RESULTS_DIR, 'progress.csv');

type Args = {
  seconds: number;
  collection: string;
  maxIdExclusive: number;
  scanEvery: number;
  scanLen: number;
};

function parseArgs(argv: string[]): Args {
  const getNum = (name: string, def: number): number => {
    const idx = argv.indexOf(`--${name}`);
    if (idx === -1) return def;
    const v = Number(argv[idx + 1]);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid --${name}`);
    return v;
  };

  const seconds = getNum('seconds', 120);
  const scanEvery = getNum('scanEvery', 10);
  const scanLen = getNum('scanLen', 100);

  const maxIdFromCSV = readLastDocsFromLoaderCSV(LOADER_PROGRESS) ?? 1_000_000;

  return {
    seconds,
    collection: 'bench',
    maxIdExclusive: maxIdFromCSV,
    scanEvery,
    scanLen,
  };
}

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);
}

function readLastDocsFromLoaderCSV(path: string): number | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  if (lines.length < 2) return null;
  const last = lines.at(-1)!.split(',');
  const docs = Number(last[1]);
  return Number.isFinite(docs) ? docs : null;
}

async function doRandomGet(db: SimpleDbms, collection: string, maxId: number) {
  const id = `doc${Math.floor(Math.random() * maxId)}`;
  await db.getDocumentById(collection, id);
}

async function doRangeScan(db: SimpleDbms, collection: string, startId: number, len: number) {
  const it = db.cursor(collection, 'id', `doc${startId}`);
  let seen = 0;
  for await (const _ of it) {
    void _;
    if (++seen >= len) break;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(RESULTS_DIR, { recursive: true });

  // Fail fast if DB files are missing
  if (!existsSync(DATA_PATH) || !existsSync(LOG_PATH)) {
    throw new Error(`DB files not found.\nExpected:\n  ${DATA_PATH}\n  ${LOG_PATH}\nRun the loader first.`);
  }

  console.log('--- Large Dataset Workload ---');
  console.log(`DB data: ${DATA_PATH}`);
  console.log(`DB log:  ${LOG_PATH}`);
  console.log(`Duration: ${args.seconds}s`);
  console.log(`Docs: [0, ${args.maxIdExclusive})`);
  console.log(`Scan mix: 1 scan every ${args.scanEvery} ops (scanLen=${args.scanLen})`);
  console.log('');

  const dataFile = new RealFile(DATA_PATH);
  const logFile = new RealFile(LOG_PATH);
  const db = await SimpleDbms.open(dataFile, logFile);

  writeFileSync(WORKLOAD_CSV, 't_ms,rss,heapUsed,external,dataBytes,qps,avgLat,p50,p95,gets,scans\n');

  const start = nowMs();
  const end = start + args.seconds * 1000;

  // Per-interval counters (reset every second)
  let intervalStart = start;
  let ops = 0;
  let gets = 0;
  let scans = 0;
  const lats: number[] = [];

  // Global op counter so scanEvery stays consistent across the whole run
  let totalOps = 0;

  while (nowMs() < end) {
    const t0 = nowMs();

    const doScan = totalOps > 0 && totalOps % args.scanEvery === 0;

    try {
      if (doScan) {
        const startId = Math.floor(Math.random() * args.maxIdExclusive);
        await doRangeScan(db, args.collection, startId, args.scanLen);
        scans++;
      } else {
        await doRandomGet(db, args.collection, args.maxIdExclusive);
        gets++;
      }
    } catch (err) {
      // Intentionally ignored: random GET/scan may miss if maxIdExclusive is a bit off.
      void err;
    }

    lats.push(nowMs() - t0);

    ops++;
    totalOps++;

    const now = nowMs();
    if (now - intervalStart >= 1000) {
      const mem = process.memoryUsage();

      const dataBytes = (await dataFile.stat()).size;

      const qps = ops / ((now - intervalStart) / 1000);
      const avg = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0;
      const s = [...lats].sort((a, b) => a - b);

      appendFileSync(
        WORKLOAD_CSV,
        `${now - start},${mem.rss},${mem.heapUsed},${mem.external},${dataBytes},${qps.toFixed(
          1,
        )},${avg.toFixed(2)},${percentile(s, 0.5).toFixed(2)},${percentile(s, 0.95).toFixed(2)},${gets},${scans}\n`,
      );

      // reset interval stats
      ops = 0;
      gets = 0;
      scans = 0;
      lats.length = 0;
      intervalStart = now;
    }
  }

  await db.close();
  console.log('Done.');
  console.log(`CSV: ${WORKLOAD_CSV}`);
}

main().catch(console.error);
