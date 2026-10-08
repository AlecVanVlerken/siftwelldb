// @author: Alec Van Vlerken
// @date: 2026-02-20
//
// Large dataset generator / bulk loader using SimpleDbms + RealFile.
//
// What it does:
// - Inserts documents in batches (commit per batch)
// - Stops once DATAFILE size reaches target size
// - Logs progress and writes progress.csv for plotting

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { SimpleDbms } from '../../src/database/simpledbms.mjs';
import { RealFile } from '../../src/storage/file.mjs';

const BASE_DIR = join('benchmarks', 'large-dataset');
const DB_DIR = join(BASE_DIR, 'db');
const RESULTS_DIR = join(BASE_DIR, 'results');
const IMAGES_DIR = join(RESULTS_DIR, 'images');

type Args = {
  targetGB: number;
  payloadKB: number;
  batch: number;

  collection: string;
  indexedFields: number;
  fieldSize: number;
};

function parseArgs(argv: string[]): Args {
  const defaults: Args = {
    targetGB: 50,
    payloadKB: 512,
    batch: 200,

    collection: 'bench',
    indexedFields: 1,
    fieldSize: 32,
  };

  const getNum = (name: string, def: number): number => {
    const idx = argv.indexOf(`--${name}`);
    if (idx === -1) return def;
    const raw = argv[idx + 1];
    if (!raw || raw.startsWith('--')) throw new Error(`Missing value for --${name}`);
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid value for --${name}`);
    return v;
  };

  const targetGB = getNum('targetGB', defaults.targetGB);
  const payloadKB = getNum('payloadKB', defaults.payloadKB);
  const batch = getNum('batch', defaults.batch);

  return {
    targetGB,
    payloadKB,
    batch,
    collection: defaults.collection,
    indexedFields: defaults.indexedFields,
    fieldSize: defaults.fieldSize,
  };
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function makePayloadString(payloadBytes: number): string {
  // JSON-safe large payload. Repeated pattern is CPU-cheap and still takes disk space.
  const chunk = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const reps = Math.ceil(payloadBytes / chunk.length);
  return chunk.repeat(reps).slice(0, payloadBytes);
}

function makeDocJson(id: string, indexedFields: number, fieldSize: number, payload: string): string {
  const doc: Record<string, unknown> = { id };

  for (let i = 0; i < indexedFields; i++) {
    doc[`field${i}`] = `value${i}-${id}`.padEnd(fieldSize, 'x').slice(0, fieldSize);
  }

  // IMPORTANT: store large data in a field explicitly configured as unindexed
  doc['_payload'] = payload;

  // Also non-indexed
  doc['_text'] = `doc ${id} lorem ipsum token${Number(id.replace(/\D/g, '')) % 1000}`;

  return JSON.stringify(doc);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Ensure benchmark folders exist
  mkdirSync(DB_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(IMAGES_DIR, { recursive: true });

  const dataPath = join(DB_DIR, 'db.data');
  const logPath = join(DB_DIR, 'db.log');
  const csvPath = join(RESULTS_DIR, 'progress.csv');

  const dataFile = new RealFile(dataPath);
  const logFile = new RealFile(logPath);

  const targetBytes = args.targetGB * 1024 * 1024 * 1024;
  const payloadBytes = args.payloadKB * 1024;

  console.log('--- Large Dataset Loader (SimpleDbms) ---');
  console.log(`Base dir:     ${BASE_DIR}`);
  console.log(`DB dir:       ${DB_DIR}`);
  console.log(`Results dir:  ${RESULTS_DIR}`);
  console.log(`Images dir:   ${IMAGES_DIR}`);
  console.log('');
  console.log(`Target:       ${args.targetGB} GB (${formatBytes(targetBytes)})`);
  console.log(`Payload/doc:  ${args.payloadKB} KB (${formatBytes(payloadBytes)})`);
  console.log(`Batch commit: ${args.batch}`);
  console.log(`Collection:   ${args.collection}`);
  console.log(`IndexedFields:${args.indexedFields}`);
  console.log('');

  // CSV for plotting
  writeFileSync(csvPath, 't_ms,docs,data_bytes,docs_per_sec,avg_mb_per_sec,rss_bytes,heap_used_bytes\n');

  const db = await SimpleDbms.create(dataFile, logFile);

  await db.setFieldIndexed(args.collection, '_payload', false);
  await db.setFieldIndexed(args.collection, '_text', false);
  // Pre-build payload template once
  const payloadTemplate = makePayloadString(payloadBytes);

  let docs = 0;
  const startMs = nowMs();
  let lastMs = startMs;
  let lastDocs = 0;

  while (true) {
    // Insert a batch
    for (let i = 0; i < args.batch; i++) {
      const id = `doc${docs}`;
      const docJson = makeDocJson(id, args.indexedFields, args.fieldSize, payloadTemplate);
      await db.insertDocument(args.collection, docJson);
      docs++;
    }

    await db.commit();

    // Measure disk usage
    const dataStat = await dataFile.stat();
    const dataBytes = dataStat.size;

    // Throughput
    const t = nowMs();
    const dt = (t - lastMs) / 1000;
    const dDocs = docs - lastDocs;
    const docsPerSec = dt > 0 ? dDocs / dt : 0;

    const elapsedSec = (t - startMs) / 1000;
    const avgMBps = elapsedSec > 0 ? dataBytes / (1024 * 1024) / elapsedSec : 0;

    const mem = process.memoryUsage();

    console.log(
      `[${elapsedSec.toFixed(1)}s] docs=${docs.toLocaleString()} data=${formatBytes(dataBytes)} ` +
        `rate=${docsPerSec.toFixed(1)} docs/s avg=${avgMBps.toFixed(1)} MB/s rss=${formatBytes(mem.rss)}`,
    );

    appendFileSync(
      csvPath,
      `${t - startMs},${docs},${dataBytes},${docsPerSec.toFixed(3)},${avgMBps.toFixed(3)},${mem.rss},${mem.heapUsed}\n`,
    );

    lastMs = t;
    lastDocs = docs;

    if (dataBytes >= targetBytes) {
      console.log('');
      console.log(`Reached target: data=${formatBytes(dataBytes)}`);
      break;
    }
  }

  await db.close();

  console.log(`DB kept at: ${DB_DIR}`);
  console.log('Done.');
  console.log(`CSV written to: ${csvPath}`);
  console.log(`Put plot images in: ${IMAGES_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
