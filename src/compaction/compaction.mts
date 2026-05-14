// @author: Alec Van Vlerken
// @date: 2026-04-21

/**
 * compaction.mts
 * -------------------------
 * This module implements the public façade of the vacuum
 * compaction subsystem.
 *
 * This is the only compaction file that should be imported by the rest
 * of the project.
 *
 * This module provides:
 *   • vacuumCompactInto() — run one full vacuum compaction operation
 *
 * Additionally, it re-exports the public compaction types:
 *   • VacuumOptions
 *   • VacuumResult
 *   • VacuumProgress
 *
 * This file intentionally stays small and stable.
 * It does not contain:
 *   • large copy logic
 *   • validation logic
 *   • collection iteration details
 *
 * Those responsibilities belong to the internal compaction modules.
 */

import { VacuumService } from './vacuumservice.mjs';
import { RecordRelocator } from './recordrelocator.mjs';
import { BtreeRelocator } from './btreerelocator.mjs';
import { HnswRelocator } from './hnswrelocator.mjs';
import { TailReclaimer } from './tailreclaimer.mjs';
import { CompactionPolicy } from './compactionpolicy.mjs';
import { CompactionState } from './compactionstate.mjs';
import { IncrementalCompactionService } from './incrementalservice.mjs';
import { IncrementalPlanner } from './incrementalplanner.mjs';
import type { VacuumOptions, VacuumResult } from './vacuumtypes.mjs';
import type { DbmsBack } from '../dbms/dbmsback.mjs';
import type {
  BtreeRelocationTarget,
  HnswRelocationTarget,
  IncrementalCompactionPolicy,
  IncrementalCompactionResult,
  RecordRelocationTarget,
  RelocationBatch,
} from './incrementaltypes.mjs';

export type { VacuumOptions, VacuumResult, VacuumProgress } from './vacuumtypes.mjs';
export type {
  BtreeRelocationTarget,
  HnswRelocationTarget,
  HnswUnitCompactionState,
  IncrementalCompactionMetrics,
  IncrementalCompactionPolicy,
  IncrementalCompactionResult,
  RecordRelocationTarget,
  RelocationBatch,
  RelocationKind,
  RelocationTarget,
} from './incrementaltypes.mjs';

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
