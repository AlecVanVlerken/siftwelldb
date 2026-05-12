// @author: Alec Van Vlerken
// @date: 2026-05-05

/**
 * RecordStore relocation executor.
 *
 * The compaction subsystem owns orchestration; DbmsBack owns the actual
 * structure-aware relocation primitive because it knows how to update id
 * indexes, secondary indexes, HNSW, and RecordStore chains together.
 */

import type { DbmsBack } from '../dbms/dbmsback.mjs';
import type { IncrementalCompactionResult, RecordRelocationTarget } from './incrementaltypes.mjs';

export class RecordRelocator {
  constructor(private readonly source: DbmsBack) {}

  async relocate(targets: RecordRelocationTarget[]): Promise<IncrementalCompactionResult> {
    let relocatedDocuments = 0;

    for (const target of targets) {
      const result = await this.source.relocateDocument(target.collection, target.id, {
        maxBlockExclusive: target.maxBlockExclusive,
      });
      if (result.relocated) {
        relocatedDocuments++;
      }
    }

    return { didWork: relocatedDocuments > 0, relocatedDocuments };
  }
}
