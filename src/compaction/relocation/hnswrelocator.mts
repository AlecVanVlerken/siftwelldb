// @author: Alec Van Vlerken
// @date: 2026-05-06

/**
 * HNSW relocation executor.
 *
 * The compaction subsystem owns batch orchestration; DbmsBack delegates each
 * targeted graph/vector move to the HNSW layer, where structural references
 * and in-memory index caches can be updated together.
 */

import type { DbmsBack } from '../../database/dbmsback.mjs';
import type { HnswRelocationTarget, IncrementalCompactionResult } from '../incremental/incrementaltypes.mjs';

export class HnswRelocator {
  constructor(private readonly source: DbmsBack) {}

  async relocate(targets: HnswRelocationTarget[]): Promise<IncrementalCompactionResult> {
    let relocatedHnswUnits = 0;

    for (const target of targets) {
      const currentTarget =
        target.blockNumber === undefined
          ? target
          : {
              ...target,
              nodeId: undefined,
            };
      try {
        if (await this.source.relocateHnswUnit(currentTarget)) {
          relocatedHnswUnits++;
        }
      } catch (error) {
        if (
          !(error instanceof Error) ||
          (!error.message.startsWith('No free HNSW graph relocation block below') &&
            !error.message.startsWith('No free HNSW vector relocation block below') &&
            !error.message.startsWith('No hnsw-graph unit found at block') &&
            !error.message.startsWith('No hnsw-vector unit found at block'))
        ) {
          throw error;
        }
      }
    }

    return { didWork: relocatedHnswUnits > 0, relocatedHnswUnits };
  }
}
