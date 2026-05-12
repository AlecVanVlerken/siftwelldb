// @author: Alec Van Vlerken
// @date: 2026-05-06

import type { DbmsBack } from '../dbms/dbmsback.mjs';
import { CompactionMetricsCollector } from './compactionmetrics.mjs';
import { CompactionPolicy } from './compactionpolicy.mjs';
import { CompactionState } from './compactionstate.mjs';
import type { IncrementalCompactionMetrics, RelocationBatch, RelocationTarget } from './incrementaltypes.mjs';

export class IncrementalPlanner {
  constructor(
    private readonly source: DbmsBack,
    private readonly policy: CompactionPolicy,
    private readonly state: CompactionState,
  ) {}

  async plan(): Promise<RelocationBatch | null> {
    const metrics = await new CompactionMetricsCollector(this.source).collect();
    if (!this.policy.shouldCompact(metrics)) {
      return null;
    }

    const reason = this.policy.getReason(metrics) ?? 'incremental compaction is needed';
    const targetBlockCount = this.getTargetBlockCount(metrics);

    if ((metrics.freeTailBlocks ?? 0) > 0) {
      const blockNumber = Math.max(1, metrics.totalBlocks - (metrics.freeTailBlocks ?? 0));
      this.state.setLastTailScanBlock(blockNumber);
      return {
        targets: [{ kind: 'tail-reclaim', blockNumber }],
        reason,
      };
    }

    const candidateLimit = Math.max(this.policy.targetBatchDocuments, this.policy.targetBatchUnits) * 16;
    const [recordCandidates, btreeCandidates, hnswCandidates] = await Promise.all([
      this.source.listRecordRelocationTargets(candidateLimit),
      this.source.listBtreeRelocationTargets(candidateLimit),
      this.source.listHnswRelocationCandidateTargets(candidateLimit),
    ]);

    const tailBlockers = [...recordCandidates, ...btreeCandidates, ...hnswCandidates]
      .filter((target) => (target.blockNumber ?? 0) >= targetBlockCount)
      .sort((a, b) => {
        const blockDiff = (b.blockNumber ?? 0) - (a.blockNumber ?? 0);
        if (blockDiff !== 0) return blockDiff;
        return this.kindPriority(a) - this.kindPriority(b);
      })
      .slice(0, this.getBatchLimit())
      .map((target) => ({ ...target, maxBlockExclusive: targetBlockCount }));

    if (tailBlockers.length > 0) {
      const lastRecord = tailBlockers.find((target) => target.kind === 'record');
      if (lastRecord) {
        this.state.setLastRecordCursor({ collection: lastRecord.collection, id: lastRecord.documentId });
      }
      return { targets: tailBlockers, reason };
    }

    return null;
  }

  private getBatchLimit(): number {
    return Math.max(this.policy.targetBatchDocuments, this.policy.targetBatchUnits);
  }

  private getTargetBlockCount(metrics: IncrementalCompactionMetrics): number {
    const target = Math.ceil(metrics.usedBlocks * this.policy.maxAmplification);
    return Math.max(1, Math.min(metrics.totalBlocks, target));
  }

  private kindPriority(target: RelocationTarget): number {
    switch (target.kind) {
      case 'record':
        return 0;
      case 'btree-leaf':
      case 'btree-internal':
        return 1;
      case 'hnsw-graph':
      case 'hnsw-vector':
      case 'hnsw-meta':
        return 2;
      case 'tail-reclaim':
        return 3;
    }
  }
}
