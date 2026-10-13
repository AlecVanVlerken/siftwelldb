import type { RelocationTarget } from './incrementaltypes.mjs';

type Entry = { key: string; target: RelocationTarget; order: number };

function keyFor(target: RelocationTarget): string {
  switch (target.kind) {
    case 'record':
      return JSON.stringify([target.kind, target.collection, target.documentId]);
    case 'btree-leaf':
    case 'btree-internal':
      return JSON.stringify([target.kind, target.collection, target.field, target.blockNumber]);
    case 'hnsw-graph':
    case 'hnsw-vector':
      return JSON.stringify([target.kind, target.collection, target.indexKind, target.nodeId]);
    case 'hnsw-meta':
      return JSON.stringify([target.kind, target.collection, target.indexKind, target.blockNumber]);
    case 'tail-reclaim':
      throw new Error('Free tail reclamation does not require relocation candidate inventory');
  }
}

function locationFor(target: RelocationTarget): string {
  return JSON.stringify([target.kind, target.collection, target.indexKind, target.blockNumber]);
}

/**
 * Session-local verified locations, ordered by physical tail. Ordinary writes
 * discard this inventory; relocation replaces only the unit that actually moved.
 * An indexed max heap avoids sorting or walking every location on each small batch.
 */
export class RelocationCandidates {
  private readonly heap: Entry[] = [];
  private readonly positions = new Map<string, number>();
  private readonly locations = new Map<string, Set<string>>();
  private nextOrder: number;

  constructor(targets: RelocationTarget[]) {
    this.nextOrder = targets.length;
    for (const [order, target] of targets.entries()) {
      const key = keyFor(target);
      const entry = { key, target, order };
      this.positions.set(key, this.heap.length);
      this.addLocation(entry);
      this.heap.push(entry);
    }
    for (let index = Math.floor(this.heap.length / 2) - 1; index >= 0; index--) this.down(index);
  }

  replace(previous: RelocationTarget, target: RelocationTarget): void {
    const index = this.positions.get(keyFor(previous));
    if (index === undefined) return;
    const order = this.heap[index].order;
    this.remove(index);
    this.insert({ key: keyFor(target), target, order });
  }

  add(target: RelocationTarget): void {
    const key = keyFor(target);
    if (!this.positions.has(key)) this.insert({ key, target, order: this.nextOrder++ });
  }

  top(limit: number): RelocationTarget[] {
    const count = Number.isNaN(limit) ? 0 : Math.min(this.heap.length, Math.max(0, Math.floor(limit)));
    const selected: Entry[] = [];
    for (let index = 0; index < count; index++) selected.push(this.remove(0));
    for (const entry of selected) this.insert(entry);
    return selected.map((entry) => ({ ...entry.target }));
  }

  atLocation(target: RelocationTarget): RelocationTarget | undefined {
    const keys = this.locations.get(locationFor(target));
    if (!keys) return undefined;
    const key = keys.values().next().value!;
    return { ...this.heap[this.positions.get(key)!].target };
  }

  private precedes(a: Entry, b: Entry): boolean {
    const blockDifference = (a.target.blockNumber ?? 0) - (b.target.blockNumber ?? 0);
    return blockDifference > 0 || (blockDifference === 0 && a.order < b.order);
  }

  private swap(a: number, b: number): void {
    [this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]];
    this.positions.set(this.heap[a].key, a);
    this.positions.set(this.heap[b].key, b);
  }

  private up(index: number): number {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.precedes(this.heap[index], this.heap[parent])) break;
      this.swap(index, parent);
      index = parent;
    }
    return index;
  }

  private down(index: number): void {
    while (index * 2 + 1 < this.heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.heap.length && this.precedes(this.heap[child + 1], this.heap[child])) child++;
      if (!this.precedes(this.heap[child], this.heap[index])) break;
      this.swap(index, child);
      index = child;
    }
  }

  private insert(entry: Entry): void {
    this.addLocation(entry);
    this.positions.set(entry.key, this.heap.length);
    this.heap.push(entry);
    this.up(this.heap.length - 1);
  }

  private remove(index: number): Entry {
    const removed = this.heap[index];
    const last = this.heap.pop()!;
    this.positions.delete(removed.key);
    const location = locationFor(removed.target);
    const keys = this.locations.get(location)!;
    keys.delete(removed.key);
    if (keys.size === 0) this.locations.delete(location);
    if (index < this.heap.length) {
      this.heap[index] = last;
      this.positions.set(last.key, index);
      this.down(this.up(index));
    }
    return removed;
  }

  private addLocation(entry: Entry): void {
    const location = locationFor(entry.target);
    let keys = this.locations.get(location);
    if (!keys) this.locations.set(location, (keys = new Set()));
    keys.add(entry.key);
  }
}
