// @author: Alec Van Vlerken
// @date: 2026-05-08

import { main as runOverhead } from './compaction-overhead-benchmark.mjs';
import { main as runPerformance } from './performance-benchmark.mjs';
import { runIfMain } from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  await runPerformance();
  await runOverhead();
}

runIfMain(import.meta.url, main);
