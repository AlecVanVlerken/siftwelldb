// @author: Alec Van Vlerken
// @date: 2026-05-06

import type { DbmsBack } from '../../database/dbmsback.mjs';
import type { IncrementalCompactionMetrics } from './incrementaltypes.mjs';

export class CompactionMetricsCollector {
  constructor(private readonly source: DbmsBack) {}

  async collect(): Promise<IncrementalCompactionMetrics> {
    const stats = await this.source.getCompactionStorageStats();
    const liveDataBytes = Math.max(1, stats.usedBlocks * stats.blockSize);
    const wastedBytes = Math.max(0, stats.freeBlocks * stats.blockSize);

    return {
      fileSizeBytes: stats.fileSizeBytes,
      liveDataBytes,
      wastedBytes,
      amplification: stats.fileSizeBytes / liveDataBytes,
      totalBlocks: stats.totalBlocks,
      freeBlocks: stats.freeBlocks,
      usedBlocks: stats.usedBlocks,
      freeTailBlocks: stats.freeTailBlocks,
    };
  }
}
