import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { RealFile } from '../../../storage/file.mjs';
import { AtomicFile } from '../../../storage/wal/atomicfile.mjs';
import { FreeBlockFile } from '../../../storage/blocks/freeblockfile.mjs';
import { HNSWGraphStorage } from '../hnswGraphStorage.mjs';
import { HNSWIndex } from '../hnswIndex.mjs';
import { VectorHeapFile } from '../vectorHeapFile.mjs';
import { VectorSerializer } from '../vectorSerializer.mjs';

const directories: string[] = [];
const files: FreeBlockFile[] = [];
const indexes: HNSWIndex[] = [];
const params = { M: 4, efConstruction: 20, efSearch: 20 };
const vector = (...values: number[]): Float32Array => new Float32Array(values);

afterEach(async () => {
  vi.restoreAllMocks();
  for (const index of indexes.splice(0)) index.dispose();
  for (const file of files.splice(0)) await file.close();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected test directory');
    await rm(directory, { recursive: true, force: true });
  }
});

async function openFile(path: string, create = false): Promise<FreeBlockFile> {
  const file = new FreeBlockFile(new AtomicFile(new RealFile(path), new RealFile(path + '.log')), 4096);
  files.push(file);
  if (create) await file.create();
  else await file.open();
  return file;
}

async function createFile(): Promise<{ path: string; file: FreeBlockFile }> {
  const directory = await mkdtemp(join(tmpdir(), 'siftwell-hnsw-dimension-'));
  directories.push(directory);
  const path = join(directory, 'test.db');
  return { path, file: await openFile(path, true) };
}

describe('persisted HNSW embedding dimensions', () => {
  it('rejects a mismatched dimension before vector decoding and preserves disk data for a correct reopen', async () => {
    const { path, file } = await createFile();
    const graph = await HNSWGraphStorage.create(file, params.M, 2);
    const root = graph.metaBlockId;
    const index = HNSWIndex.create(graph, new VectorHeapFile(file, 3), params);
    indexes.push(index);
    await index.insert(11, vector(1, 2, 3));
    await file.commit();
    await file.close();
    const before = await readFile(path);

    const reopenedFile = await openFile(path);
    const reopenedGraph = await HNSWGraphStorage.open(reopenedFile, root);
    const wrongHeap = new VectorHeapFile(reopenedFile, 4);
    const readVector = vi.spyOn(wrongHeap, 'get');
    await expect(HNSWIndex.open(reopenedGraph, wrongHeap, params)).rejects.toThrow(/dimension/i);
    expect(readVector).not.toHaveBeenCalled();
    expect(reopenedFile.isHealthy).toBe(true);
    await reopenedFile.close();
    expect(await readFile(path)).toEqual(before);
    expect(await readFile(path + '.log')).toHaveLength(0);

    const validFile = await openFile(path);
    const validIndex = await HNSWIndex.open(
      await HNSWGraphStorage.open(validFile, root),
      new VectorHeapFile(validFile, 3),
      params,
    );
    indexes.push(validIndex);
    expect(await validIndex.search(vector(1, 2, 3), 1)).toEqual([11]);
    expect((await validIndex.inspectGraphStructure())[0].vector).toEqual([1, 2, 3]);
  });

  it('does not interpret another dimension when getting or scanning pages in the shared file', async () => {
    const { file } = await createFile();
    const three = new VectorHeapFile(file, 3);
    const four = new VectorHeapFile(file, 4);
    const first = await three.insert(vector(1, 2, 3));
    const second = await four.insert(vector(4, 5, 6, 7));
    await file.commit();
    await expect(three.get(second)).rejects.toThrow(/dimension/i);
    await expect(four.get(first)).rejects.toThrow(/dimension/i);
    await expect(three.update(second, vector(9, 9, 9))).rejects.toThrow(/dimension/i);
    await expect(four.delete(first)).rejects.toThrow(/dimension/i);
    expect(Array.from(await three.get(first))).toEqual([1, 2, 3]);
    expect(Array.from(await four.get(second))).toEqual([4, 5, 6, 7]);
    const seenThree = [];
    for await (const item of three.scan()) seenThree.push(Array.from(item.vector));
    const seenFour = [];
    for await (const item of four.scan()) seenFour.push(Array.from(item.vector));
    expect(seenThree).toEqual([[1, 2, 3]]);
    expect(seenFour).toEqual([[4, 5, 6, 7]]);
  });

  it('persists the dimension of an empty index without skipping other shared commit hooks', async () => {
    const { path, file } = await createFile();
    const graph = await HNSWGraphStorage.create(file, params.M, 2);
    const root = graph.metaBlockId;
    indexes.push(HNSWIndex.create(graph, new VectorHeapFile(file, 3), params));
    const otherFlush = vi.fn(async () => {});
    file.addPreCommitHook(otherFlush);
    await file.commit();
    expect(otherFlush).toHaveBeenCalledOnce();
    await file.close();
    const reopenedFile = await openFile(path);
    const reopenedGraph = await HNSWGraphStorage.open(reopenedFile, root);
    expect(reopenedGraph.vectorDimension).toBe(3);
    const wrongHeap = new VectorHeapFile(reopenedFile, 4);
    const read = vi.spyOn(wrongHeap, 'get');
    await expect(HNSWIndex.open(reopenedGraph, wrongHeap, params)).rejects.toThrow(/dimension mismatch/i);
    expect(read).not.toHaveBeenCalled();
    const valid = await HNSWIndex.open(reopenedGraph, new VectorHeapFile(reopenedFile, 3), params);
    indexes.push(valid);
    expect(await valid.search(vector(1, 2, 3), 1)).toEqual([]);
  });

  it('retains dimension validation for tombstoned-only graphs', async () => {
    const { path, file } = await createFile();
    const graph = await HNSWGraphStorage.create(file, params.M, 2, 3);
    const root = graph.metaBlockId;
    const index = HNSWIndex.create(graph, new VectorHeapFile(file, 3), params);
    indexes.push(index);
    await index.insert(22, vector(1, 2, 3));
    await index.delete(22);
    await file.commit();
    await file.close();
    const reopened = await openFile(path);
    const openedGraph = await HNSWGraphStorage.open(reopened, root);
    const wrong = new VectorHeapFile(reopened, 4);
    const read = vi.spyOn(wrong, 'get');
    await expect(HNSWIndex.open(openedGraph, wrong, params)).rejects.toThrow(/dimension/i);
    expect(read).not.toHaveBeenCalled();
    const valid = await HNSWIndex.open(openedGraph, new VectorHeapFile(reopened, 3), params);
    indexes.push(valid);
    expect(await valid.search(vector(1, 2, 3), 1)).toEqual([]);
    expect(await valid.inspectGraphStructure()).toMatchObject([{ docId: 22, vector: [1, 2, 3], deleted: true }]);
  });

  it('preserves multiple dimensions and tombstones through physical relocation, commit and fresh reopen', async () => {
    const { path, file } = await createFile();
    const graph3 = await HNSWGraphStorage.create(file, params.M, 2, 3);
    const graph4 = await HNSWGraphStorage.create(file, params.M, 2, 4);
    const index3 = HNSWIndex.create(graph3, new VectorHeapFile(file, 3), params);
    const index4 = HNSWIndex.create(graph4, new VectorHeapFile(file, 4), params);
    indexes.push(index3, index4);
    await index3.insert(31, vector(1, 2, 3));
    await index3.insert(32, vector(9, 8, 7));
    await index3.delete(32);
    await index4.insert(41, vector(4, 5, 6, 7));
    const tombstone = (await index3.inspectGraphStructure()).find((node) => node.deleted)!;
    const relocatedNode = await index3.relocateGraphNode(tombstone.nodeId);
    await index3.relocateVectorForNode(relocatedNode);
    const root3 = (await index3.relocateMetadata())!;
    const root4 = graph4.metaBlockId;
    await file.commit();
    await file.close();

    const reopened = await openFile(path);
    const reopenedGraph3 = await HNSWGraphStorage.open(reopened, root3);
    const reopenedGraph4 = await HNSWGraphStorage.open(reopened, root4);
    expect(reopenedGraph3.vectorDimension).toBe(3);
    expect(reopenedGraph4.vectorDimension).toBe(4);
    const opened3 = await HNSWIndex.open(reopenedGraph3, new VectorHeapFile(reopened, 3), params);
    const opened4 = await HNSWIndex.open(reopenedGraph4, new VectorHeapFile(reopened, 4), params);
    indexes.push(opened3, opened4);
    expect(await opened3.search(vector(1, 2, 3), 2)).toEqual([31]);
    expect(await opened4.search(vector(4, 5, 6, 7), 1)).toEqual([41]);
    expect(await opened3.inspectGraphStructure()).toMatchObject([
      { docId: 31, vector: [1, 2, 3], deleted: false },
      { docId: 32, vector: [9, 8, 7], deleted: true },
    ]);
    expect(await opened4.inspectGraphStructure()).toMatchObject([{ docId: 41, vector: [4, 5, 6, 7] }]);
  });

  it.each(['empty', 'live', 'tombstoned'] as const)(
    'rejects unknown legacy dimensions for %s graphs without decoding or changing persisted bytes',
    async (state) => {
      const { path, file } = await createFile();
      const graph = await HNSWGraphStorage.create(file, params.M, 2, 3);
      const root = graph.metaBlockId;
      const index = HNSWIndex.create(graph, new VectorHeapFile(file, 3), params);
      indexes.push(index);
      if (state !== 'empty') await index.insert(1, vector(1, 2, 3));
      if (state === 'tombstoned') await index.delete(1);
      const raw = await file.readBlock(root);
      raw.fill(0, 23, 31); // the original metadata has no extension
      await file.writeBlock(root, raw.subarray(1));
      await file.commit();
      await file.close();
      const before = await readFile(path);
      const reopened = await openFile(path);
      const legacyGraph = await HNSWGraphStorage.open(reopened, root);
      expect(legacyGraph.vectorDimension).toBeNull();
      const heap = new VectorHeapFile(reopened, 3);
      const read = vi.spyOn(heap, 'get');
      await expect(HNSWIndex.open(legacyGraph, heap, params)).rejects.toThrow(/legacy.*persisted vector dimension/i);
      expect(read).not.toHaveBeenCalled();
      expect(() => HNSWIndex.create(legacyGraph, heap, params)).toThrow(/existing legacy/i);
      expect(reopened.isHealthy).toBe(true);
      await reopened.close();
      expect(await readFile(path)).toEqual(before);
    },
  );

  it('reads legacy vector pages only with known persisted graph dimension and relocates them into tagged pages', async () => {
    const { path, file } = await createFile();
    const graph = await HNSWGraphStorage.create(file, params.M, 2, 3);
    const root = graph.metaBlockId;
    const index = HNSWIndex.create(graph, new VectorHeapFile(file, 3), params);
    indexes.push(index);
    await index.insert(1, vector(1, 2, 3));
    const node = (await index.inspectGraphStructure())[0];
    const legacyCapacity = Math.floor(((4096 - 4) * 8) / (3 * 4 * 8 + 1));
    const legacyOffset = 3 + Math.ceil(legacyCapacity / 8);
    const legacyPage = Buffer.alloc(4095);
    legacyPage[0] = 0xa5;
    legacyPage.writeUInt16LE(1, 1);
    legacyPage[3] = 1;
    VectorSerializer.serialize(vector(1, 2, 3), legacyPage, legacyOffset);
    await file.writeBlock(node.vectorPageId, legacyPage);
    await file.commit();
    await file.close();

    const reopened = await openFile(path);
    const heap = new VectorHeapFile(reopened, 3);
    const pointer = { pageId: node.vectorPageId, slotId: node.vectorSlotId };
    await expect(heap.get(pointer)).rejects.toThrow(/independently persisted dimension/i);
    const valid = await HNSWIndex.open(await HNSWGraphStorage.open(reopened, root), heap, params);
    indexes.push(valid);
    expect(await valid.search(vector(1, 2, 3), 1)).toEqual([1]);
    await heap.update(pointer, vector(3, 2, 1));
    expect(Array.from(await heap.get(pointer))).toEqual([3, 2, 1]);
    const scanned = [];
    for await (const item of heap.scan()) scanned.push(item);
    expect(scanned).toEqual([]); // untagged legacy pages cannot be filtered safely in a shared file
    const moved = await valid.relocateVectorForNode(node.nodeId);
    expect((await reopened.readBlock(moved.pageId))[1]).toBe(0xa6);
    await reopened.commit();
    await reopened.close();
    const finalFile = await openFile(path);
    const final = await HNSWIndex.open(
      await HNSWGraphStorage.open(finalFile, root),
      new VectorHeapFile(finalFile, 3),
      params,
    );
    indexes.push(final);
    expect(await final.inspectGraphStructure()).toMatchObject([{ vector: [3, 2, 1] }]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 0x100000000])(
    'rejects invalid dimension %s before allocation',
    async (dimension) => {
      const { file } = await createFile();
      const allocate = vi.spyOn(file, 'allocateBlock');
      expect(() => new VectorHeapFile(file, dimension)).toThrow(/dimension/i);
      await expect(HNSWGraphStorage.create(file, params.M, 2, dimension)).rejects.toThrow(/dimension/i);
      expect(allocate).not.toHaveBeenCalled();
      expect(file.isHealthy).toBe(true);
    },
  );

  it.each(['unknown version', 'zero dimension'] as const)(
    'rejects %s in the graph extension before opening native/vector state',
    async (corruption) => {
      const { path, file } = await createFile();
      const graph = await HNSWGraphStorage.create(file, params.M, 2, 3);
      const root = graph.metaBlockId;
      const raw = await file.readBlock(root);
      if (corruption === 'unknown version') raw.write('HVD2', 23);
      else raw.writeUInt32LE(0, 27);
      await file.writeBlock(root, raw.subarray(1));
      await file.commit();
      await file.close();
      const before = await readFile(path);
      const reopened = await openFile(path);
      await expect(HNSWGraphStorage.open(reopened, root)).rejects.toThrow(
        /dimension metadata|dimension must be positive/i,
      );
      expect(reopened.isHealthy).toBe(true);
      await reopened.close();
      expect(await readFile(path)).toEqual(before);
    },
  );
});
