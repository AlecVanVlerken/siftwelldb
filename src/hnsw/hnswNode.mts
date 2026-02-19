//@author: Thomas Dumon with usage of Claude sonnet 4.6
//@date: 2026-02-18

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
