// @author: Alec Van Vlerken
// @date: 2026-05-08

import { main as runHnswSemanticEquivalence } from './hnsw-semantic-equivalence-benchmark.mjs';
import { main as runRecordBtreeReference } from './record-btree-reference-benchmark.mjs';
import { main as runRecordHnswReference } from './record-hnsw-reference-benchmark.mjs';
import { runIfMain } from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  await runRecordBtreeReference();
  await runRecordHnswReference();
  await runHnswSemanticEquivalence();
}

runIfMain(import.meta.url, main);
