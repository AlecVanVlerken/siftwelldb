/**
 * Embedding speed micro-benchmark
 *
 * Measures average single-text encoding time across many models and dtypes
 * so you can choose the best model for HNSW insert overhead.
 *
 * Results are printed sorted by mean encoding time (fastest first).
 */

import { pipeline } from '@huggingface/transformers';
import { describe, it } from 'vitest';

import { MOCK_HNSW_DIMENSION, MOCK_HNSW_ENCODER_LABEL, mockEmbed } from './mock_encoder.mjs';

const SAMPLE_COUNT = 150;
const WARMUP_COUNT = 5;

type Candidate = {
  kind: 'huggingface' | 'mock';
  model: string;
  dtype: string;
};

const CANDIDATES: Candidate[] = [
  { kind: 'mock', model: MOCK_HNSW_ENCODER_LABEL, dtype: 'deterministic' },
  // ── MiniLM-L3 – 3-layer, very fast (384-dim) ────────────────────────────
  { kind: 'huggingface', model: 'Xenova/paraphrase-MiniLM-L3-v2', dtype: 'fp32' },
  { kind: 'huggingface', model: 'Xenova/paraphrase-MiniLM-L3-v2', dtype: 'q8' },
  // ── MiniLM-L6 (384-dim) ─────────────────────────────────────────────────
  { kind: 'huggingface', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'fp32' },
  { kind: 'huggingface', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' },
  { kind: 'huggingface', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q4' },
  // ── MiniLM-L6 Q&A variant (384-dim) ─────────────────────────────────────
  { kind: 'huggingface', model: 'Xenova/multi-qa-MiniLM-L6-cos-v1', dtype: 'fp32' },
  { kind: 'huggingface', model: 'Xenova/multi-qa-MiniLM-L6-cos-v1', dtype: 'q8' },
  { kind: 'huggingface', model: 'Xenova/multi-qa-MiniLM-L6-dot-v1', dtype: 'fp32' },
  { kind: 'huggingface', model: 'Xenova/multi-qa-MiniLM-L6-dot-v1', dtype: 'q8' },
  // ── MiniLM-L12 (384-dim) ────────────────────────────────────────────────
  { kind: 'huggingface', model: 'Xenova/all-MiniLM-L12-v2', dtype: 'fp32' },
  { kind: 'huggingface', model: 'Xenova/all-MiniLM-L12-v2', dtype: 'q8' },
  // ── AlBERT-small – shared-weight, very compact (768-dim) ─────────────────
  { kind: 'huggingface', model: 'Xenova/paraphrase-albert-small-v2', dtype: 'fp32' },
  { kind: 'huggingface', model: 'Xenova/paraphrase-albert-small-v2', dtype: 'q8' },
  // ── BGE-small (384-dim) ─────────────────────────────────────────────────
  { kind: 'huggingface', model: 'Xenova/bge-small-en-v1.5', dtype: 'fp32' },
  { kind: 'huggingface', model: 'Xenova/bge-small-en-v1.5', dtype: 'q8' },
  // ── E5-small (384-dim) ──────────────────────────────────────────────────
  { kind: 'huggingface', model: 'Xenova/e5-small-v2', dtype: 'fp32' },
  { kind: 'huggingface', model: 'Xenova/e5-small-v2', dtype: 'q8' },
  // ── GTE-small (384-dim) ─────────────────────────────────────────────────
  { kind: 'huggingface', model: 'Xenova/gte-small', dtype: 'fp32' },
  { kind: 'huggingface', model: 'Xenova/gte-small', dtype: 'q8' },
  // ── DistilBERT for retrieval (768-dim) ───────────────────────────────────
  { kind: 'huggingface', model: 'Xenova/msmarco-distilbert-base-tas-b', dtype: 'q8' },
  // ── DistilRoBERTa (768-dim) ─────────────────────────────────────────────
  { kind: 'huggingface', model: 'Xenova/all-distilroberta-v1', dtype: 'fp32' },
  { kind: 'huggingface', model: 'Xenova/all-distilroberta-v1', dtype: 'q8' },
  // ── BGE-base (768-dim) ──────────────────────────────────────────────────
  { kind: 'huggingface', model: 'Xenova/bge-base-en-v1.5', dtype: 'fp32' },
  { kind: 'huggingface', model: 'Xenova/bge-base-en-v1.5', dtype: 'q8' },
  // ── E5-base (768-dim) ───────────────────────────────────────────────────
  { kind: 'huggingface', model: 'Xenova/e5-base-v2', dtype: 'fp32' },
  { kind: 'huggingface', model: 'Xenova/e5-base-v2', dtype: 'q8' },
  // ── GTE-base (768-dim) ──────────────────────────────────────────────────
  { kind: 'huggingface', model: 'Xenova/gte-base', dtype: 'fp32' },
  { kind: 'huggingface', model: 'Xenova/gte-base', dtype: 'q8' },
  // ── MPNet-base (768-dim) ─────────────────────────────────────────────────
  { kind: 'huggingface', model: 'Xenova/all-mpnet-base-v2', dtype: 'q8' },
  // ── Multilingual MiniLM-L12 (384-dim) ───────────────────────────────────
  { kind: 'huggingface', model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', dtype: 'fp32' },
  { kind: 'huggingface', model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', dtype: 'q8' },
  // ── Multilingual E5-small (384-dim) ─────────────────────────────────────
  { kind: 'huggingface', model: 'Xenova/multilingual-e5-small', dtype: 'fp32' },
  { kind: 'huggingface', model: 'Xenova/multilingual-e5-small', dtype: 'q8' },
  // ── Nomic embed (768-dim, newer architecture) ───────────────────────────
  { kind: 'huggingface', model: 'nomic-ai/nomic-embed-text-v1.5', dtype: 'fp32' },
  { kind: 'huggingface', model: 'nomic-ai/nomic-embed-text-v1.5', dtype: 'q8' },
];

const SAMPLE_TEXTS = [
  'The quick brown fox jumps over the lazy dog.',
  'Machine learning models require large amounts of training data.',
  'A B+ tree is a self-balancing search tree with O(log n) operations.',
  'Semantic search finds documents by meaning rather than exact keywords.',
  'The HNSW algorithm builds a hierarchical graph of vector embeddings.',
  'Database indexing speeds up query execution at the cost of insert overhead.',
  'Natural language processing enables computers to understand human text.',
  'Vector similarity is commonly measured with cosine distance.',
  'Transformers use self-attention to model long-range dependencies.',
  'Write-ahead logging ensures durability in transactional databases.',
];

type Result = { label: string; mean: number; p50: number; p95: number; status: 'ok' | 'failed'; error?: string };

describe('Embedding model speed comparison', () => {
  it(
    `benchmarks ${String(CANDIDATES.length)} model/dtype combos (${SAMPLE_COUNT} samples each)`,
    async () => {
      const results: Result[] = [];

      for (const candidate of CANDIDATES) {
        const { model, dtype } = candidate;
        const label = `${model}  [${dtype}]`;
        process.stdout.write(`\nPreparing ${label}...\n`);

        try {
          let encode: (text: string) => Promise<unknown>;

          if (candidate.kind === 'mock') {
            encode = (text: string) => Promise.resolve(mockEmbed(text, MOCK_HNSW_DIMENSION));
          } else {
            const extractor = await pipeline('feature-extraction', model, { dtype });
            encode = (text: string) => extractor(text, { pooling: 'mean', normalize: true });
          }

          for (let i = 0; i < WARMUP_COUNT; i++) {
            await encode(SAMPLE_TEXTS[i % SAMPLE_TEXTS.length]);
          }

          const times: number[] = [];
          for (let i = 0; i < SAMPLE_COUNT; i++) {
            const text = SAMPLE_TEXTS[i % SAMPLE_TEXTS.length];
            const t0 = performance.now();
            await encode(text);
            times.push(performance.now() - t0);
          }

          times.sort((a, b) => a - b);
          const mean = times.reduce((s, v) => s + v, 0) / times.length;
          const p50 = times[Math.floor(times.length * 0.5)];
          const p95 = times[Math.floor(times.length * 0.95)];

          results.push({ label, mean, p50, p95, status: 'ok' });
          process.stdout.write(`  mean=${mean.toFixed(2)}ms  p50=${p50.toFixed(2)}ms  p95=${p95.toFixed(2)}ms\n`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          results.push({ label, mean: Infinity, p50: Infinity, p95: Infinity, status: 'failed', error: message });
          process.stdout.write(`  FAILED: ${message}\n`);
        }
      }

      // ── Summary table sorted by mean time ──────────────────────────────
      const ok = results.filter((r) => r.status === 'ok').sort((a, b) => a.mean - b.mean);
      const failed = results.filter((r) => r.status === 'failed');

      const labelWidth = Math.max(...ok.map((r) => r.label.length), 10);

      process.stdout.write('\n' + '═'.repeat(labelWidth + 40) + '\n');
      process.stdout.write('RESULTS — sorted fastest → slowest\n');
      process.stdout.write('═'.repeat(labelWidth + 40) + '\n');
      process.stdout.write(`${'Model [dtype]'.padEnd(labelWidth)}  mean(ms)   p50(ms)   p95(ms)\n`);
      process.stdout.write('─'.repeat(labelWidth + 40) + '\n');

      for (const r of ok) {
        process.stdout.write(
          `${r.label.padEnd(labelWidth)}  ${r.mean.toFixed(2).padStart(8)}  ${r.p50.toFixed(2).padStart(8)}  ${r.p95.toFixed(2).padStart(8)}\n`,
        );
      }

      if (failed.length > 0) {
        process.stdout.write('\nFailed to load:\n');
        for (const r of failed) {
          process.stdout.write(`  ✗ ${r.label}  — ${r.error ?? 'unknown error'}\n`);
        }
      }

      process.stdout.write('═'.repeat(labelWidth + 40) + '\n');
    },
    60 * 60 * 1000,
  );
});
