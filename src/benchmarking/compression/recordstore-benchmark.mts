/**
 * Adapted from feature/compression's record-store benchmark.
 * Compare all current codecs using the same deterministic inputs and 4 KiB blocks.
 * Write timing covers encoding and staged writes; commit timing is reported separately.
 * Read timing covers decoding, without the encoded-size accounting pass.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { AtomicFile } from '../../atomic/atomicfile.mjs';
import { MockFile } from '../../core/mockfile.mjs';
import { COMPRESSION_ALGORITHMS, type CompressionAlgorithm } from '../../dbms/compression.mjs';
import { parseRawDocument, type Document } from '../../dbms/document.mjs';
import { RecordStore } from '../../dbms/recordstore.mjs';
import { FreeBlockFile } from '../../freeblockfile/freeblockfile.mjs';

type Scenario = 'highly-compressible' | 'mixed' | 'low-compressible';
type Config = { docs: number; size: number; seed: number };
type Result = {
  scenario: Scenario;
  algorithm: CompressionAlgorithm;
  writeMs: number;
  commitMs: number;
  readMs: number;
  contentPayloadBytes: number;
  fileBytes: number;
};

function parseArgs(args: string[]): Config {
  const config: Config = { docs: 1000, size: 4096, seed: 42 };
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (flag !== '--docs' && flag !== '--size' && flag !== '--seed') throw new Error(`Unknown option: ${flag}`);
    const value = Number(args[i + 1]);
    if (!Number.isSafeInteger(value) || value < (flag === '--seed' ? 0 : 1)) {
      throw new Error(`${flag} requires ${flag === '--seed' ? 'a nonnegative' : 'a positive'} integer`);
    }
    config[flag.slice(2) as keyof Config] = value;
  }
  return config;
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function buildDocuments(scenario: Scenario, config: Config): Document[] {
  const random = makeRandom(config.seed);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  return Array.from({ length: config.docs }, (_, i) => {
    const repeated = `record-${i} database compression benchmark `;
    const repeatText = repeated.repeat(Math.ceil(config.size / repeated.length)).slice(0, config.size);
    const randomText = Array.from({ length: config.size }, () => alphabet[Math.floor(random() * alphabet.length)]).join(
      '',
    );
    const content =
      scenario === 'highly-compressible'
        ? repeatText
        : scenario === 'mixed'
          ? repeatText.slice(0, Math.floor(config.size / 2)) + randomText.slice(Math.floor(config.size / 2))
          : randomText;
    return parseRawDocument('bench', { id: `${scenario}-${i}`, content, group: i % 10 });
  });
}

async function runScenario(scenario: Scenario, algorithm: CompressionAlgorithm, docs: Document[]): Promise<Result> {
  const data = new MockFile(4096);
  const log = new MockFile(4096);
  const blocks = new FreeBlockFile(new AtomicFile(data, log), 4096);
  await blocks.create();
  try {
    const store = new RecordStore(blocks);
    const pointers: number[] = [];
    const writeStart = performance.now();
    for (const doc of docs) {
      pointers.push(await store.writeRecord(doc, { compressionDefaults: { content: algorithm } }));
    }
    const writeMs = performance.now() - writeStart;
    const commitStart = performance.now();
    await blocks.commit();
    const commitMs = performance.now() - commitStart;

    const decoded: Array<Document | null> = [];
    const readStart = performance.now();
    for (const pointer of pointers) decoded.push(await store.readRecord(pointer));
    const readMs = performance.now() - readStart;

    let contentPayloadBytes = 0;
    for (let i = 0; i < pointers.length; i++) {
      const actual = decoded[i];
      assert(actual, 'Missing decoded record');
      assert.equal(actual.getId(), docs[i].getId());
      assert.deepEqual(actual.getFields(), docs[i].getFields());
      const encoded = await store.readRecordEncoded(pointers[i]);
      assert(encoded, 'Missing encoded record');
      const content = encoded.iterableEntries.find((entry) => entry.key === 'content');
      assert(content, 'Missing content field');
      contentPayloadBytes += Buffer.from(content.payloadBase64, 'base64').length;
    }
    return { scenario, algorithm, writeMs, commitMs, readMs, contentPayloadBytes, fileBytes: (await data.stat()).size };
  } finally {
    await blocks.close();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Usage: npm run benchmark:compression -- [--docs N] [--size N] [--seed N]');
    return;
  }
  const config = parseArgs(process.argv.slice(2));
  console.log(
    `Record-store codec benchmark: ${config.docs} documents, ${config.size} content bytes, seed ${config.seed}`,
  );
  console.log('MockFile storage; timings measure CPU and staged I/O, not physical disk durability.');
  for (const scenario of ['highly-compressible', 'mixed', 'low-compressible'] as const) {
    const docs = buildDocuments(scenario, config);
    const results: Result[] = [];
    for (const algorithm of COMPRESSION_ALGORITHMS) results.push(await runScenario(scenario, algorithm, docs));
    const baseline = results[0];
    console.table(
      results.map((result) => ({
        scenario,
        codec: result.algorithm,
        writeMs: Number(result.writeMs.toFixed(2)),
        commitMs: Number(result.commitMs.toFixed(2)),
        readMs: Number(result.readMs.toFixed(2)),
        contentBytes: result.contentPayloadBytes,
        fileBytes: result.fileBytes,
        savedPercent: Number(((1 - result.fileBytes / baseline.fileBytes) * 100).toFixed(2)),
      })),
    );
  }
}

main().catch((error: unknown) => {
  console.error('Compression benchmark failed:', error);
  process.exitCode = 1;
});
