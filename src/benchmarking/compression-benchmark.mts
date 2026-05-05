// author: Frederik Caeyman
// date: 2026-03-08

import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';

import { MockFile } from '../core/mockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { parseRawDocument } from '../dbms/document.mjs';
import { RecordStore, type EncodedDocument } from '../dbms/recordstore.mjs';
import { COMPRESSION_ALGORITHMS, type CompressionAlgorithm } from '../dbms/compression.mjs';

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
  estimatedBlocks: number;
  estimatedAllocatedBytes: number;
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
  const bytes = randomBytes(size);
  let result = '';
  for (const byte of bytes) {
    result += String.fromCharCode(33 + (byte % 94));
  }
  return result;
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
  let estimatedBlocks = 0;
  let estimatedAllocatedBytes = 0;

  const writeStart = performance.now();
  for (const raw of docs) {
    const doc = parseRawDocument('bench', raw);
    const estimate = store.estimateRecordStorage(doc, { compressionDefaults: { content: algorithm } });
    estimatedBlocks += estimate.blocks;
    estimatedAllocatedBytes += estimate.allocatedBytes;
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
    estimatedBlocks,
    estimatedAllocatedBytes,
  };
}

function pctChange(base: number, compared: number): string {
  const delta = ((compared - base) / base) * 100;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%`;
}

function printScenario(noneResult: BenchResult, results: BenchResult[]): void {
  console.log(`\nScenario: ${noneResult.scenario}`);
  console.log(
    `  ${'algorithm'.padEnd(10)} ${'write'.padStart(10)} ${'read'.padStart(10)} ${'blocks'.padStart(10)} ${'total bytes'.padStart(16)} ${'content bytes'.padStart(16)} ${'content saved'.padStart(14)}`,
  );

  for (const result of results) {
    const contentSaved = noneResult.contentPayloadBytes - result.contentPayloadBytes;
    const contentSavedPercent =
      noneResult.contentPayloadBytes === 0 ? 0 : (contentSaved / noneResult.contentPayloadBytes) * 100;
    const blocksSaved = noneResult.estimatedBlocks - result.estimatedBlocks;
    console.log(
      `  ${result.algorithm.padEnd(10)} ${`${result.writeMs.toFixed(2)} ms`.padStart(10)} ${`${result.readMs.toFixed(2)} ms`.padStart(10)} ${`${result.estimatedBlocks.toLocaleString()} (${blocksSaved.toLocaleString()} saved)`.padStart(10)} ${`${result.totalPayloadBytes.toLocaleString()} (${pctChange(noneResult.totalPayloadBytes, result.totalPayloadBytes)})`.padStart(16)} ${`${result.contentPayloadBytes.toLocaleString()} (${pctChange(noneResult.contentPayloadBytes, result.contentPayloadBytes)})`.padStart(16)} ${`${contentSaved.toLocaleString()} B (${contentSavedPercent.toFixed(2)}%)`.padStart(14)}`,
    );
  }
}

async function main(): Promise<void> {
  const cfg = parseArgs();
  console.log(`Compression benchmark (docs=${cfg.docs}, content-size=${cfg.size} bytes)`);

  const scenarios: ScenarioName[] = ['highly-compressible', 'mixed', 'low-compressible'];

  for (const scenario of scenarios) {
    const docs = buildDocuments(scenario, cfg.docs, cfg.size);
    const results: BenchResult[] = [];
    for (const algorithm of COMPRESSION_ALGORITHMS) {
      results.push(await runScenario(scenario, algorithm, docs));
    }
    const noneResult = results.find((result) => result.algorithm === 'none');
    if (!noneResult) throw new Error('Missing none benchmark result');
    printScenario(noneResult, results);
  }
}

main().catch((error: unknown) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
