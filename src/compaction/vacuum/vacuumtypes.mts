// @author: Alec Van Vlerken
// @date: 2026-04-21

/**
 * vacuumtypes.mts
 * -------------------------
 * This module defines the shared types for the vacuum
 * compaction subsystem.
 *
 * These types keep function signatures clean and provide a stable public
 * API for the compaction layer.
 *
 * This module provides:
 *   • VacuumOptions          — input options for one vacuum operation
 *   • VacuumProgress         — progress event emitted during vacuum
 *   • VacuumResult           — result of a completed vacuum
 *
 * The vacuum process rebuilds a source database into fresh temporary files.
 * The source database is read logically and all live documents are copied
 * into a new target database through normal insertion flows.
 */

import type { File } from '../../storage/file.mjs';
import type { DbmsBack } from '../../database/dbmsback.mjs';

/**
 * Describes one vacuum compaction operation.
 *
 * A vacuum operation rebuilds the full logical contents of an existing source
 * database into a fresh target database stored in temporary files.
 *
 * Fields:
 *   • source       — open source database backend to compact
 *   • tempDataFile — fresh destination data file
 *   • tempLogFile  — fresh destination log file
 *   • validate     — whether the rebuilt target should be validated
 *   • rebuildHnsw  — whether HNSW indexes should be rebuilt
 *   • onProgress   — optional callback for progress reporting
 */
export type VacuumOptions = {
  source: DbmsBack;
  tempDataFile: File;
  tempLogFile: File;
  validate?: boolean;
  rebuildHnsw?: boolean;
  onProgress?: (progress: VacuumProgress) => void;
};

/**
 * Describes one progress event emitted by the vacuum subsystem.
 *
 * Fields:
 *   • phase           — current high-level phase of the vacuum operation
 *   • collection      — current collection, when applicable
 *   • copiedDocuments — documents copied within the current collection
 *   • totalDocuments  — live documents in the current collection
 *
 * Percentages describe only the active phase and collection. A completed
 * collection may report 100 while other collections or finalization remain.
 * `done` means the rebuilt target has passed the requested validation; file
 * replacement and reopening belong to the caller and are not included here.
 */
export type VacuumProgress = {
  phase: 'preflight' | 'commit-source' | 'create-target' | 'copy-collection' | 'commit-target' | 'validate' | 'done';
  collection?: string;
  copiedDocuments?: number;
  totalDocuments?: number;
  /** Actual work within this phase and collection, never an overall estimate. */
  processed?: number;
  total?: number;
  unit?: 'documents' | 'collections';
  /** Absent when a denominator is unavailable or zero. */
  percentage?: number;
};

/**
 * Describes the result of a completed vacuum compaction.
 *
 * Fields:
 *   • target            — newly created compacted database backend
 *   • collectionsCopied — total number of copied collections
 *   • documentsCopied   — total number of copied logical documents
 *   • validated         — whether validation was executed successfully
 */
export type VacuumResult = {
  target: DbmsBack;
  collectionsCopied: number;
  documentsCopied: number;
  validated: boolean;
};
