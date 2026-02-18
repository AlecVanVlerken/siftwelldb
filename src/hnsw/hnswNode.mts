// hnsw/hnswNode.ts

import type { VectorPointer } from './vectorHeapFile.mjs';

export type NodeId = bigint;

export class HNSWNode {
  nodeId!: NodeId;
  docId!: number;
  level!: number;
  vectorPtr!: VectorPointer;
  neighbors!: NodeId[][];
  deleted!: boolean;

  constructor(init?: Partial<HNSWNode>) {
    Object.assign(this, init);
  }
}
