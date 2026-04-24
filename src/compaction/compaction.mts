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
import type { VacuumOptions, VacuumResult } from './vacuumtypes.mjs';

export type { VacuumOptions, VacuumResult, VacuumProgress } from './vacuumtypes.mjs';

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
