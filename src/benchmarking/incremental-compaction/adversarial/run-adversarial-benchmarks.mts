// @author: Alec Van Vlerken
// @date: 2026-05-08

import { main as runAdversarial } from './adversarial-benchmark.mjs';
import { runIfMain } from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  await runAdversarial();
}

runIfMain(import.meta.url, main);
