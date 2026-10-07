// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';

import { runIfMain } from '../shared/benchmark-utils.mjs';
import { runControlledMixedScenario } from './ordered-mixed-tail-blockers-benchmark.mjs';

export async function main(): Promise<void> {
  const result = await runControlledMixedScenario('mixed-blockers-records-minimized', {
    fillerBlocks: 90,
    treeEntries: 8,
    hnswEntries: 4,
    recordPayloadWords: 20,
    maxSteps: 18,
  });

  assert(result.relocatedDocuments <= result.relocatedBtreeNodes + result.relocatedHnswUnits);
}

runIfMain(import.meta.url, main);
