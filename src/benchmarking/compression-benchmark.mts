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
type PayloadKind = 'text' | 'image';

type BenchConfig = {
  docs: number;
  size: number;
};

type BenchmarkCase = {
  raw: Record<string, unknown>;
  originalPayload: string | Buffer;
};

type BenchResult = {
  payloadKind: PayloadKind;
  scenario: ScenarioName;
  algorithm: CompressionAlgorithm;
  compressionMs: number;
  decompressionMs: number;
  rawBytes: number;
  storedBytes: number;
  totalStoredBytes: number;
  lossless: boolean;
  lostBytes: number;
  effectiveCompression: Record<CompressionAlgorithm, number>;
};

const ALGORITHMS: CompressionAlgorithm[] = ['none', 'gzip', 'deflate'];
const SCENARIOS: ScenarioName[] = ['highly-compressible', 'mixed', 'low-compressible'];
const PAYLOAD_KINDS: PayloadKind[] = ['text', 'image'];
const FIELD_BY_KIND: Record<PayloadKind, string> = {
  text: 'content',
  image: 'image.jpeg',
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
  return randomBytes(Math.ceil(size / 2))
    .toString('hex')
    .slice(0, size);
}

function makeCompressibleImage(index: number, size: number): Buffer {
  const pattern = Buffer.from(`synthetic-image-block-${index % 16}-`);
  const chunks: Buffer[] = [];
  let remaining = size;

  while (remaining > 0) {
    const chunk = pattern.subarray(0, Math.min(pattern.length, remaining));
    chunks.push(chunk);
    remaining -= chunk.length;
  }

  return Buffer.concat(chunks, size);
}

function makeMixedImage(index: number, size: number): Buffer {
  const payload = Buffer.alloc(size);
  const marker = Buffer.from(`JPEG-LIKE-${index}-`);
  let offset = 0;

  while (offset < size) {
    const repeated = marker.subarray(0, Math.min(marker.length, size - offset));
    repeated.copy(payload, offset);
    offset += repeated.length;

    if (offset >= size) break;
    const randomLength = Math.min(32, size - offset);
    randomBytes(randomLength).copy(payload, offset);
    offset += randomLength;
  }

  return payload;
}

function makeLowCompressibleImage(size: number): Buffer {
  return randomBytes(size);
}

function buildBenchmarkCases(
  payloadKind: PayloadKind,
  scenario: ScenarioName,
  docs: number,
  size: number,
): BenchmarkCase[] {
  const result: BenchmarkCase[] = [];
  const fieldName = FIELD_BY_KIND[payloadKind];

  for (let i = 0; i < docs; i++) {
    let originalPayload: string | Buffer;
    if (payloadKind === 'text') {
      if (scenario === 'highly-compressible') {
        originalPayload = makeCompressibleText(i, size);
      } else if (scenario === 'mixed') {
        originalPayload = makeMixedText(i, size);
      } else {
        originalPayload = makeLowCompressibleText(size);
      }
    } else {
      if (scenario === 'highly-compressible') {
        originalPayload = makeCompressibleImage(i, size);
      } else if (scenario === 'mixed') {
        originalPayload = makeMixedImage(i, size);
      } else {
        originalPayload = makeLowCompressibleImage(size);
      }
    }

    const fieldValue = Buffer.isBuffer(originalPayload) ? originalPayload.toString('base64') : originalPayload;
    result.push({
      raw: {
        id: `${payloadKind}-${scenario}-${i}`,
        [fieldName]: fieldValue,
        group: i % 10,
      },
      originalPayload,
    });
  }

  return result;
}

function getEncodedEntry(
  encoded: EncodedDocument,
  fieldName: string,
): { compression: CompressionAlgorithm; payloadBase64: string } {
  const entry = [...encoded.iterableEntries, ...encoded.nonIterableEntries].find((field) => field.key === fieldName);
  if (!entry) throw new Error(`Expected ${fieldName} field in encoded document`);
  return entry;
}

function payloadToBuffer(payload: string | Buffer): Buffer {
  return Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf-8');
}

function fieldPayloadToBuffer(fieldName: string, value: unknown): Buffer {
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    return payloadToBuffer(value);
  }

  throw new Error(`Decoded field ${fieldName} is not a string or Buffer`);
}

function countLostBytes(expected: Buffer, actual: Buffer): number {
  const sharedLength = Math.min(expected.length, actual.length);
  let changedBytes = Math.abs(expected.length - actual.length);

  for (let i = 0; i < sharedLength; i++) {
    if (expected[i] !== actual[i]) changedBytes++;
  }

  return changedBytes;
}

function emptyEffectiveCompressionCounts(): Record<CompressionAlgorithm, number> {
  return {
    none: 0,
    gzip: 0,
    deflate: 0,
  };
}

async function runScenario(
  payloadKind: PayloadKind,
  scenario: ScenarioName,
  algorithm: CompressionAlgorithm,
  cases: BenchmarkCase[],
): Promise<BenchResult> {
  const dataFile = new MockFile(512 * 1024 * 1024);
  const logFile = new MockFile(512 * 1024 * 1024);
  const atomicFile = new AtomicFile(dataFile, logFile);
  const freeBlockFile = new FreeBlockFile(atomicFile, 4096);
  await freeBlockFile.create();

  const store = new RecordStore(freeBlockFile);
  const blockIds: number[] = [];
  const fieldName = FIELD_BY_KIND[payloadKind];

  const writeStart = performance.now();
  for (const benchCase of cases) {
    const doc = parseRawDocument('bench', benchCase.raw);
    const blockId = await store.writeRecord(doc, { compressionDefaults: { [fieldName]: algorithm } });
    blockIds.push(blockId);
  }
  const compressionMs = performance.now() - writeStart;

  let totalStoredBytes = 0;
  let storedBytes = 0;
  let rawBytes = 0;
  let lostBytes = 0;
  const effectiveCompression = emptyEffectiveCompressionCounts();

  const readStart = performance.now();
  for (let i = 0; i < blockIds.length; i++) {
    const blockId = blockIds[i];
    const benchCase = cases[i];
    const decoded = await store.readRecord(blockId);
    if (!decoded) throw new Error(`Missing decoded record for block ${blockId}`);

    const encoded = await store.readRecordEncoded(blockId);
    if (!encoded) throw new Error(`Missing encoded record for block ${blockId}`);

    for (const entry of encoded.iterableEntries) {
      totalStoredBytes += Buffer.from(entry.payloadBase64, 'base64').length;
    }
    for (const entry of encoded.nonIterableEntries) {
      totalStoredBytes += Buffer.from(entry.payloadBase64, 'base64').length;
    }

    const payloadEntry = getEncodedEntry(encoded, fieldName);
    storedBytes += Buffer.from(payloadEntry.payloadBase64, 'base64').length;
    effectiveCompression[payloadEntry.compression]++;

    const expected = payloadToBuffer(benchCase.originalPayload);
    const actualValue = decoded.getFields()[fieldName];
    if (actualValue === undefined) throw new Error(`Missing decoded field ${fieldName}`);
    const actual = fieldPayloadToBuffer(fieldName, actualValue);

    rawBytes += expected.length;
    lostBytes += countLostBytes(expected, actual);
  }
  const decompressionMs = performance.now() - readStart;

  await freeBlockFile.close();

  return {
    payloadKind,
    scenario,
    algorithm,
    compressionMs,
    decompressionMs,
    rawBytes,
    storedBytes,
    totalStoredBytes,
    lossless: lostBytes === 0,
    lostBytes,
    effectiveCompression,
  };
}

function pctSaved(base: number, compared: number): string {
  if (base === 0) return '0.00%';
  const delta = ((base - compared) / base) * 100;
  return `${delta.toFixed(2)}%`;
}

function formatEffectiveCompression(counts: Record<CompressionAlgorithm, number>): string {
  return ALGORITHMS.map((algorithm) => `${algorithm}=${counts[algorithm]}`).join(', ');
}

function printScenarioResults(results: BenchResult[]): void {
  const baseline = results.find((result) => result.algorithm === 'none');
  if (!baseline) throw new Error('Missing none baseline result');

  console.log(`\nScenario: ${baseline.scenario}`);
  for (const result of results) {
    const savedBytes = baseline.storedBytes - result.storedBytes;
    const savedSign = savedBytes >= 0 ? '' : '-';
    const savedAbs = Math.abs(savedBytes);

    console.log(
      `  ${result.algorithm.padEnd(7)} -> compression ${result.compressionMs.toFixed(2)} ms | decompression ${result.decompressionMs.toFixed(2)} ms`,
    );
    console.log(
      `             raw: ${result.rawBytes.toLocaleString()} bytes | stored: ${result.storedBytes.toLocaleString()} bytes | saved: ${savedSign}${savedAbs.toLocaleString()} bytes (${pctSaved(baseline.storedBytes, result.storedBytes)})`,
    );
    console.log(
      `             total stored payload: ${result.totalStoredBytes.toLocaleString()} bytes | lossless: ${result.lossless ? 'yes' : 'no'} | lost bytes: ${result.lostBytes.toLocaleString()}`,
    );
    console.log(`             effective compression: ${formatEffectiveCompression(result.effectiveCompression)}`);
  }
}

async function main(): Promise<void> {
  const cfg = parseArgs();
  console.log(`Compression benchmark (docs=${cfg.docs}, payload-size=${cfg.size} bytes)`);
  console.log(
    'Timing note: compression includes RecordStore serialization/write path; decompression includes read/decode path.',
  );

  for (const payloadKind of PAYLOAD_KINDS) {
    console.log(`\nPayload kind: ${payloadKind} (${FIELD_BY_KIND[payloadKind]})`);

    for (const scenario of SCENARIOS) {
      const cases = buildBenchmarkCases(payloadKind, scenario, cfg.docs, cfg.size);
      const results: BenchResult[] = [];
      for (const algorithm of ALGORITHMS) {
        results.push(await runScenario(payloadKind, scenario, algorithm, cases));
      }
      printScenarioResults(results);
    }
  }
}

main().catch((error: unknown) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
