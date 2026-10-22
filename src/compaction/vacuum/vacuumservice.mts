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
import { fileIdentities, identitiesAlias } from '../../storage/fileidentity.mjs';

/** No source commit, output creation or destination cleanup has begun. */
export class VacuumPreflightError extends Error {}

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
  constructor(
    private readonly options: VacuumOptions,
    private readonly commitSource: () => Promise<void> = () => options.source.commit(),
  ) {}

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
    await this.assertPreconditions();

    this.reportProgress({ phase: 'commit-source' });
    await this.commitSource();

    this.reportProgress({ phase: 'create-target' });
    const target = await this.createTarget();

    try {
      const catalog = new CollectionCatalog(source);

      const copier = new DatabaseCopier(source, target, catalog, this.options.onProgress);

      const copyResult = await copier.copyAll();

      this.reportProgress({ phase: 'commit-target' });
      await target.commit();

      let validated = false;
      if (validate) {
        this.reportProgress({ phase: 'validate' });

        const validator = new VacuumValidator(source, target, catalog, this.options.onProgress);
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
    } catch (error) {
      // A failed copy must release native indexes and file handles without
      // committing or publishing the incomplete target.
      try {
        await target.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], 'Vacuum failed and its incomplete target could not be closed');
      }
      throw error;
    }
  }

  /**
   * Performs the preflight checks required before vacuum may start.
   *
   * Current checks:
   *   • source database backend must exist
   *   • all source and destination storage resources must be distinct
   *   • HNSW rebuild must be possible when HNSW-backed collections exist
   *
   * @returns {Promise<void>}
   *
   * @throws {Error} If any precondition fails.
   *
   * @author Alec Van Vlerken
   */
  private async assertPreconditions(): Promise<void> {
    const { source, tempDataFile, tempLogFile, rebuildHnsw = true } = this.options;

    if (!source) {
      throw new VacuumPreflightError('Vacuum preflight failed: source database backend is missing.');
    }

    const files = [source.getVacuumDataFile(), source.getVacuumLogFile(), tempDataFile, tempLogFile];
    const roles = ['source data file', 'source WAL file', 'destination data file', 'destination WAL file'];
    const rejectAlias = (a: number, b: number): never => {
      throw new VacuumPreflightError(`Vacuum preflight failed: ${roles[b]} aliases ${roles[a]}.`);
    };
    for (let b = 1; b < files.length; b++) for (let a = 0; a < b; a++) if (files[a] === files[b]) rejectAlias(a, b);
    const identities = await Promise.all(files.map(fileIdentities)).catch((error: unknown) => {
      throw new VacuumPreflightError(
        'Vacuum preflight failed: cannot establish file identities: ' +
          (error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    });
    for (let b = 1; b < files.length; b++)
      for (let a = 0; a < b; a++)
        if (identities[a].some((left) => identities[b].some((right) => identitiesAlias(left, right))))
          rejectAlias(a, b);

    const catalog = new CollectionCatalog(source);
    const hasAnyHnswCollections = catalog.hasAnyHnswCollections();
    const hnswConfig = source.getVacuumHnswConfig();

    if (hasAnyHnswCollections && !rebuildHnsw) {
      throw new VacuumPreflightError(
        'Vacuum preflight failed: source database contains HNSW-backed collections, ' +
          'but HNSW rebuilding was disabled.',
      );
    }

    if (hasAnyHnswCollections && !hnswConfig) {
      throw new VacuumPreflightError(
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
    try {
      await target.create();
    } catch (error) {
      await target.close().catch(() => undefined);
      throw error;
    }

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
