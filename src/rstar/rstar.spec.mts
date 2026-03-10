import { describe, expect, it, beforeEach } from 'vitest';
import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { MockFile } from '../core/mockfile.mjs';
import { Rectangle } from './rstarRectangle.mjs';
import { RStarIndex } from './rstarIndex.mjs';
import { serializeRectangle, deserializeRectangle } from './rectangleSerializer.mjs';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Create a MockFile-backed FreeBlockFile, already created and opened. */
async function makeFbf(blockSize: number): Promise<FreeBlockFile> {
  const logSectorSize = blockSize * 16;
  const mockData = new MockFile(blockSize);
  const mockLog = new MockFile(logSectorSize);
  const atomicFile = new AtomicFile(mockData, mockLog);
  const fbf = new FreeBlockFile(atomicFile, blockSize);
  await fbf.create();
  return fbf;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rectangle tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Rectangle', () => {
  it('calculates area correctly', () => {
    const rect = new Rectangle(0, 0, 10, 5);
    expect(rect.area()).toBe(50);
  });

  it('detects intersection', () => {
    const r1 = new Rectangle(0, 0, 10, 10);
    const r2 = new Rectangle(5, 5, 15, 15);
    const r3 = new Rectangle(20, 20, 30, 30);

    expect(r1.intersects(r2)).toBe(true);
    expect(r2.intersects(r1)).toBe(true);
    expect(r1.intersects(r3)).toBe(false);
  });

  it('computes union correctly', () => {
    const r1 = new Rectangle(0, 0, 10, 10);
    const r2 = new Rectangle(5, 5, 15, 15);
    const union = r1.union(r2);

    expect(union.minX).toBe(0);
    expect(union.minY).toBe(0);
    expect(union.maxX).toBe(15);
    expect(union.maxY).toBe(15);
  });

  it('calculates enlargement correctly', () => {
    const r1 = new Rectangle(0, 0, 10, 10);
    const r2 = new Rectangle(5, 5, 15, 15);
    const enlargement = r1.enlargement(r2);

    // Union area = 15*15 = 225, original area = 10*10 = 100
    // Enlargement = 225 - 100 = 125
    expect(enlargement).toBe(125);
  });

  it('checks if contains point', () => {
    const rect = new Rectangle(0, 0, 10, 10);
    expect(rect.contains({ x: 5, y: 5 })).toBe(true);
    expect(rect.contains({ x: 0, y: 0 })).toBe(true);
    expect(rect.contains({ x: 10, y: 10 })).toBe(true);
    expect(rect.contains({ x: 15, y: 5 })).toBe(false);
  });

  it('checks equality', () => {
    const r1 = new Rectangle(0, 0, 10, 10);
    const r2 = new Rectangle(0, 0, 10, 10);
    const r3 = new Rectangle(0, 0, 10, 11);

    expect(r1.equals(r2)).toBe(true);
    expect(r1.equals(r3)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rectangle Serializer tests
// ─────────────────────────────────────────────────────────────────────────────

describe('RectangleSerializer', () => {
  it('serializes and deserializes correctly', () => {
    const original = new Rectangle(1.5, 2.5, 10.75, 20.25);
    const buffer = serializeRectangle(original);
    const deserialized = deserializeRectangle(buffer);

    expect(deserialized.minX).toBeCloseTo(original.minX, 10);
    expect(deserialized.minY).toBeCloseTo(original.minY, 10);
    expect(deserialized.maxX).toBeCloseTo(original.maxX, 10);
    expect(deserialized.maxY).toBeCloseTo(original.maxY, 10);
  });

  it('produces buffer of correct size', () => {
    const rect = new Rectangle(0, 0, 1, 1);
    const buffer = serializeRectangle(rect);
    expect(buffer.length).toBe(32); // 4 doubles * 8 bytes
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RStarIndex tests
// ─────────────────────────────────────────────────────────────────────────────

describe('RStarIndex', () => {
  let fbf: FreeBlockFile;
  let index: RStarIndex;

  beforeEach(async () => {
    fbf = await makeFbf(512);
    index = await RStarIndex.create(fbf, 10);
  });

  it('inserts and searches rectangles', async () => {
    const r1 = new Rectangle(0, 0, 10, 10);
    const r2 = new Rectangle(20, 20, 30, 30);
    const r3 = new Rectangle(5, 5, 15, 15);

    await index.insert(r1, 1);
    await index.insert(r2, 2);
    await index.insert(r3, 3);

    // Search for rectangles overlapping (4, 4, 8, 8)
    const query = new Rectangle(4, 4, 8, 8);
    const results = await index.search(query);

    // Should find r1 and r3
    expect(results.sort()).toEqual([1, 3]);
  });

  it('searches with non-overlapping query', async () => {
    const r1 = new Rectangle(0, 0, 10, 10);
    await index.insert(r1, 1);

    const query = new Rectangle(20, 20, 30, 30);
    const results = await index.search(query);

    expect(results).toEqual([]);
  });

  it('deletes rectangles', async () => {
    const r1 = new Rectangle(0, 0, 10, 10);
    const r2 = new Rectangle(20, 20, 30, 30);

    await index.insert(r1, 1);
    await index.insert(r2, 2);

    await index.delete(r1, 1);

    const query = new Rectangle(0, 0, 100, 100);
    const results = await index.search(query);

    expect(results).toEqual([2]);
  });

  it('handles many insertions', async () => {
    const count = 100;
    for (let i = 0; i < count; i++) {
      const x = i * 10;
      const y = i * 10;
      const rect = new Rectangle(x, y, x + 10, y + 10);
      await index.insert(rect, i);
    }

    // Search for rectangles around (50, 50)
    const query = new Rectangle(45, 45, 55, 55);
    const results = await index.search(query);

    expect(results.length).toBeGreaterThan(0);
    expect(results).toContain(5); // Rectangle at (50, 50, 60, 60)
  });

  it('handles overlapping rectangles', async () => {
    const r1 = new Rectangle(0, 0, 20, 20);
    const r2 = new Rectangle(10, 10, 30, 30);
    const r3 = new Rectangle(5, 5, 15, 15);

    await index.insert(r1, 1);
    await index.insert(r2, 2);
    await index.insert(r3, 3);

    // Search for rectangles overlapping (12, 12, 18, 18)
    const query = new Rectangle(12, 12, 18, 18);
    const results = await index.search(query);

    // All three should overlap
    expect(results.sort()).toEqual([1, 2, 3]);
  });

  it('can reopen index from disk', async () => {
    const r1 = new Rectangle(0, 0, 10, 10);
    const r2 = new Rectangle(20, 20, 30, 30);

    await index.insert(r1, 1);
    await index.insert(r2, 2);

    const rootPageId = index.getRootPageId();

    // Commit to disk before reopening
    await fbf.commit();

    // "Reopen" the index
    const reopenedIndex = RStarIndex.open(fbf, rootPageId, 10);

    const query = new Rectangle(0, 0, 100, 100);
    const results = await reopenedIndex.search(query);

    expect(results.sort()).toEqual([1, 2]);
  });

  it('handles point rectangles', async () => {
    const point = new Rectangle(5, 5, 5, 5);
    await index.insert(point, 1);

    const query = new Rectangle(4, 4, 6, 6);
    const results = await index.search(query);

    expect(results).toEqual([1]);
  });

  it('handles delete of non-existent rectangle', async () => {
    const r1 = new Rectangle(0, 0, 10, 10);
    await index.insert(r1, 1);

    const r2 = new Rectangle(20, 20, 30, 30);
    await index.delete(r2, 2); // Not in tree

    const query = new Rectangle(0, 0, 100, 100);
    const results = await index.search(query);

    expect(results).toEqual([1]); // Original still there
  });

  it('handles negative coordinates', async () => {
    const r1 = new Rectangle(-10, -10, 0, 0);
    const r2 = new Rectangle(-5, -5, 5, 5);

    await index.insert(r1, 1);
    await index.insert(r2, 2);

    const query = new Rectangle(-3, -3, 3, 3);
    const results = await index.search(query);

    expect(results.sort()).toEqual([1, 2]);
  });

  it('handles floating point coordinates', async () => {
    const r1 = new Rectangle(0.123, 0.456, 10.789, 20.012);
    const r2 = new Rectangle(5.5, 15.5, 15.5, 25.5);

    await index.insert(r1, 1);
    await index.insert(r2, 2);

    // Query that only overlaps r2
    const query = new Rectangle(12.0, 22.0, 14.0, 24.0);
    const results = await index.search(query);

    expect(results).toEqual([2]);
  });

  it('handles large coordinate values', async () => {
    const r1 = new Rectangle(1e10, 1e10, 1e10 + 100, 1e10 + 100);
    const r2 = new Rectangle(1e10 + 50, 1e10 + 50, 1e10 + 150, 1e10 + 150);

    await index.insert(r1, 1);
    await index.insert(r2, 2);

    const query = new Rectangle(1e10 + 60, 1e10 + 60, 1e10 + 80, 1e10 + 80);
    const results = await index.search(query);

    expect(results.sort()).toEqual([1, 2]);
  });

  it('handles adjacent non-overlapping rectangles', async () => {
    const r1 = new Rectangle(0, 0, 10, 10);
    const r2 = new Rectangle(10, 0, 20, 10); // Adjacent to r1

    await index.insert(r1, 1);
    await index.insert(r2, 2);

    // Query that only touches the edge
    const query = new Rectangle(10, 0, 10, 10);
    const results = await index.search(query);

    // Both should be found (edges touch)
    expect(results.sort()).toEqual([1, 2]);
  });

  it('handles multiple deletes', async () => {
    for (let i = 0; i < 20; i++) {
      const rect = new Rectangle(i * 10, 0, i * 10 + 5, 5);
      await index.insert(rect, i);
    }

    // Delete every other rectangle
    for (let i = 0; i < 20; i += 2) {
      const rect = new Rectangle(i * 10, 0, i * 10 + 5, 5);
      await index.delete(rect, i);
    }

    const query = new Rectangle(0, 0, 200, 10);
    const results = await index.search(query);

    expect(results.length).toBe(10);
    expect(results.every((id) => id % 2 === 1)).toBe(true);
  });

  it('handles duplicate rectangles with different IDs', async () => {
    const rect = new Rectangle(0, 0, 10, 10);

    await index.insert(rect, 1);
    await index.insert(rect, 2);
    await index.insert(rect, 3);

    const query = new Rectangle(5, 5, 6, 6);
    const results = await index.search(query);

    expect(results.sort()).toEqual([1, 2, 3]);
  });

  it('handles insert after delete at same location', async () => {
    const rect = new Rectangle(0, 0, 10, 10);

    await index.insert(rect, 1);
    await index.delete(rect, 1);
    await index.insert(rect, 2);

    const query = new Rectangle(0, 0, 100, 100);
    const results = await index.search(query);

    expect(results).toEqual([2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RStarIndex - Node Splitting Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('RStarIndex - Node Splitting', () => {
  let fbf: FreeBlockFile;
  let index: RStarIndex;

  beforeEach(async () => {
    fbf = await makeFbf(512);
    // Use small maxEntries to force more splits
    index = await RStarIndex.create(fbf, 5);
  });

  it('handles node split on insertion', async () => {
    // Insert more than maxEntries to force a split
    for (let i = 0; i < 10; i++) {
      const rect = new Rectangle(i * 10, 0, i * 10 + 5, 5);
      await index.insert(rect, i);
    }

    // All should still be searchable
    const query = new Rectangle(0, 0, 100, 10);
    const results = await index.search(query);

    expect(results.length).toBe(10);
  });

  it('handles multiple levels of splits', async () => {
    // Insert many rectangles to force multiple split levels
    for (let i = 0; i < 50; i++) {
      const x = (i % 10) * 10;
      const y = Math.floor(i / 10) * 10;
      const rect = new Rectangle(x, y, x + 5, y + 5);
      await index.insert(rect, i);
    }

    // Verify all can be found
    const query = new Rectangle(0, 0, 100, 50);
    const results = await index.search(query);

    expect(results.length).toBe(50);
  });

  it('maintains correctness after root split', async () => {
    // Force enough insertions to cause root split
    for (let i = 0; i < 20; i++) {
      const rect = new Rectangle(i * 10, i * 10, i * 10 + 5, i * 10 + 5);
      await index.insert(rect, i);
    }

    // All rectangles should still be findable regardless of root changes
    const query = new Rectangle(50, 50, 60, 60);
    const results = await index.search(query);

    expect(results).toContain(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RStarIndex - Persistence Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('RStarIndex - Persistence', () => {
  it('survives multiple commit cycles', async () => {
    const fbf = await makeFbf(512);
    let index = await RStarIndex.create(fbf, 10);

    // Insert some rectangles
    for (let i = 0; i < 10; i++) {
      const rect = new Rectangle(i * 10, 0, i * 10 + 5, 5);
      await index.insert(rect, i);
    }

    const rootPageId1 = index.getRootPageId();
    await fbf.commit();

    // Reopen and insert more
    index = RStarIndex.open(fbf, rootPageId1, 10);
    for (let i = 10; i < 20; i++) {
      const rect = new Rectangle(i * 10, 0, i * 10 + 5, 5);
      await index.insert(rect, i);
    }

    const rootPageId2 = index.getRootPageId();
    await fbf.commit();

    // Reopen and verify all data
    index = RStarIndex.open(fbf, rootPageId2, 10);
    const query = new Rectangle(0, 0, 200, 10);
    const results = await index.search(query);

    expect(results.length).toBe(20);
  });

  it('persists deletes correctly', async () => {
    const fbf = await makeFbf(512);
    let index = await RStarIndex.create(fbf, 10);

    // Insert rectangles
    for (let i = 0; i < 10; i++) {
      const rect = new Rectangle(i * 10, 0, i * 10 + 5, 5);
      await index.insert(rect, i);
    }

    // Delete half
    for (let i = 0; i < 5; i++) {
      const rect = new Rectangle(i * 10, 0, i * 10 + 5, 5);
      await index.delete(rect, i);
    }

    const rootPageId = index.getRootPageId();
    await fbf.commit();

    // Reopen and verify
    index = RStarIndex.open(fbf, rootPageId, 10);
    const query = new Rectangle(0, 0, 100, 10);
    const results = await index.search(query);

    expect(results.length).toBe(5);
    expect(results.every((id) => id >= 5)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RStarIndex - Spatial Query Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('RStarIndex - Spatial Queries', () => {
  let fbf: FreeBlockFile;
  let index: RStarIndex;

  beforeEach(async () => {
    fbf = await makeFbf(512);
    index = await RStarIndex.create(fbf, 10);
  });

  it('finds all rectangles in grid', async () => {
    // Create a 10x10 grid of rectangles
    for (let x = 0; x < 10; x++) {
      for (let y = 0; y < 10; y++) {
        const rect = new Rectangle(x * 10, y * 10, x * 10 + 8, y * 10 + 8);
        await index.insert(rect, x * 10 + y);
      }
    }

    // Query entire grid
    const query = new Rectangle(0, 0, 100, 100);
    const results = await index.search(query);

    expect(results.length).toBe(100);
  });

  it('finds subset of grid', async () => {
    // Create a 10x10 grid of rectangles
    for (let x = 0; x < 10; x++) {
      for (let y = 0; y < 10; y++) {
        const rect = new Rectangle(x * 10, y * 10, x * 10 + 8, y * 10 + 8);
        await index.insert(rect, x * 10 + y);
      }
    }

    // Query partial area (should get 2x2 = 4 rectangles)
    const query = new Rectangle(25, 25, 45, 45);
    const results = await index.search(query);

    // Rectangles at (2,2), (2,3), (2,4), (3,2), (3,3), (3,4), (4,2), (4,3), (4,4) overlap
    expect(results.length).toBeGreaterThan(0);
  });

  it('handles point query (degenerate rectangle)', async () => {
    const r1 = new Rectangle(0, 0, 10, 10);
    const r2 = new Rectangle(20, 20, 30, 30);

    await index.insert(r1, 1);
    await index.insert(r2, 2);

    // Point query
    const point = new Rectangle(5, 5, 5, 5);
    const results = await index.search(point);

    expect(results).toEqual([1]);
  });

  it('handles thin horizontal rectangle query', async () => {
    const r1 = new Rectangle(0, 0, 100, 10);
    const r2 = new Rectangle(0, 20, 100, 30);
    const r3 = new Rectangle(0, 40, 100, 50);

    await index.insert(r1, 1);
    await index.insert(r2, 2);
    await index.insert(r3, 3);

    // Thin horizontal query
    const query = new Rectangle(0, 15, 100, 15);
    const results = await index.search(query);

    expect(results).toEqual([]); // Doesn't intersect any
  });

  it('handles very large query area', async () => {
    for (let i = 0; i < 50; i++) {
      const rect = new Rectangle(i * 10, i * 10, i * 10 + 5, i * 10 + 5);
      await index.insert(rect, i);
    }

    // Query that covers everything
    const query = new Rectangle(-1000, -1000, 1000, 1000);
    const results = await index.search(query);

    expect(results.length).toBe(50);
  });

  it('handles query with no matches efficiently', async () => {
    for (let i = 0; i < 100; i++) {
      const rect = new Rectangle(i * 10, 0, i * 10 + 5, 5);
      await index.insert(rect, i);
    }

    // Query far away from all data
    const query = new Rectangle(2000, 2000, 2100, 2100);
    const results = await index.search(query);

    expect(results).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rectangle - Advanced Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Rectangle - Advanced', () => {
  it('handles zero-area rectangle', () => {
    const line = new Rectangle(0, 0, 10, 0);
    expect(line.area()).toBe(0);
  });

  it('handles point rectangle (zero area)', () => {
    const point = new Rectangle(5, 5, 5, 5);
    expect(point.area()).toBe(0);
  });

  it('intersection with self', () => {
    const rect = new Rectangle(0, 0, 10, 10);
    expect(rect.intersects(rect)).toBe(true);
  });

  it('union with self returns equivalent rectangle', () => {
    const rect = new Rectangle(0, 0, 10, 10);
    const union = rect.union(rect);
    expect(union.equals(rect)).toBe(true);
  });

  it('enlargement by contained rectangle is zero', () => {
    const outer = new Rectangle(0, 0, 20, 20);
    const inner = new Rectangle(5, 5, 15, 15);
    expect(outer.enlargement(inner)).toBe(0);
  });

  it('contains edge points', () => {
    const rect = new Rectangle(0, 0, 10, 10);
    expect(rect.contains({ x: 0, y: 5 })).toBe(true);
    expect(rect.contains({ x: 10, y: 5 })).toBe(true);
    expect(rect.contains({ x: 5, y: 0 })).toBe(true);
    expect(rect.contains({ x: 5, y: 10 })).toBe(true);
  });

  it('contains corner points', () => {
    const rect = new Rectangle(0, 0, 10, 10);
    expect(rect.contains({ x: 0, y: 0 })).toBe(true);
    expect(rect.contains({ x: 0, y: 10 })).toBe(true);
    expect(rect.contains({ x: 10, y: 0 })).toBe(true);
    expect(rect.contains({ x: 10, y: 10 })).toBe(true);
  });

  it('edge-touching rectangles intersect', () => {
    const r1 = new Rectangle(0, 0, 10, 10);
    const r2 = new Rectangle(10, 0, 20, 10);
    expect(r1.intersects(r2)).toBe(true);
  });

  it('corner-touching rectangles intersect', () => {
    const r1 = new Rectangle(0, 0, 10, 10);
    const r2 = new Rectangle(10, 10, 20, 20);
    expect(r1.intersects(r2)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Large Scale Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('RStarIndex - Large Scale', () => {
  it('handles 1000 insertions', async () => {
    // Use larger block size for more entries per node
    const fbf = await makeFbf(4096);
    const index = await RStarIndex.create(fbf, 50);

    for (let i = 0; i < 1000; i++) {
      const x = (i % 100) * 10;
      const y = Math.floor(i / 100) * 10;
      const rect = new Rectangle(x, y, x + 5, y + 5);
      await index.insert(rect, i);
    }

    // Verify sampling of data
    const query = new Rectangle(0, 0, 1000, 100);
    const results = await index.search(query);

    expect(results.length).toBe(1000);
  }, 30000); // 30s timeout

  it('handles mixed insert and delete workload', async () => {
    const fbf = await makeFbf(4096);
    const index = await RStarIndex.create(fbf, 50);
    const inserted = new Set<number>();

    // Insert 200 rectangles
    for (let i = 0; i < 200; i++) {
      const rect = new Rectangle(i * 5, 0, i * 5 + 4, 4);
      await index.insert(rect, i);
      inserted.add(i);
    }

    // Delete every 3rd rectangle
    for (let i = 0; i < 200; i += 3) {
      const rect = new Rectangle(i * 5, 0, i * 5 + 4, 4);
      await index.delete(rect, i);
      inserted.delete(i);
    }

    // Insert more
    for (let i = 200; i < 300; i++) {
      const rect = new Rectangle(i * 5, 0, i * 5 + 4, 4);
      await index.insert(rect, i);
      inserted.add(i);
    }

    // Verify
    const query = new Rectangle(0, 0, 1500, 10);
    const results = await index.search(query);

    expect(results.length).toBe(inserted.size);
  }, 30000);

  it('handles clustered data', async () => {
    const fbf = await makeFbf(4096);
    const index = await RStarIndex.create(fbf, 50);

    // Create clusters of rectangles
    const clusters = [
      { cx: 0, cy: 0 },
      { cx: 100, cy: 100 },
      { cx: 200, cy: 0 },
      { cx: 0, cy: 200 },
    ];

    let id = 0;
    for (const cluster of clusters) {
      for (let i = 0; i < 50; i++) {
        const angle = (i / 50) * 2 * Math.PI;
        const r = 10 + Math.random() * 10;
        const x = cluster.cx + r * Math.cos(angle);
        const y = cluster.cy + r * Math.sin(angle);
        const rect = new Rectangle(x, y, x + 2, y + 2);
        await index.insert(rect, id++);
      }
    }

    // Query one cluster
    const query = new Rectangle(90, 90, 110, 110);
    const results = await index.search(query);

    // Should find rectangles from that cluster
    expect(results.length).toBeGreaterThan(10);
    expect(results.length).toBeLessThan(100);
  }, 30000);
});
