// author: Frederik Caeyman
// date: 2026-03-08

import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';

import { MockFile } from '../core/mockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { parseRawDocument } from '../dbms/document.mjs';
import { RecordStore, type EncodedDocument } from '../dbms/recordstore.mjs';
import type { CompressionAlgorithm } from '../dbms/compression.mjs';

type ScenarioName = 'highly-compressible' | 'mixed' | 'low-compressible';

type BenchConfig = {
  docs: number;
  size: number;
};

type BenchResult = {
  scenario: ScenarioName;
  algorithm: CompressionAlgorithm;
  writeMs: number;
  readMs: number;
  totalPayloadBytes: number;
  contentPayloadBytes: number;
};

function parseArgs(): BenchConfig {
  const args = process.argv.slice(2);
  const getNum = (name: string, fallback: number): number => {
    const idx = args.findIndex((arg) => arg === `--${name}`);
    if (idx === -1) return fallback;
    const raw = args[idx + 1];
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  return {
    docs: getNum('docs', 1000),
    size: getNum('size', 4096),
  };
}

function makeCompressibleText(index: number, size: number): string {
  const base = `dbms compression benchmark ${index} `;
  return base.repeat(Math.ceil(size / base.length)).slice(0, size);
}

function makeMixedText(index: number, size: number): string {
  const repeatPart = `record-${index} lorem ipsum dolor sit amet `;
  const randomPart = randomBytes(Math.ceil(size / 8)).toString('hex');
  const mixed = `${repeatPart}${randomPart}`;
  return mixed.repeat(Math.ceil(size / mixed.length)).slice(0, size);
}

function makeLowCompressibleText(size: number): string {
  return randomBytes(Math.ceil(size / 2)).toString('hex').slice(0, size);
}

function buildDocuments(scenario: ScenarioName, docs: number, size: number): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (let i = 0; i < docs; i++) {
    let content: string;
    if (scenario === 'highly-compressible') {
      content = makeCompressibleText(i, size);
    } else if (scenario === 'mixed') {
      content = makeMixedText(i, size);
    } else {
      content = makeLowCompressibleText(size);
    }

    result.push({
      id: `${scenario}-${i}`,
      content,
      group: i % 10,
    });
  }

  return result;
}

function getContentEncodedEntry(encoded: EncodedDocument): { payloadBase64: string } {
  const entry = encoded.iterableEntries.find((field) => field.key === 'content');
  if (!entry) throw new Error('Expected content field in encoded document');
  return entry;
}

async function runScenario(
  scenario: ScenarioName,
  algorithm: CompressionAlgorithm,
  docs: Array<Record<string, unknown>>,
): Promise<BenchResult> {
  const dataFile = new MockFile(512 * 1024 * 1024);
  const logFile = new MockFile(512 * 1024 * 1024);
  const atomicFile = new AtomicFile(dataFile, logFile);
  const freeBlockFile = new FreeBlockFile(atomicFile, 4096);
  await freeBlockFile.create();

  const store = new RecordStore(freeBlockFile);
  const blockIds: number[] = [];

  const writeStart = performance.now();
  for (const raw of docs) {
    const doc = parseRawDocument('bench', raw);
    const blockId = await store.writeRecord(doc, { compressionDefaults: { content: algorithm } });
    blockIds.push(blockId);
  }
  const writeMs = performance.now() - writeStart;

  let totalPayloadBytes = 0;
  let contentPayloadBytes = 0;

  const readStart = performance.now();
  for (const blockId of blockIds) {
    const decoded = await store.readRecord(blockId);
    if (!decoded) throw new Error(`Missing decoded record for block ${blockId}`);

    const encoded = await store.readRecordEncoded(blockId);
    if (!encoded) throw new Error(`Missing encoded record for block ${blockId}`);

    for (const entry of encoded.iterableEntries) {
      totalPayloadBytes += Buffer.from(entry.payloadBase64, 'base64').length;
    }
    for (const entry of encoded.nonIterableEntries) {
      totalPayloadBytes += Buffer.from(entry.payloadBase64, 'base64').length;
    }

    const contentEntry = getContentEncodedEntry(encoded);
    contentPayloadBytes += Buffer.from(contentEntry.payloadBase64, 'base64').length;
  }
  const readMs = performance.now() - readStart;

  await freeBlockFile.close();

  return {
    scenario,
    algorithm,
    writeMs,
    readMs,
    totalPayloadBytes,
    contentPayloadBytes,
  };
}

function pctChange(base: number, compared: number): string {
  const delta = ((compared - base) / base) * 100;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%`;
}

function printPair(noneResult: BenchResult, gzipResult: BenchResult): void {
  const totalSaved = noneResult.totalPayloadBytes - gzipResult.totalPayloadBytes;
  const contentSaved = noneResult.contentPayloadBytes - gzipResult.contentPayloadBytes;

  console.log(`\nScenario: ${noneResult.scenario}`);
  console.log(`  none   -> write ${noneResult.writeMs.toFixed(2)} ms | read ${noneResult.readMs.toFixed(2)} ms`);
  console.log(`            total payload: ${noneResult.totalPayloadBytes.toLocaleString()} bytes`);
  console.log(`            content bytes: ${noneResult.contentPayloadBytes.toLocaleString()} bytes`);
  console.log(`  gzip   -> write ${gzipResult.writeMs.toFixed(2)} ms | read ${gzipResult.readMs.toFixed(2)} ms`);
  console.log(
    `            total payload: ${gzipResult.totalPayloadBytes.toLocaleString()} bytes (${pctChange(noneResult.totalPayloadBytes, gzipResult.totalPayloadBytes)})`,
  );
  console.log(
    `            content bytes: ${gzipResult.contentPayloadBytes.toLocaleString()} bytes (${pctChange(noneResult.contentPayloadBytes, gzipResult.contentPayloadBytes)})`,
  );
  console.log(`  saved  -> total ${totalSaved.toLocaleString()} bytes | content ${contentSaved.toLocaleString()} bytes`);
}

async function main(): Promise<void> {
  const cfg = parseArgs();
  console.log(`Compression benchmark (docs=${cfg.docs}, content-size=${cfg.size} bytes)`);

  const scenarios: ScenarioName[] = ['highly-compressible', 'mixed', 'low-compressible'];

  for (const scenario of scenarios) {
    const docs = buildDocuments(scenario, cfg.docs, cfg.size);
    const noneResult = await runScenario(scenario, 'none', docs);
    const gzipResult = await runScenario(scenario, 'gzip', docs);
    printPair(noneResult, gzipResult);
  }
}

main().catch((error: unknown) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
