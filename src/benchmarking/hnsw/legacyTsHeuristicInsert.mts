import { HNSWNode, type NodeId } from '../../hnsw/hnswNode.mjs';
import { type SearchContext, HNSWSearch, type Candidate } from '../../hnsw/hnswSearch.mjs';

export interface LegacyInsertContext extends SearchContext {
  saveNode(node: HNSWNode): Promise<void>;
}

export class LegacyTsHeuristicInsert {
  private readonly mL: number;
  private readonly searcher: HNSWSearch;

  constructor(
    private readonly context: LegacyInsertContext,
    private readonly M: number,
    private readonly efConstruction: number,
  ) {
    this.mL = 1.0 / Math.log(M);
    this.searcher = new HNSWSearch(context, efConstruction);
  }

  async insert(
    entryPoint: NodeId | null,
    maxLevel: number,
    newNode: HNSWNode,
    queryVector: Float32Array,
  ): Promise<{ entryPoint: NodeId; maxLevel: number }> {
    const level = newNode.level;
    newNode.neighbors = Array.from({ length: level + 1 }, () => []);

    if (entryPoint === null) {
      await this.context.saveNode(newNode);
      return { entryPoint: newNode.nodeId, maxLevel: level };
    }

    let ep = entryPoint;
    for (let layer = maxLevel; layer >= level + 1; layer--) {
      ep = await this.searcher.greedySearchLayer(ep, queryVector, layer);
    }

    for (let layer = Math.min(level, maxLevel); layer >= 0; layer--) {
      const mMax = layer === 0 ? this.M * 2 : this.M;
      const candidates = await this.searcher.searchLayer(ep, queryVector, this.efConstruction, layer);
      const newNeighbors = await this.heuristicSelect(candidates, queryVector, this.M);

      newNode.neighbors[layer] = newNeighbors;

      for (const neighborId of newNeighbors) {
        const neighbor = await this.context.getNode(neighborId);
        const layerNeighbors = neighbor.neighbors[layer] ?? [];
        layerNeighbors.push(newNode.nodeId);
        neighbor.neighbors[layer] = layerNeighbors;

        if (layerNeighbors.length > mMax) {
          neighbor.neighbors[layer] = await this.pruneNeighbors(neighborId, layerNeighbors, mMax);
        }

        await this.context.saveNode(neighbor);
      }

      if (candidates.length > 0) {
        const sorted = [...candidates].sort((left, right) => left.distance - right.distance);
        ep = sorted[0].nodeId;
      }
    }

    await this.context.saveNode(newNode);

    const newEntryPoint = level > maxLevel ? newNode.nodeId : entryPoint;
    const newMaxLevel = Math.max(maxLevel, level);
    return { entryPoint: newEntryPoint, maxLevel: newMaxLevel };
  }

  randomLevel(maxStoredLevel: number): number {
    const level = Math.floor(-Math.log(Math.random()) * this.mL);
    return Math.min(level, maxStoredLevel);
  }

  private async heuristicSelect(candidates: Candidate[], queryVector: Float32Array, limit: number): Promise<NodeId[]> {
    const sorted = [...candidates].sort((left, right) => left.distance - right.distance);
    const result: NodeId[] = [];
    const resultVectors: Float32Array[] = [];

    for (const candidate of sorted) {
      if (result.length >= limit) break;

      const candidateNode = await this.context.getNode(candidate.nodeId);
      if (candidateNode.deleted) continue;

      const candidateVector = await this.context.getVector(candidate.nodeId);
      const distQc = candidate.distance;
      const isUseful = resultVectors.every(
        (resultVector) => distQc < this.context.computeDistance(candidateVector, resultVector),
      );

      if (isUseful || result.length === 0) {
        result.push(candidate.nodeId);
        resultVectors.push(candidateVector);
      }
    }

    return result;
  }

  private async pruneNeighbors(nodeId: NodeId, neighbors: NodeId[], limit: number): Promise<NodeId[]> {
    const nodeVector = await this.context.getVector(nodeId);
    const candidates: Candidate[] = [];
    for (const neighborId of neighbors) {
      try {
        const neighborNode = await this.context.getNode(neighborId);
        if (neighborNode.deleted) continue;
        const neighborVector = await this.context.getVector(neighborId);
        candidates.push({
          nodeId: neighborId,
          distance: this.context.computeDistance(nodeVector, neighborVector),
        });
      } catch {
        continue;
      }
    }

    return this.heuristicSelect(candidates, nodeVector, limit);
  }
}
