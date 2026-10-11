import { describe, expect, it, vi } from 'vitest';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { AtomicFile } from '../wal/atomicfile.mjs';
import { FreeBlockFile } from '../blocks/freeblockfile.mjs';
import { BPlusTree } from '../../indexes/btree/btree.mjs';
import { BlockNodeStorage } from '../../indexes/btree/nodestorage.mjs';
import { BlockLeafNode } from '../../indexes/btree/leafnode.mjs';
import { BlockInternalNode } from '../../indexes/btree/internalnode.mjs';
import { VectorHeapFile } from '../../indexes/hnsw/vectorHeapFile.mjs';
import { HNSWGraphStorage } from '../../indexes/hnsw/hnswGraphStorage.mjs';
import { HNSWNode } from '../../indexes/hnsw/hnswNode.mjs';
import { SimpleDbms } from '../../database/simpledbms.mjs';
import type { DbmsBack, HnswConfig } from '../../database/dbmsback.mjs';

async function collect<T>(entries: AsyncIterable<T>): Promise<T[]> {
  const result = [];
  for await (const entry of entries) result.push(entry);
  return result;
}

describe('storage failure propagation through persistent indexes', () => {
  it('rejects B+ tree merges when releasing a block fails and keeps committed contents on discard/reopen', async () => {
    const data = new MockFile(512);
    const log = new MockFile(512);
    const file = new FreeBlockFile(new AtomicFile(data, log), 512);
    await file.create();
    const storage = new BlockNodeStorage(file);
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);
    const keys = Array.from({ length: 12 }, (_, index) =>
      Buffer.from(`${index.toString().padStart(2, '0')}${'x'.repeat(118)}`),
    );
    for (const key of keys) await tree.insert(key, Buffer.alloc(40, 1));
    const root = tree.getRoot().getBlockNumber();
    await file.commit();
    const error = new Error('injected merge block-release failure');
    const free = vi.spyOn(file, 'freeBlock').mockRejectedValue(error);
    let failure: unknown;
    try {
      for (const key of keys) {
        try {
          await tree.delete(key);
        } catch (caught) {
          failure = caught;
          break;
        }
      }
      expect(free).toHaveBeenCalled();
      expect(failure).toBe(error);
    } finally {
      free.mockRestore();
      await file.close();
    }
    // Discard uncommitted mutation state; this task adds no mutation rollback.
    const reopened = new FreeBlockFile(new AtomicFile(data, log), 512);
    await reopened.open();
    try {
      const reopenedStorage = new BlockNodeStorage(reopened);
      const reopenedTree = BPlusTree.open(reopenedStorage, await reopenedStorage.openTree(root));
      expect((await collect(reopenedTree.iterate())).map(([key]) => key)).toEqual(keys);
    } finally {
      await reopened.close();
    }
  });

  it.each(['vector', 'graph'] as const)(
    'does not silently skip unreadable %s pages during physical scans',
    async (kind) => {
      const file = new FreeBlockFile(new AtomicFile(new MockFile(1024), new MockFile(1024)), 1024);
      await file.create();
      const vectors = new VectorHeapFile(file, 3);
      const pointer = await vectors.insert(new Float32Array([1, 0, 0]));
      const graph = await HNSWGraphStorage.create(file, 4, 2);
      const node = new HNSWNode({ nodeId: 0, docId: 1, level: 0, vectorPtr: pointer, neighbors: [[]], deleted: true });
      await graph.insertNode(node);
      await file.commit();
      const failure = new Error(`injected ${kind} page read failure`);
      const read = file.readBlock.bind(file);
      const readSpy = vi.spyOn(file, 'readBlock').mockImplementation((block) => {
        if (kind === 'vector' ? block === pointer.pageId : block !== pointer.pageId) return Promise.reject(failure);
        return read(block);
      });
      try {
        await expect(collect<unknown>(kind === 'vector' ? vectors.scan() : graph.scanPhysicalNodes())).rejects.toBe(
          failure,
        );
      } finally {
        readSpy.mockRestore();
        await file.close();
      }
    },
  );

  it('propagates persisted HNSW read failures during database opening instead of disabling semantic search', async () => {
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const config: HnswConfig = { dimension: 3, M: 4, embeddingFn: () => Promise.resolve(new Float32Array([1, 0, 0])) };
    const db = await SimpleDbms.create(data, log, config);
    await db.insertDocumentObject('docs', { id: 'A', title: 'document A' });
    await db.commit();
    const meta = (db as unknown as { dbmsback: DbmsBack }).dbmsback as unknown as {
      metaCache: { __hnsw__: Record<string, [number, string]> };
    };
    const graphBlock = Object.values(meta.metaCache.__hnsw__)[0][0];
    await db.close();
    const read = data.read.bind(data);
    const readSpy = vi.spyOn(data, 'read').mockImplementation((buffer, options) => {
      if (options.position === graphBlock * 4096) return Promise.reject(new Error('persisted HNSW read failure'));
      return read(buffer, options);
    });
    try {
      await expect(SimpleDbms.open(data, log, config)).rejects.toThrow('persisted HNSW read failure');
    } finally {
      readSpy.mockRestore();
    }
    const reopened = await SimpleDbms.open(data, log, config);
    try {
      expect(
        (await reopened.semanticSearch('docs', 'document', 10)).map((doc) => (JSON.parse(doc) as { id: string }).id),
      ).toEqual(['A']);
    } finally {
      await reopened.close();
    }
  });
});
