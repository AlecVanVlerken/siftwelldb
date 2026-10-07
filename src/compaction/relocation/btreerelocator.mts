// @author: Alec Van Vlerken
// @date: 2026-05-05

/**
 * B+ tree relocation executor.
 *
 * The compaction subsystem owns batch orchestration; DbmsBack delegates each
 * targeted node move to the B+ tree storage layer, where structural references
 * can be repaired correctly.
 */

import type { DbmsBack } from '../../database/dbmsback.mjs';
import type { BtreeRelocationTarget, IncrementalCompactionResult } from '../incremental/incrementaltypes.mjs';

export class BtreeRelocator {
  constructor(private readonly source: DbmsBack) {}

  async relocate(targets: BtreeRelocationTarget[]): Promise<IncrementalCompactionResult> {
    let relocatedBtreeNodes = 0;

    for (const target of targets) {
      try {
        const newBlockNumber = await this.source.relocateBtreeNode(
          target.collection,
          target.field,
          target.blockNumber,
          {
            maxBlockExclusive: target.maxBlockExclusive,
          },
        );
        if (target.maxBlockExclusive === undefined || newBlockNumber < target.blockNumber) {
          relocatedBtreeNodes++;
        }
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('No free B+ tree relocation block below')) {
          throw error;
        }
      }
    }

    return { didWork: relocatedBtreeNodes > 0, relocatedBtreeNodes };
  }
}
