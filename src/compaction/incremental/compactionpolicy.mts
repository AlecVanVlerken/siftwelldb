// @author: Alec Van Vlerken
// @date: 2026-05-06

import type { IncrementalCompactionMetrics, IncrementalCompactionPolicy } from './incrementaltypes.mjs';

export const DEFAULT_INCREMENTAL_COMPACTION_POLICY: IncrementalCompactionPolicy = {
  maxAmplification: 1.5,
  targetBatchDocuments: 8,
  targetBatchUnits: 8,
  maxStepsPerRun: 8,
};

export class CompactionPolicy {
  constructor(private readonly policy: IncrementalCompactionPolicy = DEFAULT_INCREMENTAL_COMPACTION_POLICY) {}

  get targetBatchDocuments(): number {
    return Math.max(1, this.policy.targetBatchDocuments ?? this.policy.targetBatchUnits ?? 8);
  }

  get targetBatchUnits(): number {
    return Math.max(1, this.policy.targetBatchUnits ?? this.policy.targetBatchDocuments ?? 8);
  }

  get maxAmplification(): number {
    return this.policy.maxAmplification;
  }

  get maxStepsPerRun(): number {
    return Math.max(1, this.policy.maxStepsPerRun ?? DEFAULT_INCREMENTAL_COMPACTION_POLICY.maxStepsPerRun ?? 8);
  }

  shouldCompact(metrics: IncrementalCompactionMetrics): boolean {
    const threshold = this.policy.softAmplification ?? this.policy.maxAmplification;
    return metrics.amplification > threshold || (metrics.freeTailBlocks ?? 0) > 0;
  }

  shouldEscalate(metrics: IncrementalCompactionMetrics): boolean {
    return metrics.amplification > this.policy.maxAmplification;
  }

  getReason(metrics: IncrementalCompactionMetrics): string | undefined {
    if ((metrics.freeTailBlocks ?? 0) > 0) {
      return `free tail contains ${metrics.freeTailBlocks} block(s)`;
    }

    if (this.shouldCompact(metrics)) {
      const threshold = this.policy.softAmplification ?? this.policy.maxAmplification;
      return `storage amplification ${metrics.amplification.toFixed(2)} exceeds ${threshold.toFixed(2)}`;
    }

    return undefined;
  }
}
