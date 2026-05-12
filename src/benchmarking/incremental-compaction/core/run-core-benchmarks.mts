// @author: Alec Van Vlerken
// @date: 2026-05-08

import { main as runHeavyDelete } from './heavy-delete-benchmark.mjs';
import { main as runKConvergence } from './k-convergence-benchmark.mjs';
import { main as runMixedChurn } from './mixed-churn-benchmark.mjs';
import { main as runMixedTailBlockers } from './mixed-tail-blockers-benchmark.mjs';
import { runIfMain } from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  await runKConvergence();
  await runHeavyDelete();
  await runMixedChurn();
  await runMixedTailBlockers();
}

runIfMain(import.meta.url, main);
