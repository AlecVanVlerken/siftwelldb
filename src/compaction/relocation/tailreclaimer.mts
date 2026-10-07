// @author: Alec Van Vlerken
// @date: 2026-05-06

/**
 * Free-tail reclamation executor.
 *
 * Relocation compaction can create free blocks at the physical end of the
 * file. This helper only invokes the storage-level tail trim; it does not move
 * live data or choose relocation targets.
 */

import type { DbmsBack } from '../../database/dbmsback.mjs';

export class TailReclaimer {
  constructor(private readonly source: DbmsBack) {}

  async reclaim(): Promise<number> {
    return await this.source.trimFreeTail();
  }
}
