// @author: Alec Van Vlerken
// @date: 2026-05-08

import { main as runMixedDurability } from './mixed-durability-benchmark.mjs';
import { runIfMain } from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  await runMixedDurability();
}

runIfMain(import.meta.url, main);
