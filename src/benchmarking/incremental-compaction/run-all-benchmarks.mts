// @author: Alec Van Vlerken
// @date: 2026-05-07

import { main as runAdversarial } from './adversarial/run-adversarial-benchmarks.mjs';
import { main as runConsistency } from './consistency/run-consistency-benchmarks.mjs';
import { main as runCore } from './core/run-core-benchmarks.mjs';
import { main as runDurability } from './durability/run-durability-benchmarks.mjs';
import { main as runMaintenance } from './maintenance/run-maintenance-benchmarks.mjs';
import { main as runPerformance } from './performance/run-performance-benchmarks.mjs';
import { main as runRelocation } from './relocation/run-relocation-benchmarks.mjs';
import { runIfMain } from './shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  await runCore();
  await runRelocation();
  await runConsistency();
  await runDurability();
  await runMaintenance();
  await runPerformance();
  await runAdversarial();
}

runIfMain(import.meta.url, main);
