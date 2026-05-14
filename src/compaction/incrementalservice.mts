// @author: Alec Van Vlerken
// @date: 2026-05-06

import type { DbmsBack } from '../dbms/dbmsback.mjs';
import { BtreeRelocator } from './btreerelocator.mjs';
import { CompactionMetricsCollector } from './compactionmetrics.mjs';
import { CompactionPolicy } from './compactionpolicy.mjs';
import { CompactionState } from './compactionstate.mjs';
import { HnswRelocator } from './hnswrelocator.mjs';
import { IncrementalPlanner } from './incrementalplanner.mjs';
import { RecordRelocator } from './recordrelocator.mjs';
import { TailReclaimer } from './tailreclaimer.mjs';
import type {
  BtreeRelocationTarget,
  HnswRelocationTarget,
  IncrementalCompactionPolicy,
  IncrementalCompactionResult,
  RecordRelocationTarget,
  RelocationBatch,
  RelocationTarget,
} from './incrementaltypes.mjs';

export class IncrementalCompactionService {
  constructor(
    private readonly source: DbmsBack,
    private readonly policy?: IncrementalCompactionPolicy,
    private readonly state: CompactionState = new CompactionState(),
  ) {}

  async runStep(): Promise<IncrementalCompactionResult> {
    const policy = new CompactionPolicy(this.policy);
    const metricsCollector = new CompactionMetricsCollector(this.source);
    const metricsBefore = await metricsCollector.collect();

    if (!policy.shouldCompact(metricsBefore)) {
      return {
        didWork: false,
        reason: 'incremental compaction is not needed',
        metricsBefore,
      };
    }

    const planner = new IncrementalPlanner(this.source, policy, this.state);
    const batch = await planner.plan();
    if (!batch || batch.targets.length === 0) {
      return {
        didWork: false,
        reason: policy.getReason(metricsBefore) ?? 'no incremental compaction targets selected',
        metricsBefore,
      };
    }

    const execution = await this.executeBatch(batch);
    const didWork = this.didExecuteWork(execution);
    if (!didWork) {
      return {
        ...execution,
        didWork: false,
        reason: batch.reason,
        metricsBefore,
      };
    }

    if (!this.hasTailReclaimTarget(batch.targets)) {
      await this.source.commit();
      execution.reclaimedTailBlocks = await new TailReclaimer(this.source).reclaim();
    }

    const metricsAfter = await metricsCollector.collect();
    return {
      ...execution,
      didWork: true,
      attemptedSteps: 1,
      workSteps: 1,
      reachedTarget: !policy.shouldCompact(metricsAfter),
      reason: batch.reason,
      metricsBefore,
      metricsAfter,
    };
  }

  async runUntilTarget(): Promise<IncrementalCompactionResult> {
    const policy = new CompactionPolicy(this.policy);
    let combined: IncrementalCompactionResult = {
      didWork: false,
      attemptedSteps: 0,
      workSteps: 0,
      relocatedDocuments: 0,
      relocatedBtreeNodes: 0,
      relocatedHnswUnits: 0,
      reclaimedTailBlocks: 0,
    };

    for (let step = 0; step < policy.maxStepsPerRun; step++) {
      const result = await this.runStep();
      combined = this.combineResults(combined, result, policy);

      if (!result.didWork || result.metricsAfter === undefined || !policy.shouldCompact(result.metricsAfter)) {
        break;
      }
    }

    return combined;
  }

  private async executeBatch(batch: RelocationBatch): Promise<Omit<IncrementalCompactionResult, 'didWork'>> {
    const recordTargets = this.toRecordTargets(batch.targets);
    const btreeTargets = this.toBtreeTargets(batch.targets);
    const hnswTargets = this.toHnswTargets(batch.targets);
    const shouldReclaimTail = this.hasTailReclaimTarget(batch.targets);

    const result: Omit<IncrementalCompactionResult, 'didWork'> = {};

    if (recordTargets.length > 0) {
      result.relocatedDocuments =
        (await new RecordRelocator(this.source).relocate(recordTargets)).relocatedDocuments ?? 0;
    }

    if (btreeTargets.length > 0) {
      result.relocatedBtreeNodes =
        (await new BtreeRelocator(this.source).relocate(btreeTargets)).relocatedBtreeNodes ?? 0;
    }

    if (hnswTargets.length > 0) {
      result.relocatedHnswUnits = (await new HnswRelocator(this.source).relocate(hnswTargets)).relocatedHnswUnits ?? 0;
    }

    if (shouldReclaimTail) {
      result.reclaimedTailBlocks = await new TailReclaimer(this.source).reclaim();
    }

    return result;
  }

  private toRecordTargets(targets: RelocationTarget[]): RecordRelocationTarget[] {
    return targets
      .filter((target) => target.kind === 'record')
      .map((target) => {
        if (target.collection === undefined || target.documentId === undefined) {
          throw new Error('Record relocation target requires collection and documentId');
        }
        return {
          collection: target.collection,
          id: target.documentId,
          maxBlockExclusive: target.maxBlockExclusive,
        };
      });
  }

  private toBtreeTargets(targets: RelocationTarget[]): BtreeRelocationTarget[] {
    return targets
      .filter((target) => target.kind === 'btree-leaf' || target.kind === 'btree-internal')
      .map((target) => {
        if (target.collection === undefined || target.field === undefined || target.blockNumber === undefined) {
          throw new Error('B+ tree relocation target requires collection, field, and blockNumber');
        }
        return {
          collection: target.collection,
          field: target.field,
          blockNumber: target.blockNumber,
          maxBlockExclusive: target.maxBlockExclusive,
        };
      });
  }

  private toHnswTargets(targets: RelocationTarget[]): HnswRelocationTarget[] {
    return targets
      .filter(
        (target): target is RelocationTarget & { kind: HnswRelocationTarget['kind'] } =>
          target.kind === 'hnsw-graph' || target.kind === 'hnsw-vector' || target.kind === 'hnsw-meta',
      )
      .map((target) => {
        if (target.collection === undefined) {
          throw new Error('HNSW relocation target requires collection');
        }
        if (target.kind !== 'hnsw-meta' && target.nodeId === undefined && target.blockNumber === undefined) {
          throw new Error('HNSW relocation target requires nodeId or blockNumber');
        }
        return {
          collection: target.collection,
          kind: target.kind,
          blockNumber: target.blockNumber,
          nodeId: target.nodeId,
          maxBlockExclusive: target.maxBlockExclusive,
          hnswUnitState: target.hnswUnitState,
        };
      });
  }

  private hasTailReclaimTarget(targets: RelocationTarget[]): boolean {
    return targets.some((target) => target.kind === 'tail-reclaim');
  }

  private didExecuteWork(result: Omit<IncrementalCompactionResult, 'didWork'>): boolean {
    return (
      (result.relocatedDocuments ?? 0) > 0 ||
      (result.relocatedBtreeNodes ?? 0) > 0 ||
      (result.relocatedHnswUnits ?? 0) > 0 ||
      (result.reclaimedTailBlocks ?? 0) > 0
    );
  }

  private combineResults(
    combined: IncrementalCompactionResult,
    result: IncrementalCompactionResult,
    policy: CompactionPolicy,
  ): IncrementalCompactionResult {
    const attemptedSteps = (combined.attemptedSteps ?? 0) + 1;
    const workSteps = (combined.workSteps ?? 0) + (result.didWork ? 1 : 0);
    const metricsBefore = combined.metricsBefore ?? result.metricsBefore;
    const metricsAfter = result.metricsAfter ?? combined.metricsAfter ?? result.metricsBefore;
    const reachedTarget = metricsAfter !== undefined ? !policy.shouldCompact(metricsAfter) : false;

    return {
      didWork: (combined.didWork || result.didWork) === true,
      reason: result.reason ?? combined.reason,
      attemptedSteps,
      workSteps,
      reachedTarget,
      blocked: !result.didWork && metricsAfter !== undefined && policy.shouldCompact(metricsAfter),
      relocatedDocuments: (combined.relocatedDocuments ?? 0) + (result.relocatedDocuments ?? 0),
      relocatedBtreeNodes: (combined.relocatedBtreeNodes ?? 0) + (result.relocatedBtreeNodes ?? 0),
      relocatedHnswUnits: (combined.relocatedHnswUnits ?? 0) + (result.relocatedHnswUnits ?? 0),
      reclaimedTailBlocks: (combined.reclaimedTailBlocks ?? 0) + (result.reclaimedTailBlocks ?? 0),
      metricsBefore,
      metricsAfter,
    };
  }
}
