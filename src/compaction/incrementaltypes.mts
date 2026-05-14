// @author: Alec Van Vlerken
// @date: 2026-05-05

/**
 * Shared types for incremental compaction.
 *
 * The current implementation is K-bound driven: the planner chooses typed
 * relocation targets above the target boundary, relocators move them downward,
 * and tail reclamation physically trims free suffixes.
 */

export type RecordRelocationTarget = {
  collection: string;
  id: string | number;
  maxBlockExclusive?: number;
};

export type BtreeRelocationTarget = {
  collection: string;
  field: string;
  blockNumber: number;
  maxBlockExclusive?: number;
};

/**
 * Physical compaction state for HNSW-owned units.
 *
 * `live` units belong to user-visible semantic entries.
 * `tombstoned-retained` units are semantically deleted but still structurally
 * present and must be relocated, not reclaimed, when they block the tail.
 * `reclaimable-dead` is reserved for future maintenance/vacuum paths that can
 * prove a dead semantic unit has no remaining references.
 */
export type HnswUnitCompactionState = 'live' | 'tombstoned-retained' | 'reclaimable-dead';

export type HnswRelocationTarget = {
  collection: string;
  kind: 'hnsw-graph' | 'hnsw-vector' | 'hnsw-meta';
  blockNumber?: number;
  nodeId?: number;
  maxBlockExclusive?: number;
  hnswUnitState?: HnswUnitCompactionState;
};

export type RelocationOptions = {
  maxBlockExclusive?: number;
};

export type DocumentRelocationResult = {
  oldBlockNumber: number;
  newBlockNumber: number;
  relocated: boolean;
};

export type IncrementalCompactionResult = {
  didWork: boolean;
  reason?: string;
  attemptedSteps?: number;
  workSteps?: number;
  reachedTarget?: boolean;
  blocked?: boolean;
  relocatedDocuments?: number;
  relocatedBtreeNodes?: number;
  relocatedHnswUnits?: number;
  reclaimedTailBlocks?: number;
  metricsBefore?: IncrementalCompactionMetrics;
  metricsAfter?: IncrementalCompactionMetrics;
};

export type IncrementalCompactionPolicy = {
  maxAmplification: number;
  softAmplification?: number;
  targetBatchDocuments?: number;
  targetBatchUnits?: number;
  maxStepsPerRun?: number;
};

export type IncrementalCompactionMetrics = {
  fileSizeBytes: number;
  liveDataBytes: number;
  wastedBytes: number;
  amplification: number;
  totalBlocks: number;
  freeBlocks: number;
  usedBlocks: number;
  freeTailBlocks?: number;
};

export type RelocationKind =
  | 'record'
  | 'btree-leaf'
  | 'btree-internal'
  | 'hnsw-graph'
  | 'hnsw-vector'
  | 'hnsw-meta'
  | 'tail-reclaim';

export type RelocationTarget = {
  kind: RelocationKind;
  blockNumber?: number;
  maxBlockExclusive?: number;
  collection?: string;
  field?: string;
  documentId?: string | number;
  nodeId?: number;
  hnswUnitState?: HnswUnitCompactionState;
};

export type RelocationBatch = {
  targets: RelocationTarget[];
  reason: string;
};
