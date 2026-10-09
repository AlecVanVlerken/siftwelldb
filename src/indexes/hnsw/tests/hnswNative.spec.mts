// FFI contract coverage recovered from s2-final-changes-thomas.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HnswIndexNative } from '../hnswNative.mjs';

describe('HnswIndexNative FFI contracts', () => {
  const M = 4;
  let index: HnswIndexNative;

  beforeEach(() => {
    index = new HnswIndexNative(2, M, 32, 16);
  });
  afterEach(() => {
    index.close();
  });

  it('bulk neighbors match every per-layer neighbor list', () => {
    for (let id = 1; id <= 24; id++) index.insert(id, new Float32Array([id, id % 3]));
    for (let id = 1; id <= 24; id++) {
      const packed = index.getAllNeighbors(id);
      expect(packed[0]).toBe(index.getLevel(id));
      let position = 1;
      for (let layer = 0; layer <= packed[0]; layer++) {
        const count = packed[position++];
        const neighbors = Array.from(packed.subarray(position, position + count));
        expect(neighbors).toEqual(Array.from(index.getNeighbors(id, layer)));
        position += count;
      }
      expect(position).toBe(packed.length);
    }
  });

  it('a newly inserted node stores at most M neighbors at layer zero', () => {
    for (let id = 1; id <= 24; id++) {
      index.insert(id, new Float32Array([id, id % 3]));
      expect(index.getNeighborCount(id, 0)).toBeLessThanOrEqual(M);
    }
  });

  it('dirty-node snapshots remain stable until the next mutation', () => {
    index.insert(1, new Float32Array([0, 0]));
    expect(Array.from(index.takeDirtyNodes())).toEqual([1]);
    expect(Array.from(index.takeDirtyNodes())).toEqual([1]);
    index.insert(2, new Float32Array([1, 0]));
    const dirty = Array.from(index.takeDirtyNodes());
    expect(dirty).toContain(2);
    expect(Array.from(index.takeDirtyNodes())).toEqual(dirty);
  });

  it('preserves tombstoned entry-point routing and imports its neighbors', () => {
    index.importNode(1, 1, new Float32Array([0, 0]), true);
    index.importNode(2, 0, new Float32Array([1, 0]), false);
    index.importSetNeighbors(1, 0, [2]);
    index.importSetNeighbors(2, 0, [1]);
    index.importFinish(1, 1);
    expect(index.getEntryDocId()).toBe(1);
    expect(index.getLevel(1)).toBe(1);
    expect(Array.from(index.getNeighbors(1, 0))).toEqual([2]);
    expect(Array.from(index.search(new Float32Array([0, 0]), 2))).toEqual([2]);
    index.delete(2);
    expect(index.getEntryDocId()).toBe(1);
    expect(index.getMaxLevel()).toBe(1);
    expect(Array.from(index.takeDirtyNodes())).toEqual([]);
  });

  it('connects a new live entry through an entirely tombstoned graph', () => {
    index.importNode(1, 0, new Float32Array([0, 0]), true);
    index.importFinish(1, 0);
    index.insert(2, new Float32Array([1, 0]));
    expect(Array.from(index.getNeighbors(1, 0))).toContain(2);
    expect(Array.from(index.getNeighbors(2, 0))).toContain(1);
    expect(Array.from(index.search(new Float32Array([1, 0]), 2))).toEqual([2]);
  });

  it('relabels live and deleted routing identities without changing topology or live counts', () => {
    index.importNode(1, 1, new Float32Array([0, 0]), true);
    index.importNode(2, 0, new Float32Array([1, 0]), false);
    index.importSetNeighbors(1, 0, [2]);
    index.importSetNeighbors(2, 0, [1]);
    index.importFinish(1, 1);
    expect(index.relabelDocument(2, 1)).toBe(false);
    expect(index.relabelDocument(999, 3)).toBe(false);
    expect(index.relabelDocument(2, 20)).toBe(true);
    expect(index.relabelDocument(1, 10)).toBe(true);
    expect(index.relabelDocument(10, 10)).toBe(true);
    expect(index.getEntryDocId()).toBe(10);
    expect(index.getMaxLevel()).toBe(1);
    expect(index.getLevel(1)).toBe(-1);
    expect(Array.from(index.getNeighbors(10, 0))).toEqual([20]);
    expect(Array.from(index.getNeighbors(20, 0))).toEqual([10]);
    expect(index.size).toBe(1);
    expect(index.search(new Float32Array([0, 0]), 2)).toEqual([20]);
    expect(index.delete(2)).toBe(false);
    expect(index.delete(20)).toBe(true);
    expect(index.size).toBe(0);
    expect(index.relabelDocument(10, 20)).toBe(false);
  });

  it('traverses a distant deleted bridge until the live search beam has filled', () => {
    index.importNode(1, 0, new Float32Array([10, 0]), true);
    index.importNode(2, 0, new Float32Array([0, 0]), false);
    index.importNode(3, 0, new Float32Array([20, 0]), true);
    index.importNode(4, 0, new Float32Array([1, 0]), false);
    index.importSetNeighbors(1, 0, [2, 3]);
    index.importSetNeighbors(2, 0, [1]);
    index.importSetNeighbors(3, 0, [1, 4]);
    index.importSetNeighbors(4, 0, [3]);
    index.importFinish(1, 0);
    expect(index.search(new Float32Array([0, 0]), 2)).toEqual([2, 4]);
  });

  it('rejects malformed vectors before native calls and remains usable after validation failures', () => {
    expect(() => index.insert(1, new Float32Array([0]))).toThrow('dimension mismatch');
    expect(() => index.importNode(1, 0, new Float32Array([0, NaN]), false)).toThrow('finite');
    expect(index.size).toBe(0);
    index.insert(1, new Float32Array([0, 0]));
    expect(() => index.search(new Float32Array([0]), 1)).toThrow('dimension mismatch');
    expect(() => index.search(new Float32Array([Infinity, 0]), 1)).toThrow('finite');
    expect(index.search(new Float32Array([0, 0]), 1)).toEqual([1]);
  });
});
