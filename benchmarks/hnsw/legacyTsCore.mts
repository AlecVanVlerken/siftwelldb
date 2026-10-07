export type Dist = { distance: number; nodeId: number };

type CoreNode = {
  docId: number;
  level: number;
  deleted: boolean;
  neighbors: number[][];
};

class BinaryHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (left: T, right: T) => number) {}

  push(value: T): void {
    this.items.push(value);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  size(): number {
    return this.items.length;
  }

  toArray(): T[] {
    return [...this.items];
  }

  private bubbleUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (this.compare(this.items[current], this.items[parent]) >= 0) break;
      [this.items[current], this.items[parent]] = [this.items[parent], this.items[current]];
      current = parent;
    }
  }

  private bubbleDown(index: number): void {
    let current = index;
    while (true) {
      const left = current * 2 + 1;
      const right = left + 1;
      let smallest = current;

      if (left < this.items.length && this.compare(this.items[left], this.items[smallest]) < 0) {
        smallest = left;
      }
      if (right < this.items.length && this.compare(this.items[right], this.items[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === current) break;

      [this.items[current], this.items[smallest]] = [this.items[smallest], this.items[current]];
      current = smallest;
    }
  }
}

export class LegacyTsCore {
  private readonly m0: number;
  private readonly mL: number;
  private readonly vectors: Float32Array[] = [];
  private readonly nodes: CoreNode[] = [];
  private readonly docToNode = new Map<number, number>();
  private readonly dirtyDocIds: number[] = [];
  private entryPoint: number | null = null;
  private maxLevel = 0;

  constructor(
    private readonly dim: number,
    private readonly m: number,
    private readonly efConstruction: number,
    private efSearch: number,
  ) {
    this.m0 = m * 2;
    this.mL = 1.0 / Math.log(m);
  }

  insert(docId: number, vector: Float32Array): void {
    if (vector.length !== this.dim) {
      throw new Error(`LegacyTsCore: vector dimension mismatch. Expected ${this.dim}, got ${vector.length}.`);
    }

    this.dirtyDocIds.length = 0;

    if (this.docToNode.has(docId)) {
      const oldNodeId = this.docToNode.get(docId)!;
      this.nodes[oldNodeId].deleted = true;
    }

    const nodeId = this.nodes.length;
    const level = this.randomLevel();

    this.vectors.push(new Float32Array(vector));
    this.nodes.push({
      docId,
      level,
      deleted: false,
      neighbors: Array.from({ length: level + 1 }, () => []),
    });
    this.docToNode.set(docId, nodeId);
    this.dirtyDocIds.push(docId);

    if (this.entryPoint === null) {
      this.entryPoint = nodeId;
      this.maxLevel = level;
      return;
    }

    let ep = this.entryPoint;

    for (let layer = this.maxLevel; layer >= level + 1; layer--) {
      ep = this.greedyLayer(ep, vector, layer);
    }

    for (let layer = Math.min(level, this.maxLevel); layer >= 0; layer--) {
      const mMax = layer === 0 ? this.m0 : this.m;
      const candidates = this.searchLayer(ep, vector, this.efConstruction, layer);

      if (candidates.length > 0) {
        let best = candidates[0];
        for (const candidate of candidates) {
          if (candidate.distance < best.distance) best = candidate;
        }
        ep = best.nodeId;
      }

      const neighbors = this.heuristicSelect(candidates, this.m);
      this.nodes[nodeId].neighbors[layer] = neighbors;

      for (const neighborId of neighbors) {
        if (layer > this.nodes[neighborId].level) continue;
        this.nodes[neighborId].neighbors[layer].push(nodeId);

        const neighborDocId = this.nodes[neighborId].docId;
        if (!this.dirtyDocIds.includes(neighborDocId)) {
          this.dirtyDocIds.push(neighborDocId);
        }

        if (this.nodes[neighborId].neighbors[layer].length > mMax) {
          this.pruneBacklinks(neighborId, layer, mMax);
        }
      }
    }

    if (level > this.maxLevel) {
      this.entryPoint = nodeId;
      this.maxLevel = level;
    }
  }

  search(query: Float32Array, k: number): number[] {
    if (query.length !== this.dim) {
      throw new Error(`LegacyTsCore: query dimension mismatch. Expected ${this.dim}, got ${query.length}.`);
    }

    if (this.entryPoint === null) return [];

    let ep = this.entryPoint;
    for (let layer = this.maxLevel; layer >= 1; layer--) {
      ep = this.greedyLayer(ep, query, layer);
    }

    const results = this.searchLayer(ep, query, Math.max(this.efSearch, k), 0);
    results.sort((left, right) => left.distance - right.distance);

    const docIds: number[] = [];
    for (const result of results) {
      const node = this.nodes[result.nodeId];
      if (!node.deleted) docIds.push(node.docId);
      if (docIds.length >= k) break;
    }
    return docIds;
  }

  delete(docId: number): boolean {
    this.dirtyDocIds.length = 0;
    const nodeId = this.docToNode.get(docId);
    if (nodeId === undefined) return false;

    const nodeLevel = this.nodes[nodeId].level;
    for (let layer = 0; layer <= nodeLevel; layer++) {
      const neighbors = [...(this.nodes[nodeId].neighbors[layer] ?? [])];
      for (const neighborId of neighbors) {
        const layerNeighbors = this.nodes[neighborId].neighbors[layer];
        this.nodes[neighborId].neighbors[layer] = layerNeighbors.filter((id) => id !== nodeId);
        const neighborDocId = this.nodes[neighborId].docId;
        if (!this.dirtyDocIds.includes(neighborDocId)) {
          this.dirtyDocIds.push(neighborDocId);
        }
      }
    }

    this.nodes[nodeId].deleted = true;
    this.docToNode.delete(docId);

    if (this.entryPoint === nodeId) {
      this.entryPoint = null;
      this.maxLevel = 0;
      for (let index = 0; index < this.nodes.length; index++) {
        const node = this.nodes[index];
        if (node.deleted) continue;
        if (this.entryPoint === null) this.entryPoint = index;
        if (node.level > this.maxLevel) this.maxLevel = node.level;
      }
    }

    return true;
  }

  takeDirtyNodes(): Uint32Array {
    return Uint32Array.from(this.dirtyDocIds);
  }

  getLevel(docId: number): number {
    const nodeId = this.docToNode.get(docId);
    return nodeId === undefined ? -1 : this.nodes[nodeId].level;
  }

  getAllNeighbors(docId: number): Uint32Array {
    const nodeId = this.docToNode.get(docId);
    if (nodeId === undefined) return new Uint32Array(0);

    const node = this.nodes[nodeId];
    const values: number[] = [node.level];
    for (const layerNeighbors of node.neighbors) {
      values.push(layerNeighbors.length);
      for (const neighborId of layerNeighbors) {
        values.push(this.nodes[neighborId].docId);
      }
    }
    return Uint32Array.from(values);
  }

  getEntryDocId(): number | null {
    return this.entryPoint === null ? null : this.nodes[this.entryPoint].docId;
  }

  getMaxLevel(): number {
    return this.maxLevel;
  }

  setEfSearch(efSearch: number): void {
    this.efSearch = efSearch;
  }

  get size(): number {
    return this.docToNode.size;
  }

  close(): void {}

  private randomLevel(): number {
    const maxLevel = 16;
    const random = Math.max(Math.random(), 1e-10);
    return Math.min(Math.floor(-Math.log(random) * this.mL), maxLevel);
  }

  private greedyLayer(entry: number, query: Float32Array, layer: number): number {
    let ep = entry;
    let bestDistance = this.computeDistance(this.vectors[ep], query);

    while (true) {
      let improved = false;
      const neighbors = this.nodes[ep].neighbors[layer] ?? [];
      for (const neighborId of neighbors) {
        const neighbor = this.nodes[neighborId];
        if (neighbor.deleted) continue;
        const distance = this.computeDistance(this.vectors[neighborId], query);
        if (distance < bestDistance) {
          bestDistance = distance;
          ep = neighborId;
          improved = true;
        }
      }
      if (!improved) break;
    }

    return ep;
  }

  private searchLayer(entry: number, query: Float32Array, ef: number, layer: number): Dist[] {
    const entryDistance = this.computeDistance(this.vectors[entry], query);
    const candidates = new BinaryHeap<Dist>((left, right) => left.distance - right.distance);
    const results = new BinaryHeap<Dist>((left, right) => right.distance - left.distance);
    const visited = new Set<number>([entry]);

    candidates.push({ distance: entryDistance, nodeId: entry });
    results.push({ distance: entryDistance, nodeId: entry });

    while (candidates.size() > 0) {
      const candidate = candidates.pop()!;
      const furthest = results.peek();
      if (furthest !== undefined && candidate.distance > furthest.distance) break;

      const neighbors = this.nodes[candidate.nodeId].neighbors[layer] ?? [];
      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighbor = this.nodes[neighborId];
        if (neighbor.deleted) continue;

        const distance = this.computeDistance(this.vectors[neighborId], query);
        const currentFurthest = results.peek();
        const furthestDistance = currentFurthest?.distance ?? Number.POSITIVE_INFINITY;

        if (distance < furthestDistance || results.size() < ef) {
          const dist = { distance, nodeId: neighborId };
          candidates.push(dist);
          results.push(dist);
          if (results.size() > ef) results.pop();
        }
      }
    }

    return results.toArray();
  }

  private heuristicSelect(candidates: Dist[], limit: number): number[] {
    const sorted = [...candidates].sort((left, right) => left.distance - right.distance);
    const selected: number[] = [];
    const selectedVectors: Float32Array[] = [];

    for (const candidate of sorted) {
      if (selected.length >= limit) break;
      const node = this.nodes[candidate.nodeId];
      if (node.deleted) continue;

      const candidateVector = this.vectors[candidate.nodeId];
      const isUseful = selectedVectors.every((selectedVector) => {
        return candidate.distance < this.computeDistance(candidateVector, selectedVector);
      });

      if (isUseful || selected.length === 0) {
        selected.push(candidate.nodeId);
        selectedVectors.push(candidateVector);
      }
    }

    return selected;
  }

  private pruneBacklinks(nodeId: number, layer: number, limit: number): void {
    const nodeVector = this.vectors[nodeId];
    const candidates: Dist[] = this.nodes[nodeId].neighbors[layer]
      .filter((neighborId) => !this.nodes[neighborId].deleted)
      .map((neighborId) => ({
        distance: this.computeDistance(nodeVector, this.vectors[neighborId]),
        nodeId: neighborId,
      }));

    this.nodes[nodeId].neighbors[layer] = this.heuristicSelect(candidates, limit);
  }

  private computeDistance(left: Float32Array, right: Float32Array): number {
    let sum = 0;
    for (let index = 0; index < left.length; index++) {
      const diff = left[index] - right[index];
      sum += diff * diff;
    }
    return sum;
  }
}
