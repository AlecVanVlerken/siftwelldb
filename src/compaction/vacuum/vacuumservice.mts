// @author: Alec Van Vlerken
// @date: 2026-04-22

/**
 * vacuumservice.mts
 * -------------------------
 * This module implements the orchestration logic of the vacuum
 * compaction subsystem.
 *
 * The vacuum workflow is executed in the following order:
 *   • preflight checks
 *   • source stabilization through commit
 *   • target database creation
 *   • collection catalog creation
 *   • logical data copy
 *   • target commit
 *   • optional validation
 *   • final result creation
 *
 * This module provides:
 *   • run() — execute one full logical vacuum compaction
 *
 * Additionally, internal helpers exist:
 *   • assertPreconditions() — validate the operation before it starts
 *   • createTarget()        — create the fresh compacted target backend
 *   • reportProgress()      — emit progress events when configured
 *
 * The service does not perform in-place block remapping.
 * Instead, it rebuilds the database logically into fresh target files using
 * the normal DBMS APIs.
 */

import { DbmsBack } from '../../database/dbmsback.mjs';
import type { HnswConfig } from '../../database/dbmsback.mjs';
import { CollectionCatalog } from './collectioncatalog.mjs';
import { DatabaseCopier } from './databasecopier.mjs';
import { VacuumValidator } from './vacuumvalidator.mjs';
import type { VacuumOptions, VacuumProgress, VacuumResult } from './vacuumtypes.mjs';

/**
 * Coordinates one full logical vacuum compaction operation.
 */
export class VacuumService {
  /**
   * Creates a new VacuumService.
   *
   * @param {VacuumOptions} options - Vacuum operation options.
   *
   * @author Alec Van Vlerken
   */
  constructor(private readonly options: VacuumOptions) {}

  /**
   * Runs the full vacuum workflow.
   *
   * The workflow is:
   *   • perform preflight checks
   *   • commit the source database
   *   • create the target database
   *   • build the collection catalog
   *   • copy logical data
   *   • commit the target database
   *   • validate the rebuilt target when enabled
   *   • return the vacuum result
   *
   * @returns {Promise<VacuumResult>} Summary of the completed vacuum operation.
   *
   * @throws {Error} If preconditions fail or if copy or validation fails.
   *
   * @author Alec Van Vlerken
   */
  async run(): Promise<VacuumResult> {
    const { source, validate = true } = this.options;

    this.reportProgress({ phase: 'preflight' });
    this.assertPreconditions();

    await source.commit();

    this.reportProgress({ phase: 'create-target' });
    const target = await this.createTarget();

    const catalog = new CollectionCatalog(source);

    const copier = new DatabaseCopier(source, target, catalog, this.options.onProgress);

    const copyResult = await copier.copyAll();

    this.reportProgress({ phase: 'commit-target' });
    await target.commit();

    let validated = false;
    if (validate) {
      this.reportProgress({ phase: 'validate' });

      const validator = new VacuumValidator(source, target, catalog);
      await validator.validate();

      validated = true;
    }

    this.reportProgress({ phase: 'done' });

    return {
      target,
      collectionsCopied: copyResult.collectionsCopied,
      documentsCopied: copyResult.documentsCopied,
      validated,
    };
  }

  /**
   * Performs the preflight checks required before vacuum may start.
   *
   * Current checks:
   *   • source database backend must exist
   *   • temp files must not be the same objects as the source files
   *   • HNSW rebuild must be possible when HNSW-backed collections exist
   *
   * @returns {void}
   *
   * @throws {Error} If any precondition fails.
   *
   * @author Alec Van Vlerken
   */
  private assertPreconditions(): void {
    const { source, tempDataFile, tempLogFile, rebuildHnsw = true } = this.options;

    if (!source) {
      throw new Error('Vacuum preflight failed: source database backend is missing.');
    }

    if (source.getVacuumDataFile() === tempDataFile) {
      throw new Error(
        'Vacuum preflight failed: temporary data file must not be the same object as the source data file.',
      );
    }

    if (source.getVacuumLogFile() === tempLogFile) {
      throw new Error(
        'Vacuum preflight failed: temporary log file must not be the same object as the source log file.',
      );
    }

    const catalog = new CollectionCatalog(source);
    const hasAnyHnswCollections = catalog.hasAnyHnswCollections();
    const hnswConfig = source.getVacuumHnswConfig();

    if (hasAnyHnswCollections && !rebuildHnsw) {
      throw new Error(
        'Vacuum preflight failed: source database contains HNSW-backed collections, ' +
          'but HNSW rebuilding was disabled.',
      );
    }

    if (hasAnyHnswCollections && !hnswConfig) {
      throw new Error(
        'Vacuum preflight failed: source database contains HNSW-backed collections, ' +
          'but no HNSW runtime configuration is available to rebuild them.',
      );
    }
  }

  /**
   * Creates a fresh target database backend using the temporary files from
   * the vacuum options.
   *
   * The target is created with the same HNSW runtime configuration as the
   * source database so semantic indexes can be rebuilt during document
   * reinsertion.
   *
   * @returns {Promise<DbmsBack>} Newly created target backend.
   *
   * @author Alec Van Vlerken
   */
  private async createTarget(): Promise<DbmsBack> {
    const { tempDataFile, tempLogFile, source } = this.options;
    const hnswConfig: HnswConfig | undefined = source.getVacuumHnswConfig();

    const target = new DbmsBack(tempDataFile, tempLogFile, hnswConfig);
    await target.create();

    return target;
  }

  /**
   * Emits a progress event if a progress callback was provided.
   *
   * @param {VacuumProgress} progress - Progress event to emit.
   * @returns {void}
   *
   * @author Alec Van Vlerken
   */
  private reportProgress(progress: VacuumProgress): void {
    this.options.onProgress?.(progress);
  }
}
