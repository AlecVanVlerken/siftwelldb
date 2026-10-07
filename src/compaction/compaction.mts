// @author: Alec Van Vlerken
// @date: 2026-04-21

/**
 * compaction.mts
 * -------------------------
 * This module implements the public façade for full vacuum compaction,
 * incremental compaction, block relocation, and tail reclamation.
 *
 * Runtime callers use this entry point. Tests and benchmarks may import
 * the implementation modules directly.
 *
 * It exposes the compaction operations and their public types.
 *
 * This file intentionally stays small and stable.
 * It does not contain:
 *   • large copy logic
 *   • validation logic
 *   • collection iteration details
 *
 * Those responsibilities belong to vacuum/, incremental/, and relocation/.
 */

import { VacuumService } from './vacuum/vacuumservice.mjs';
import { RecordRelocator } from './relocation/recordrelocator.mjs';
import { BtreeRelocator } from './relocation/btreerelocator.mjs';
import { HnswRelocator } from './relocation/hnswrelocator.mjs';
import { TailReclaimer } from './relocation/tailreclaimer.mjs';
import { CompactionPolicy } from './incremental/compactionpolicy.mjs';
import { CompactionState } from './incremental/compactionstate.mjs';
import { IncrementalCompactionService } from './incremental/incrementalservice.mjs';
import { IncrementalPlanner } from './incremental/incrementalplanner.mjs';
import type { VacuumOptions, VacuumResult } from './vacuum/vacuumtypes.mjs';
import type { DbmsBack } from '../database/dbmsback.mjs';
import type {
  BtreeRelocationTarget,
  HnswRelocationTarget,
  IncrementalCompactionPolicy,
  IncrementalCompactionResult,
  RecordRelocationTarget,
  RelocationBatch,
} from './incremental/incrementaltypes.mjs';

export type { VacuumOptions, VacuumResult, VacuumProgress } from './vacuum/vacuumtypes.mjs';
export type {
  BtreeRelocationTarget,
  HnswRelocationTarget,
  IncrementalCompactionMetrics,
  IncrementalCompactionPolicy,
  IncrementalCompactionResult,
  RecordRelocationTarget,
  RelocationBatch,
  RelocationKind,
  RelocationTarget,
} from './incremental/incrementaltypes.mjs';

/**
 * Rebuilds a source database into fresh target files using the vacuum
 * compaction pipeline.
 *
 * This is the public entry point of the compaction subsystem.
 *
 * The operation:
 *   • validates preconditions
 *   • commits the source database
 *   • creates a fresh target database
 *   • copies all logical collections and documents
 *   • commits the target database
 *   • optionally validates the rebuilt result
 *
 * The returned target database is the compacted database backend.
 * File replacement or swap is intentionally left to a higher layer.
 *
 * @param {VacuumOptions} options - Vacuum operation options.
 * @returns {Promise<VacuumResult>} Summary of the completed vacuum operation.
 *
 * @throws {Error} If preconditions, copy, commit, or validation fail.
 *
 * @author Alec Van Vlerken
 */
export async function vacuumCompactInto(options: VacuumOptions): Promise<VacuumResult> {
  const service = new VacuumService(options);
  return await service.run();
}

/**
 * Relocate selected RecordStore document chains inside one database.
 *
 * This is the first incremental compaction entry point. It does not choose
 * targets automatically yet; callers pass explicit logical documents and the
 * backend updates all DBMS-level references for each relocated record chain.
 *
 * @param source - Database backend containing the documents.
 * @param targets - Logical documents to relocate.
 * @returns Number of documents relocated.
 */
export async function relocateRecords(
  source: DbmsBack,
  targets: RecordRelocationTarget[],
): Promise<IncrementalCompactionResult> {
  const relocator = new RecordRelocator(source);
  return await relocator.relocate(targets);
}

/**
 * Relocate selected B+ tree nodes inside one database.
 *
 * @param source - Database backend containing the B+ tree indexes.
 * @param targets - B+ tree nodes to relocate.
 * @returns Number of B+ tree nodes relocated.
 */
export async function relocateBtreeNodes(
  source: DbmsBack,
  targets: BtreeRelocationTarget[],
): Promise<IncrementalCompactionResult> {
  const relocator = new BtreeRelocator(source);
  return await relocator.relocate(targets);
}

/**
 * Relocate selected HNSW graph/vector units inside one database.
 *
 * @param source - Database backend containing the HNSW indexes.
 * @param targets - HNSW graph/vector units to relocate.
 * @returns Number of HNSW units relocated.
 */
export async function relocateHnswUnits(
  source: DbmsBack,
  targets: HnswRelocationTarget[],
): Promise<IncrementalCompactionResult> {
  const relocator = new HnswRelocator(source);
  return await relocator.relocate(targets);
}

/**
 * Physically trim a fully free suffix from the database file.
 *
 * @param source - Database backend whose storage tail should be reclaimed.
 * @returns Number of physical blocks removed from the file tail.
 */
export async function reclaimFreeTail(source: DbmsBack): Promise<number> {
  const reclaimer = new TailReclaimer(source);
  return await reclaimer.reclaim();
}

/**
 * Plan one bounded incremental compaction batch without executing it.
 */
export async function planIncrementalCompactionStep(
  source: DbmsBack,
  policy?: IncrementalCompactionPolicy,
): Promise<RelocationBatch | null> {
  const planner = new IncrementalPlanner(source, new CompactionPolicy(policy), new CompactionState());
  return await planner.plan();
}

/**
 * Execute one bounded incremental compaction step.
 */
export async function runIncrementalCompactionStep(
  source: DbmsBack,
  policy?: IncrementalCompactionPolicy,
): Promise<IncrementalCompactionResult> {
  const service = new IncrementalCompactionService(source, policy);
  return await service.runStep();
}

/**
 * Execute repeated bounded incremental steps until the K target is satisfied,
 * no safe progress is available, or the policy's maxStepsPerRun budget is hit.
 */
export async function runIncrementalCompactionUntilTarget(
  source: DbmsBack,
  policy?: IncrementalCompactionPolicy,
): Promise<IncrementalCompactionResult> {
  const service = new IncrementalCompactionService(source, policy);
  return await service.runUntilTarget();
}
