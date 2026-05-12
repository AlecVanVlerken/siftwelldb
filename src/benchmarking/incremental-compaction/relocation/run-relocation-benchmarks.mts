// @author: Alec Van Vlerken
// @date: 2026-05-08

import { main as runBtree } from './btree-benchmark.mjs';
import { main as runBtreeDominant } from './btree-dominant-tail-blocker-benchmark.mjs';
import { main as runBtreeSequence } from './btree-tail-clear-sequence-benchmark.mjs';
import { main as runHnsw } from './hnsw-benchmark.mjs';
import { main as runHnswDominant } from './hnsw-dominant-tail-blocker-benchmark.mjs';
import { main as runHnswSequence } from './hnsw-tail-clear-sequence-benchmark.mjs';
import { main as runMixedMinimized } from './mixed-blockers-with-records-minimized-benchmark.mjs';
import { main as runOrderedMixed } from './ordered-mixed-tail-blockers-benchmark.mjs';
import { main as runRecordstore } from './recordstore-benchmark.mjs';
import { runIfMain } from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  await runRecordstore();
  await runBtree();
  await runBtreeDominant();
  await runBtreeSequence();
  await runHnsw();
  await runHnswDominant();
  await runHnswSequence();
  await runOrderedMixed();
  await runMixedMinimized();
}

runIfMain(import.meta.url, main);
