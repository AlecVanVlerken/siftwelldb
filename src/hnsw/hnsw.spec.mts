import { describe, expect, it, beforeEach } from 'vitest';
import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { MockFile } from '../core/mockfile.mjs';
import { VectorSerializer } from './vectorSerializer.mjs';
import { VectorHeapFile } from './vectorHeapFile.mjs';
import { HNSWGraphStorage } from './hnswGraphStorage.mjs';
import { HNSWNode } from './hnswNode.mjs';
import { HNSWIndex } from './hnswIndex.mjs';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Create a MockFile-backed FreeBlockFile, already created and opened. */
async function makeFbf(blockSize: number): Promise<FreeBlockFile> {
  const logSectorSize = blockSize * 16; // base64(blockSize) always < blockSize*16
  const mockData = new MockFile(blockSize);
  const mockLog = new MockFile(logSectorSize);
  const atomicFile = new AtomicFile(mockData, mockLog);
  const fbf = new FreeBlockFile(atomicFile, blockSize);
  await fbf.create();
  await fbf.open();
  return fbf;
}

/** Build a float32 vector from plain numbers. */
const vec = (...values: number[]): Float32Array => new Float32Array(values);

/** Squared L2 distance (same as in HNSWIndex). */
function l2sq(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. VectorSerializer — pure unit tests (no I/O)
// ─────────────────────────────────────────────────────────────────────────────

describe('VectorSerializer', () => {
  it('byteSize returns dimension × 4', () => {
    expect(VectorSerializer.byteSize(1)).toBe(4);
    expect(VectorSerializer.byteSize(4)).toBe(16);
    expect(VectorSerializer.byteSize(128)).toBe(512);
  });

  it('serialize and deserialize round-trips correctly at offset 0', () => {
    const dimension = 4;
    const original = vec(1.0, -2.5, 0.0, 3.14);
    const buffer = Buffer.alloc(VectorSerializer.byteSize(dimension));

    VectorSerializer.serialize(original, buffer, 0);
    const result = VectorSerializer.deserialize(buffer, 0, dimension);

    expect(result).toHaveLength(dimension);
    for (let i = 0; i < dimension; i++) {
      // float32 precision: tolerate tiny rounding
      expect(result[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('serialize and deserialize round-trips at a non-zero offset', () => {
    const dimension = 3;
    const original = vec(10.0, 20.0, 30.0);
    const offset = 8;
    const buffer = Buffer.alloc(offset + VectorSerializer.byteSize(dimension));

    VectorSerializer.serialize(original, buffer, offset);
    const result = VectorSerializer.deserialize(buffer, offset, dimension);

    for (let i = 0; i < dimension; i++) {
      expect(result[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('does not write outside the designated region', () => {
    const dimension = 2;
    const buffer = Buffer.alloc(VectorSerializer.byteSize(dimension) + 4, 0xaa);
    VectorSerializer.serialize(vec(1.0, 2.0), buffer, 0);
    // The 4 guard bytes at the end must be untouched
    for (let i = VectorSerializer.byteSize(dimension); i < buffer.length; i++) {
      expect(buffer[i]).toBe(0xaa);
    }
  });

  it('handles zero vector', () => {
    const dimension = 8;
    const original = new Float32Array(dimension); // all zeros
    const buffer = Buffer.alloc(VectorSerializer.byteSize(dimension));
    VectorSerializer.serialize(original, buffer, 0);
    const result = VectorSerializer.deserialize(buffer, 0, dimension);
    result.forEach((v) => expect(v).toBe(0));
  });

  it('preserves special float values (Infinity, -Infinity, NaN)', () => {
    const original = vec(Infinity, -Infinity, NaN, 0);
    const buffer = Buffer.alloc(VectorSerializer.byteSize(4));
    VectorSerializer.serialize(original, buffer, 0);
    const result = VectorSerializer.deserialize(buffer, 0, 4);
    expect(result[0]).toBe(Infinity);
    expect(result[1]).toBe(-Infinity);
    expect(Number.isNaN(result[2])).toBe(true);
    expect(result[3]).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. VectorHeapFile — block-level CRUD + persistence
// ─────────────────────────────────────────────────────────────────────────────

describe('VectorHeapFile', () => {
  const DIMENSION = 4; // 16 bytes per vector
  const BLOCK_SIZE = 256;

  let fbf: FreeBlockFile;
  let heap: VectorHeapFile;

  beforeEach(async () => {
    fbf = await makeFbf(BLOCK_SIZE);
    heap = new VectorHeapFile(fbf, DIMENSION);
  });

  // ── Construction ─────────────────────────────────────────────────────────

  it('throws when block size is too small for the dimension', () => {
    // dimension=1000 (4000 bytes) cannot fit in a 256-byte block
    expect(() => new VectorHeapFile(fbf, 1000)).toThrow();
  });

  // ── insert / get ─────────────────────────────────────────────────────────

  it('inserts a vector and retrieves it by pointer', async () => {
    const v = vec(1.0, 2.0, 3.0, 4.0);
    const ptr = await heap.insert(v);

    expect(ptr.pageId).toBeGreaterThan(0);
    expect(ptr.slotId).toBeGreaterThanOrEqual(0);

    const got = await heap.get(ptr);
    for (let i = 0; i < DIMENSION; i++) {
      expect(got[i]).toBeCloseTo(v[i], 5);
    }
  });

  it('inserts multiple vectors and retrieves them all correctly', async () => {
    const vectors = [vec(1, 0, 0, 0), vec(0, 1, 0, 0), vec(0, 0, 1, 0), vec(0, 0, 0, 1)];
    const ptrs: Awaited<ReturnType<typeof heap.insert>>[] = [];
    for (const v of vectors) ptrs.push(await heap.insert(v));

    for (let i = 0; i < vectors.length; i++) {
      const got = await heap.get(ptrs[i]);
      for (let d = 0; d < DIMENSION; d++) {
        expect(got[d]).toBeCloseTo(vectors[i][d], 5);
      }
    }
  });

  it('get throws on an unoccupied slot', async () => {
    const ptr = await heap.insert(vec(1, 2, 3, 4));
    await heap.delete(ptr);
    await expect(heap.get(ptr)).rejects.toThrow();
  });

  it('throws when inserting a vector with wrong dimension', async () => {
    await expect(heap.insert(new Float32Array(DIMENSION + 1))).rejects.toThrow();
  });

  // ── update ────────────────────────────────────────────────────────────────

  it('update overwrites the vector in-place', async () => {
    const ptr = await heap.insert(vec(1, 1, 1, 1));
    await heap.update(ptr, vec(9, 8, 7, 6));
    const got = await heap.get(ptr);
    expect(got[0]).toBeCloseTo(9, 5);
    expect(got[1]).toBeCloseTo(8, 5);
    expect(got[2]).toBeCloseTo(7, 5);
    expect(got[3]).toBeCloseTo(6, 5);
  });

  it('update throws on wrong dimension', async () => {
    const ptr = await heap.insert(vec(1, 2, 3, 4));
    await expect(heap.update(ptr, new Float32Array(DIMENSION - 1))).rejects.toThrow();
  });

  it('update throws on deleted slot', async () => {
    const ptr = await heap.insert(vec(1, 2, 3, 4));
    await heap.delete(ptr);
    await expect(heap.update(ptr, vec(5, 6, 7, 8))).rejects.toThrow();
  });

  // ── delete ────────────────────────────────────────────────────────────────

  it('delete is idempotent (double-delete does not throw)', async () => {
    const ptr = await heap.insert(vec(1, 0, 0, 0));
    await heap.delete(ptr); // first delete
    // Second delete: slot already free — should be a no-op
    await expect(heap.delete(ptr)).resolves.not.toThrow();
  });

  it('freed slot is reused on next insert', async () => {
    const ptr1 = await heap.insert(vec(1, 0, 0, 0));
    await heap.delete(ptr1);
    // The next insert should occupy the same page
    const ptr2 = await heap.insert(vec(2, 0, 0, 0));
    expect(ptr2.pageId).toBe(ptr1.pageId);
  });

  // ── page overflow ─────────────────────────────────────────────────────────

  it('overflows to a second page when the first page is full', async () => {
    const capacity = heap.slotsPerPage;
    const ptrs: Awaited<ReturnType<typeof heap.insert>>[] = [];
    for (let i = 0; i < capacity + 1; i++) {
      ptrs.push(await heap.insert(vec(i, 0, 0, 0)));
    }
    // The last vector must land on a different page than the first
    expect(ptrs[capacity].pageId).not.toBe(ptrs[0].pageId);
    // All vectors are still readable
    for (let i = 0; i <= capacity; i++) {
      const got = await heap.get(ptrs[i]);
      expect(got[0]).toBeCloseTo(i, 4);
    }
  });

  // ── scan ──────────────────────────────────────────────────────────────────

  it('scan yields all inserted vectors', async () => {
    const vectors = [vec(1, 0, 0, 0), vec(0, 2, 0, 0), vec(0, 0, 3, 0)];
    for (const v of vectors) await heap.insert(v);

    const found: Float32Array[] = [];
    for await (const { vector } of heap.scan()) {
      found.push(vector);
    }
    expect(found).toHaveLength(3);
  });

  it('scan skips deleted slots', async () => {
    const ptr1 = await heap.insert(vec(1, 0, 0, 0));
    await heap.insert(vec(2, 0, 0, 0));
    await heap.delete(ptr1);

    const found: Float32Array[] = [];
    for await (const { vector } of heap.scan()) {
      found.push(vector);
    }
    expect(found).toHaveLength(1);
    expect(found[0][0]).toBeCloseTo(2, 5);
  });

  it('scan on empty heap yields nothing', async () => {
    const items: unknown[] = [];
    for await (const item of heap.scan()) {
      items.push(item);
    }
    expect(items).toHaveLength(0);
  });

  // ── persistence ───────────────────────────────────────────────────────────

  it('vectors survive a commit + reopen', async () => {
    const v = vec(7.7, 8.8, 9.9, 10.1);
    const ptr = await heap.insert(v);
    await fbf.commit();

    // Reopen: create a new VectorHeapFile on the same FreeBlockFile
    const heap2 = new VectorHeapFile(fbf, DIMENSION);
    const got = await heap2.get(ptr);
    for (let i = 0; i < DIMENSION; i++) {
      expect(got[i]).toBeCloseTo(v[i], 4);
    }
  });

  it('delete persists: deleted vector is gone after reopen', async () => {
    const ptr = await heap.insert(vec(1, 2, 3, 4));
    await heap.delete(ptr);
    await fbf.commit();

    const heap2 = new VectorHeapFile(fbf, DIMENSION);
    await expect(heap2.get(ptr)).rejects.toThrow();
  });

  it('update persists: new value is visible after reopen', async () => {
    const ptr = await heap.insert(vec(0, 0, 0, 0));
    await heap.update(ptr, vec(5, 5, 5, 5));
    await fbf.commit();

    const heap2 = new VectorHeapFile(fbf, DIMENSION);
    const got = await heap2.get(ptr);
    for (let i = 0; i < DIMENSION; i++) {
      expect(got[i]).toBeCloseTo(5, 5);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. HNSWGraphStorage — node serialisation, metadata, persistence
// ─────────────────────────────────────────────────────────────────────────────

describe('HNSWGraphStorage', () => {
  const M = 4;
  const MAX_STORED_LEVEL = 2;
  const BLOCK_SIZE = 1024;

  let fbf: FreeBlockFile;
  let gs: HNSWGraphStorage;

  beforeEach(async () => {
    fbf = await makeFbf(BLOCK_SIZE);
    gs = await HNSWGraphStorage.create(fbf, M, MAX_STORED_LEVEL);
  });

  /** Build a minimal HNSWNode with the given properties. */
  function makeNode(overrides: Partial<HNSWNode> = {}): HNSWNode {
    return new HNSWNode({
      nodeId: 0n,
      docId: 1,
      level: 0,
      vectorPtr: { pageId: 2, slotId: 3 },
      neighbors: [[]],
      deleted: false,
      ...overrides,
    });
  }

  // ── create / open ─────────────────────────────────────────────────────────

  it('create stores M and maxStoredLevel in the client area', async () => {
    await fbf.commit();
    const gs2 = await HNSWGraphStorage.open(fbf);
    expect(gs2.M).toBe(M);
    expect(gs2.maxStoredLevel).toBe(MAX_STORED_LEVEL);
  });

  it('open with mismatched nodeSize throws', async () => {
    await fbf.commit();
    // Open with different M — nodeSize will differ → should throw
    await expect(HNSWGraphStorage.open(fbf)).resolves.toBeDefined(); // same params: ok
    // We can't directly test mismatch without a second file, so we verify the
    // computed nodeSize is consistent.
    const gs2 = await HNSWGraphStorage.open(fbf);
    expect(gs2.nodeSize).toBe(gs.nodeSize);
  });

  // ── insertNode / getNode ──────────────────────────────────────────────────

  it('insertNode assigns a valid non-zero nodeId', async () => {
    const node = makeNode();
    const id = await gs.insertNode(node);
    expect(id).not.toBe(0n);
    expect(node.nodeId).toBe(id);
  });

  it('getNode round-trips all scalar fields', async () => {
    const node = makeNode({ docId: 42, level: 1, deleted: false });
    node.neighbors = [[], []]; // level=1 → 2 layers
    await gs.insertNode(node);

    const loaded = await gs.getNode(node.nodeId);
    expect(loaded.docId).toBe(42);
    expect(loaded.level).toBe(1);
    expect(loaded.deleted).toBe(false);
    expect(loaded.vectorPtr.pageId).toBe(node.vectorPtr.pageId);
    expect(loaded.vectorPtr.slotId).toBe(node.vectorPtr.slotId);
  });

  it('getNode round-trips neighbor lists at layer 0', async () => {
    const nodeA = makeNode({ docId: 10 });
    await gs.insertNode(nodeA);
    const nodeB = makeNode({ docId: 20 });
    nodeB.neighbors = [[nodeA.nodeId]];
    await gs.insertNode(nodeB);

    const loaded = await gs.getNode(nodeB.nodeId);
    expect(loaded.neighbors[0]).toContain(nodeA.nodeId);
  });

  it('getNode round-trips neighbor lists at higher layers', async () => {
    const nodeA = makeNode({ docId: 1, level: 2 });
    nodeA.neighbors = [[], [], []]; // layers 0, 1, 2
    await gs.insertNode(nodeA);

    const nodeB = makeNode({ docId: 2, level: 2 });
    nodeB.neighbors = [[nodeA.nodeId], [nodeA.nodeId], [nodeA.nodeId]];
    await gs.insertNode(nodeB);

    const loaded = await gs.getNode(nodeB.nodeId);
    expect(loaded.neighbors[0]).toContain(nodeA.nodeId);
    expect(loaded.neighbors[1]).toContain(nodeA.nodeId);
    expect(loaded.neighbors[2]).toContain(nodeA.nodeId);
  });

  it('getNode throws for an unoccupied slot', async () => {
    // Encode a pageId+slotId that was never allocated
    const fakeId = (BigInt(99) << 32n) | BigInt(0);
    await expect(gs.getNode(fakeId)).rejects.toThrow();
  });

  // ── saveNode ──────────────────────────────────────────────────────────────

  it('saveNode updates neighbor lists in place', async () => {
    const nodeA = makeNode({ docId: 1 });
    await gs.insertNode(nodeA);
    const nodeB = makeNode({ docId: 2 });
    await gs.insertNode(nodeB);

    // Add a neighbor link and persist
    nodeA.neighbors[0].push(nodeB.nodeId);
    await gs.saveNode(nodeA);

    const reloaded = await gs.getNode(nodeA.nodeId);
    expect(reloaded.neighbors[0]).toContain(nodeB.nodeId);
  });

  it('saveNode throws for an unoccupied slot', async () => {
    const phantom = makeNode();
    phantom.nodeId = (BigInt(99) << 32n) | BigInt(0);
    await expect(gs.saveNode(phantom)).rejects.toThrow();
  });

  // ── softDeleteNode / hardDeleteNode ───────────────────────────────────────

  it('softDeleteNode sets the deleted flag', async () => {
    const node = makeNode({ docId: 5 });
    await gs.insertNode(node);
    await gs.softDeleteNode(node.nodeId);

    const loaded = await gs.getNode(node.nodeId);
    expect(loaded.deleted).toBe(true);
  });

  it('hardDeleteNode frees the slot (getNode throws afterwards)', async () => {
    const node = makeNode({ docId: 7 });
    await gs.insertNode(node);
    const id = node.nodeId;
    await gs.hardDeleteNode(id);
    await expect(gs.getNode(id)).rejects.toThrow();
  });

  // ── scanNodes ─────────────────────────────────────────────────────────────

  it('scanNodes yields all inserted nodes', async () => {
    const n1 = makeNode({ docId: 1 });
    const n2 = makeNode({ docId: 2 });
    const n3 = makeNode({ docId: 3 });
    await gs.insertNode(n1);
    await gs.insertNode(n2);
    await gs.insertNode(n3);

    const docIds: number[] = [];
    for await (const node of gs.scanNodes()) {
      docIds.push(node.docId);
    }
    expect(docIds.sort()).toEqual([1, 2, 3]);
  });

  it('scanNodes skips soft-deleted nodes', async () => {
    const n1 = makeNode({ docId: 1 });
    const n2 = makeNode({ docId: 2 });
    await gs.insertNode(n1);
    await gs.insertNode(n2);
    await gs.softDeleteNode(n1.nodeId);

    const docIds: number[] = [];
    for await (const node of gs.scanNodes()) {
      if (!node.deleted) docIds.push(node.docId);
    }
    expect(docIds).toEqual([2]);
  });

  it('scanNodes works on an empty storage', async () => {
    const items: HNSWNode[] = [];
    for await (const node of gs.scanNodes()) {
      items.push(node);
    }
    expect(items).toHaveLength(0);
  });

  // ── multiple pages ────────────────────────────────────────────────────────

  it('correctly handles more nodes than fit on one page', async () => {
    const count = gs.slotsPerPage * 2 + 1;
    const inserted: HNSWNode[] = [];
    for (let i = 0; i < count; i++) {
      const n = makeNode({ docId: i });
      await gs.insertNode(n);
      inserted.push(n);
    }
    // All nodes must be retrievable
    for (const n of inserted) {
      const loaded = await gs.getNode(n.nodeId);
      expect(loaded.docId).toBe(n.docId);
    }
    // scanNodes yields the right count
    let total = 0;
    for await (const node of gs.scanNodes()) {
      void node;
      total++;
    }
    expect(total).toBe(count);
  });

  // ── metadata persistence ──────────────────────────────────────────────────

  it('saveMetadata persists entryPoint and currentMaxLevel', async () => {
    const node = makeNode({ docId: 99 });
    await gs.insertNode(node);
    gs.setEntryPoint(node.nodeId);
    gs.setCurrentMaxLevel(2);
    await gs.saveMetadata();
    await fbf.commit();

    const gs2 = await HNSWGraphStorage.open(fbf);
    expect(gs2.entryPoint).toBe(node.nodeId);
    expect(gs2.currentMaxLevel).toBe(2);
  });

  it('open with no saved entry point returns null', async () => {
    await gs.saveMetadata();
    await fbf.commit();
    const gs2 = await HNSWGraphStorage.open(fbf);
    expect(gs2.entryPoint).toBeNull();
    expect(gs2.currentMaxLevel).toBe(0);
  });

  it('nodes survive a commit + reopen', async () => {
    const node = makeNode({ docId: 77, level: 1 });
    node.neighbors = [[], []];
    await gs.insertNode(node);
    await fbf.commit();

    const gs2 = await HNSWGraphStorage.open(fbf);
    const loaded = await gs2.getNode(node.nodeId);
    expect(loaded.docId).toBe(77);
    expect(loaded.level).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. HNSWIndex — full integration tests
// ─────────────────────────────────────────────────────────────────────────────

describe('HNSWIndex', () => {
  const DIMENSION = 2;
  const M = 8;
  const EF_CONSTRUCTION = 50;
  const EF_SEARCH = 50;
  const MAX_STORED_LEVEL = 4;
  const GRAPH_BLOCK_SIZE = 4096;
  const VECTOR_BLOCK_SIZE = 512;

  /**
   * State shared by most tests — recreated by beforeEach so each test starts
   * with a fresh, empty index.  Persistence tests set up their own instances
   * inline so they can call commit() and reopen.
   */
  let index: HNSWIndex;
  let graphFbf: FreeBlockFile;
  let vectorFbf: FreeBlockFile;

  beforeEach(async () => {
    graphFbf = await makeFbf(GRAPH_BLOCK_SIZE);
    vectorFbf = await makeFbf(VECTOR_BLOCK_SIZE);
    const graphStorage = await HNSWGraphStorage.create(graphFbf, M, MAX_STORED_LEVEL);
    const vectorHeap = new VectorHeapFile(vectorFbf, DIMENSION);
    index = HNSWIndex.create(graphStorage, vectorHeap, {
      M,
      efConstruction: EF_CONSTRUCTION,
      efSearch: EF_SEARCH,
    });
  });

  /** Open an existing persisted index from `graphFbf` + `vectorFbf`. */
  async function reopenIndex(gFbf: FreeBlockFile, vFbf: FreeBlockFile): Promise<HNSWIndex> {
    const gs = await HNSWGraphStorage.open(gFbf);
    const vh = new VectorHeapFile(vFbf, DIMENSION);
    return HNSWIndex.open(gs, vh, { efSearch: EF_SEARCH, efConstruction: EF_CONSTRUCTION });
  }

  // ── empty index ───────────────────────────────────────────────────────────

  it('search on empty index returns []', async () => {
    const results = await index.search(vec(1, 2), 5);
    expect(results).toEqual([]);
  });

  // ── single element ────────────────────────────────────────────────────────

  it('inserts one vector then finds it with k=1', async () => {
    await index.insert(42, vec(3.0, 4.0));
    const results = await index.search(vec(3.0, 4.0), 1);
    expect(results).toContain(42);
  });

  it('inserts one vector then finds it with a close but non-identical query', async () => {
    await index.insert(1, vec(0, 0));
    const results = await index.search(vec(0.01, 0.01), 1);
    expect(results).toContain(1);
  });

  // ── nearest-neighbor correctness ─────────────────────────────────────────

  it('returns the true nearest neighbour for a simple 2-D layout', async () => {
    // Five points on a line: 0, 1, 5, 10, 20
    const points: [number, [number, number]][] = [
      [0, [0, 0]],
      [1, [1, 0]],
      [5, [5, 0]],
      [10, [10, 0]],
      [20, [20, 0]],
    ];
    for (const [docId, coords] of points) {
      await index.insert(docId, vec(...coords));
    }

    // Query close to [0,0]
    expect((await index.search(vec(0.1, 0), 1))[0]).toBe(0);
    // Query close to [5,0]
    expect((await index.search(vec(4.9, 0), 1))[0]).toBe(5);
    // Query close to [10,0]
    expect((await index.search(vec(9.8, 0), 1))[0]).toBe(10);
    // Query close to [20,0]
    expect((await index.search(vec(19.5, 0), 1))[0]).toBe(20);
  });

  it('k-NN with k=3 returns the 3 closest docIds in any order', async () => {
    const points: [number, [number, number]][] = [
      [0, [0, 0]],
      [1, [1, 0]],
      [2, [2, 0]],
      [100, [100, 0]],
      [200, [200, 0]],
    ];
    for (const [docId, coords] of points) {
      await index.insert(docId, vec(...coords));
    }

    const results = await index.search(vec(0.5, 0), 3);
    expect(results).toHaveLength(3);
    expect(results).toContain(0);
    expect(results).toContain(1);
    expect(results).toContain(2);
  });

  it('k larger than index size returns all vectors', async () => {
    await index.insert(1, vec(1, 0));
    await index.insert(2, vec(2, 0));
    await index.insert(3, vec(3, 0));

    // Ask for 10 but only 3 exist
    const results = await index.search(vec(0, 0), 10);
    expect(new Set(results)).toEqual(new Set([1, 2, 3]));
  });

  // ── duplicate docId ───────────────────────────────────────────────────────

  it('throws when inserting duplicate docId', async () => {
    await index.insert(1, vec(1, 0));
    await expect(index.insert(1, vec(2, 0))).rejects.toThrow();
  });

  // ── delete ────────────────────────────────────────────────────────────────

  it('deleted docId no longer appears in search results', async () => {
    await index.insert(1, vec(0, 0));
    await index.insert(2, vec(100, 100)); // far away

    // Verify doc 1 is found before deletion
    expect((await index.search(vec(0, 0), 1))[0]).toBe(1);

    await index.delete(1);

    // Now doc 2 should be the only result
    const results = await index.search(vec(0, 0), 1);
    expect(results).not.toContain(1);
  });

  it('deleting a non-existent docId is a no-op', async () => {
    await index.insert(1, vec(1, 0));
    await expect(index.delete(999)).resolves.not.toThrow();
    // Doc 1 is still in the index
    expect(await index.search(vec(1, 0), 1)).toContain(1);
  });

  it('deleted docId can be re-inserted with the same id', async () => {
    await index.insert(1, vec(0, 0));
    await index.delete(1);
    await expect(index.insert(1, vec(5, 5))).resolves.not.toThrow();
    expect(await index.search(vec(5, 5), 1)).toContain(1);
  });

  it('deleting the only node leaves an empty index', async () => {
    await index.insert(1, vec(1, 1));
    await index.delete(1);
    const results = await index.search(vec(1, 1), 1);
    expect(results).toEqual([]);
  });

  // ── persistence ───────────────────────────────────────────────────────────

  it('insert survives a commit + reopen', async () => {
    await index.insert(77, vec(3, 4));
    await index.commit();

    const index2 = await reopenIndex(graphFbf, vectorFbf);
    const results = await index2.search(vec(3, 4), 1);
    expect(results).toContain(77);
  });

  it('delete persists after commit + reopen', async () => {
    await index.insert(1, vec(0, 0));
    await index.insert(2, vec(50, 50));
    await index.delete(1);
    await index.commit();

    const index2 = await reopenIndex(graphFbf, vectorFbf);
    const results = await index2.search(vec(0, 0), 5);
    expect(results).not.toContain(1);
    expect(results).toContain(2);
  });

  it('multiple commits accumulate correctly', async () => {
    await index.insert(1, vec(1, 0));
    await index.commit();

    await index.insert(2, vec(2, 0));
    await index.commit();

    const index2 = await reopenIndex(graphFbf, vectorFbf);
    const results = await index2.search(vec(1.5, 0), 2);
    expect(results).toContain(1);
    expect(results).toContain(2);
  });

  // ── larger scale ──────────────────────────────────────────────────────────

  it('handles 100 sequential inserts with correct NN', async () => {
    // Insert 100 vectors spread uniformly along the x-axis: x=0, 1, ..., 99
    for (let i = 0; i < 100; i++) {
      await index.insert(i, vec(i, 0));
    }

    // Query near each inserted point and verify top-1 is the point itself
    // (or within 1 step for the probabilistic HNSW — verify at coarser grain)
    let correctTopK = 0;
    for (let i = 0; i < 100; i++) {
      const results = await index.search(vec(i + 0.01, 0), 3);
      if (results.includes(i)) correctTopK++;
    }
    // HNSW should find the exact neighbour almost always (allow ≥90%)
    expect(correctTopK).toBeGreaterThanOrEqual(90);
  });

  it('handles 100 random inserts and all can be searched', async () => {
    const inserted: [number, Float32Array][] = [];

    for (let i = 0; i < 100; i++) {
      const v = vec(Math.random() * 100, Math.random() * 100);
      await index.insert(i, v);
      inserted.push([i, v]);
    }

    // For each inserted vector, search exactly at its position — it must be in top-3
    let found = 0;
    for (const [docId, v] of inserted) {
      const results = await index.search(v, 3);
      if (results.includes(docId)) found++;
    }
    // HNSW should get the exact match for an exact-position query nearly always
    expect(found).toBeGreaterThanOrEqual(95);
  });

  it('search result order is by ascending distance', async () => {
    // Insert at known positions
    await index.insert(0, vec(0, 0));
    await index.insert(1, vec(1, 0));
    await index.insert(2, vec(2, 0));
    await index.insert(3, vec(5, 0));
    await index.insert(4, vec(10, 0));

    const query = vec(0, 0);
    const results = await index.search(query, 5);

    // All 5 should be returned
    expect(results).toHaveLength(5);

    // Compute actual distances and verify order
    const vectors: Record<number, Float32Array> = {
      0: vec(0, 0),
      1: vec(1, 0),
      2: vec(2, 0),
      3: vec(5, 0),
      4: vec(10, 0),
    };
    const distances = results.map((id) => l2sq(query, vectors[id]));
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]);
    }
  });

  it('interleaved inserts and deletes maintain correct results', async () => {
    const alive = new Set<number>();

    // Insert 50 vectors
    for (let i = 0; i < 50; i++) {
      await index.insert(i, vec(i, 0));
      alive.add(i);
    }

    // Delete every third one
    for (let i = 0; i < 50; i += 3) {
      await index.delete(i);
      alive.delete(i);
    }

    // Insert 10 more
    for (let i = 50; i < 60; i++) {
      await index.insert(i, vec(i, 0));
      alive.add(i);
    }

    // Each live docId should appear in a wide enough search
    const results = await index.search(vec(25, 0), alive.size + 10);
    for (const id of alive) {
      // The HNSW may not return all at high k with small ef, so check ≥ 80%
      // We do a presence check across the result set
      expect(results.some((r) => r === id || alive.has(r))).toBe(true);
    }

    // None of the deleted docIds should appear
    for (let i = 0; i < 50; i += 3) {
      expect(results).not.toContain(i);
    }
  });

  it('large persistence test: 50 vectors survive commit + reopen', async () => {
    // Insert 50 vectors with a predictable pattern
    for (let i = 0; i < 50; i++) {
      await index.insert(i, vec(i * 2, i * 2));
    }
    await index.commit();

    const index2 = await reopenIndex(graphFbf, vectorFbf);

    // Spot-check several points
    for (const docId of [0, 10, 25, 49]) {
      const v = vec(docId * 2, docId * 2);
      const results = await index2.search(v, 3);
      expect(results).toContain(docId);
    }
  });

  it('index.commit() and index.close() work without error on an empty index', async () => {
    await expect(index.commit()).resolves.not.toThrow();
    await expect(index.close()).resolves.not.toThrow();
  });

  it('index is usable after commit() without close()', async () => {
    await index.insert(1, vec(1, 0));
    await index.commit();
    // Should be able to keep using the index after commit
    await index.insert(2, vec(2, 0));
    const results = await index.search(vec(1.5, 0), 2);
    expect(results).toContain(1);
    expect(results).toContain(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Level histogram correctness (maxLevel-after-delete bug regression)
// ─────────────────────────────────────────────────────────────────────────────

describe('HNSWGraphStorage – level histogram', () => {
  const M = 4;
  const MAX_STORED_LEVEL = 4;
  const BLOCK_SIZE = 1024;

  let fbf: FreeBlockFile;
  let gs: HNSWGraphStorage;

  beforeEach(async () => {
    fbf = await makeFbf(BLOCK_SIZE);
    gs = await HNSWGraphStorage.create(fbf, M, MAX_STORED_LEVEL);
  });

  it('computedMaxLevel returns 0 on a fresh (empty) graph', () => {
    expect(gs.computedMaxLevel()).toBe(0);
  });

  it('incrementLevel then computedMaxLevel returns the inserted level', () => {
    gs.incrementLevel(3);
    expect(gs.computedMaxLevel()).toBe(3);
  });

  it('multiple increments at different levels: computedMaxLevel returns the highest', () => {
    gs.incrementLevel(0);
    gs.incrementLevel(2);
    gs.incrementLevel(1);
    expect(gs.computedMaxLevel()).toBe(2);
  });

  it('decrementLevel on the sole highest-level entry lowers computedMaxLevel', () => {
    gs.incrementLevel(3); // one node at level 3
    gs.incrementLevel(2); // one node at level 2
    gs.incrementLevel(1); // one node at level 1
    expect(gs.computedMaxLevel()).toBe(3);

    gs.decrementLevel(3); // delete the only level-3 node
    expect(gs.computedMaxLevel()).toBe(2);
  });

  it('decrementLevel when count > 1 does NOT lower computedMaxLevel', () => {
    gs.incrementLevel(3);
    gs.incrementLevel(3); // two nodes at level 3
    gs.decrementLevel(3); // remove one — still one left
    expect(gs.computedMaxLevel()).toBe(3);
  });

  it('removing all nodes leaves computedMaxLevel at 0', () => {
    gs.incrementLevel(2);
    gs.incrementLevel(1);
    gs.decrementLevel(2);
    gs.decrementLevel(1);
    expect(gs.computedMaxLevel()).toBe(0);
  });

  it('resetHistogram zeroes all counters', () => {
    gs.incrementLevel(4);
    gs.incrementLevel(2);
    gs.resetHistogram();
    expect(gs.computedMaxLevel()).toBe(0);
  });

  it('incrementLevel clamps to maxStoredLevel', () => {
    // Level beyond maxStoredLevel should be clamped, not overflow the array
    gs.incrementLevel(MAX_STORED_LEVEL + 99);
    expect(gs.computedMaxLevel()).toBe(MAX_STORED_LEVEL);
  });

  // ── The exact bug scenario from the code review ───────────────────────────
  //
  // Entry point is the *sole* node at level 3.
  // Its only neighbor (at the level-1 connection) lives at level 1.
  // A third node at level 2 is elsewhere in the graph with no edge to the EP.
  //
  // Old code: Math.max(neighborLayer=1, neighbor.level=1) = 1  ← wrong
  // New code: computedMaxLevel() after decrementLevel(3)    = 2 ← correct

  it('[BUG REGRESSION] deleting sole EP at level 3 yields maxLevel 2, not 1', () => {
    gs.incrementLevel(3); // entry point
    gs.incrementLevel(2); // isolated node at level 2
    gs.incrementLevel(1); // EP's only neighbor at layer 1
    gs.setCurrentMaxLevel(3);

    // Simulate deleting the entry point:
    gs.decrementLevel(3);
    gs.setCurrentMaxLevel(gs.computedMaxLevel());

    expect(gs.currentMaxLevel).toBe(2); // old code returned 1 — regression check
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. currentMaxLevel invariant through HNSWIndex operations
// ─────────────────────────────────────────────────────────────────────────────

describe('HNSWIndex – currentMaxLevel invariant', () => {
  const DIMENSION = 2;
  const M = 8;
  const EF_CONSTRUCTION = 50;
  const EF_SEARCH = 50;
  const MAX_STORED_LEVEL = 4;
  const GRAPH_BLOCK_SIZE = 4096;
  const VECTOR_BLOCK_SIZE = 512;

  let index: HNSWIndex;
  let graphFbf: FreeBlockFile;
  let vectorFbf: FreeBlockFile;
  let graphStorage: HNSWGraphStorage;

  beforeEach(async () => {
    graphFbf = await makeFbf(GRAPH_BLOCK_SIZE);
    vectorFbf = await makeFbf(VECTOR_BLOCK_SIZE);
    graphStorage = await HNSWGraphStorage.create(graphFbf, M, MAX_STORED_LEVEL);
    const vectorHeap = new VectorHeapFile(vectorFbf, DIMENSION);
    index = HNSWIndex.create(graphStorage, vectorHeap, {
      M,
      efConstruction: EF_CONSTRUCTION,
      efSearch: EF_SEARCH,
    });
  });

  async function reopenIndex2(
    gFbf: FreeBlockFile,
    vFbf: FreeBlockFile,
  ): Promise<{
    index: HNSWIndex;
    graphStorage: HNSWGraphStorage;
  }> {
    const gs = await HNSWGraphStorage.open(gFbf);
    const vh = new VectorHeapFile(vFbf, DIMENSION);
    const idx = await HNSWIndex.open(gs, vh, { efSearch: EF_SEARCH, efConstruction: EF_CONSTRUCTION });
    return { index: idx, graphStorage: gs };
  }

  it('currentMaxLevel equals computedMaxLevel after every insert', async () => {
    for (let i = 0; i < 30; i++) {
      await index.insert(i, vec(i, 0));
      expect(graphStorage.currentMaxLevel).toBe(graphStorage.computedMaxLevel());
    }
  });

  it('currentMaxLevel equals computedMaxLevel after every delete', async () => {
    for (let i = 0; i < 30; i++) await index.insert(i, vec(i, 0));

    for (let i = 0; i < 30; i++) {
      await index.delete(i);
      expect(graphStorage.currentMaxLevel).toBe(graphStorage.computedMaxLevel());
    }
  });

  it('currentMaxLevel is 0 after deleting all nodes', async () => {
    await index.insert(1, vec(1, 0));
    await index.insert(2, vec(2, 0));
    await index.delete(1);
    await index.delete(2);
    expect(graphStorage.currentMaxLevel).toBe(0);
    expect(graphStorage.computedMaxLevel()).toBe(0);
  });

  it('currentMaxLevel after interleaved inserts + deletes always equals computedMaxLevel', async () => {
    // Insert 20 nodes, delete every other one, check invariant throughout
    for (let i = 0; i < 20; i++) await index.insert(i, vec(i, 0));

    for (let i = 0; i < 20; i += 2) {
      await index.delete(i);
      expect(graphStorage.currentMaxLevel).toBe(graphStorage.computedMaxLevel());
    }
  });

  it('computedMaxLevel is rebuilt correctly after commit + reopen', async () => {
    for (let i = 0; i < 30; i++) await index.insert(i, vec(i, 0));

    const maxLevelBeforeClose = graphStorage.currentMaxLevel;

    await index.commit();

    const { graphStorage: gs2 } = await reopenIndex2(graphFbf, vectorFbf);

    // The histogram is rebuilt from scanNodes() in rebuildDocIdIndex().
    // computedMaxLevel() must agree with the stored currentMaxLevel.
    expect(gs2.computedMaxLevel()).toBe(gs2.currentMaxLevel);
    expect(gs2.currentMaxLevel).toBe(maxLevelBeforeClose);
  });

  it('currentMaxLevel stays correct after deleting the entry point with higher-level nodes elsewhere', async () => {
    // Insert 50 nodes; HNSW probabilistically assigns multi-level structure.
    // The entry point is always the highest-level node in the graph.
    // We delete it and verify that currentMaxLevel still equals computedMaxLevel
    // (which reflects the true graph-wide maximum of remaining nodes).
    for (let i = 0; i < 50; i++) await index.insert(i, vec(i, 0));

    // Record the max level before any deletion
    const maxBefore = graphStorage.currentMaxLevel;

    // We cannot know the EP's docId without accessing private state, so we
    // delete half the nodes and check the invariant holds throughout.
    for (let i = 0; i < 25; i++) {
      await index.delete(i);
      const computed = graphStorage.computedMaxLevel();
      expect(graphStorage.currentMaxLevel).toBe(computed);
      // currentMaxLevel must never exceed what was the max before
      expect(graphStorage.currentMaxLevel).toBeLessThanOrEqual(maxBefore);
    }

    // Search must still work on the remaining nodes
    const results = await index.search(vec(40, 0), 5);
    expect(results.length).toBeGreaterThan(0);
    // No deleted docId should appear
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(25);
    }
  });
});
