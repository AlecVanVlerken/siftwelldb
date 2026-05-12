// @author: Alec Van Vlerken
// @date: 2026-05-08

import { main as runBoundedIdle } from './bounded-idle-benchmark.mjs';
import { main as runLongRunIdleMaintenance } from './long-run-idle-maintenance-benchmark.mjs';
import { main as runMaintenanceStability } from './maintenance-stability-benchmark.mjs';
import { main as runNoopPlateau } from './noop-plateau-benchmark.mjs';
import { main as runPlateauFallback } from './plateau-fallback-benchmark.mjs';
import { main as runRollingChurn } from './rolling-churn-benchmark.mjs';
import { runIfMain } from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  await runNoopPlateau();
  await runBoundedIdle();
  await runLongRunIdleMaintenance();
  await runMaintenanceStability();
  await runRollingChurn();
  await runPlateauFallback();
}

runIfMain(import.meta.url, main);
