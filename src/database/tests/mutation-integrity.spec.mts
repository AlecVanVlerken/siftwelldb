import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbmsBack } from '../dbmsback.mjs';
import { SimpleDbms } from '../simpledbms.mjs';
import { parseRawDocument } from '../document.mjs';
import { RealFile } from '../../storage/file.mjs';
import { FreeBlockFile, MutationRecoveryRequiredError } from '../../storage/blocks/freeblockfile.mjs';
import { RecordStore } from '../../storage/records/recordstore.mjs';
import { BlockNodeStorage } from '../../indexes/btree/nodestorage.mjs';
import { BPlusTree } from '../../indexes/btree/btree.mjs';
import { HNSWIndex } from '../../indexes/hnsw/hnswIndex.mjs';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';

const directories: string[] = [];
const sessions: DbmsBack[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of sessions.splice(0)) await db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function diskDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'siftwell-mutation-'));
  directories.push(directory);
  const dataPath = join(directory, 'test.db');
  const logPath = dataPath + '.log';
  const db = new DbmsBack(new RealFile(dataPath), new RealFile(logPath));
  sessions.push(db);
  await db.create();
  await db.insertDocument(parseRawDocument('docs', { id: 1, tag: 'committed', score: 10 }));
  await db.commit();
  const dataBefore = await readFile(dataPath);
  return {
    db,
    dataPath,
    logPath,
    dataBefore,
    async reopen() {
      await db.close();
      expect(await readFile(dataPath)).toEqual(dataBefore);
      expect(await readFile(logPath)).toHaveLength(0);
      const reopened = await DbmsBack.open(new RealFile(dataPath), new RealFile(logPath));
      sessions.push(reopened);
      return reopened;
    },
  };
}

async function values(db: DbmsBack, field = 'id') {
  const result = [];
  for await (const document of await db.cursor('docs', field)) result.push(document.asDocument());
  return result;
}

describe('mutation session integrity', () => {
  it('keeps maintenance and metadata preflight failures healthy', async () => {
    const db = new DbmsBack(new MockFile(4096), new MockFile(4096), {
      dimension: 3,
      M: 4,
      embeddingFn: () => Promise.resolve(new Float32Array([1, 0, 0])),
    });
    sessions.push(db);
    await db.create();
    await expect(db.ensurePrimaryIndex('__compression__', 'string')).rejects.toThrow('reserved');
    expect(db.isHealthy).toBe(true);
    await db.insertDocument(parseRawDocument('docs', { id: 1, tag: 'valid' }));
    await expect(db.relocateHnswUnit({ collection: 'docs', kind: 'hnsw-graph' })).rejects.toThrow('requires nodeId');
    expect(db.isHealthy).toBe(true);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    await expect(db.metaWriteJSON(circular)).rejects.toThrow('circular');
    expect(db.isHealthy).toBe(true);
    await db.commit();
  });

  it.each(['primary insertion', 'secondary insertion', 'record write'])(
    'blocks queued writes, reads and every commit path after a failed %s, preserving the durable database',
    async (stage) => {
      const state = await diskDatabase();
      const fault = new Error(`injected ${stage} failure`);
      if (stage === 'record write') {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- The mock supplies its original instance with apply.
        const original = RecordStore.prototype.writeRecord;
        vi.spyOn(RecordStore.prototype, 'writeRecord').mockImplementation(async function (this: RecordStore, ...args) {
          await original.apply(this, args);
          throw fault;
        });
      } else {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- The mock supplies its original instance with apply.
        const original = BPlusTree.prototype.insert;
        let calls = 0;
        vi.spyOn(BPlusTree.prototype, 'insert').mockImplementation(async function (
          this: typeof BPlusTree.prototype,
          ...args
        ) {
          calls++;
          if (calls === (stage === 'primary insertion' ? 1 : 2)) throw fault;
          await original.apply(this, args);
        });
      }
      const failed = state.db.insertDocument(parseRawDocument('docs', { id: 2, tag: 'partial', score: 20 }));
      const queued = state.db.insertDocument(parseRawDocument('docs', { id: 3, tag: 'later', score: 30 }));
      await expect(failed).rejects.toThrow(MutationRecoveryRequiredError);
      await expect(queued).rejects.toThrow('close and reopen');
      vi.restoreAllMocks();
      expect(state.db.isHealthy).toBe(false);
      await expect(state.db.commit()).rejects.toThrow('close and reopen');
      const file = (state.db as unknown as { freeblockFile: FreeBlockFile }).freeblockFile;
      await expect(file.commit()).rejects.toThrow('close and reopen');
      await expect(state.db.getDocument(1, 'docs')).rejects.toThrow('close and reopen');
      await expect(values(state.db)).rejects.toThrow('close and reopen');
      expect(() => state.db.listCollections()).toThrow('close and reopen');
      expect(() => state.db.setFieldCompressionDefaults('docs', { tag: 'gzip' })).toThrow('close and reopen');
      await expect(state.db.setFieldIndexed('docs', 'tag', false)).rejects.toThrow('close and reopen');
      await expect(state.db.runIncrementalCompactionStep()).rejects.toThrow('close and reopen');
      await expect(state.db.vacuumCompactInto(new MockFile(4096), new MockFile(4096))).rejects.toThrow(
        'close and reopen',
      );
      const reopened = await state.reopen();
      expect(await values(reopened)).toEqual([{ id: 1, tag: 'committed', score: 10 }]);
      expect(await values(reopened, 'tag')).toEqual(await values(reopened));
      await reopened.insertDocument(parseRawDocument('docs', { id: 3, tag: 'healthy', score: 30 }));
      await reopened.commit();
      expect(reopened.isHealthy).toBe(true);
    },
  );

  it.each(['edit', 'replace', 'delete'])(
    'discards partially failed %s changes on a fresh disk reopen',
    async (operation) => {
      const state = await diskDatabase();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- The mock supplies its original instance with apply.
      const original = BPlusTree.prototype.delete;
      let calls = 0;
      vi.spyOn(BPlusTree.prototype, 'delete').mockImplementation(async function (
        this: typeof BPlusTree.prototype,
        ...args
      ) {
        if (++calls === 2) throw new Error('secondary deletion failed');
        return original.apply(this, args);
      });
      const result =
        operation === 'edit'
          ? state.db.editDocumentByID('docs', 1, 'tag', 'changed')
          : operation === 'replace'
            ? state.db.replaceDocumentByID(
                'docs',
                1,
                parseRawDocument('docs', { id: 1, tag: 'replacement', score: 11 }),
              )
            : state.db.deleteDocument(1, 'docs');
      await expect(result).rejects.toThrow('secondary deletion failed');
      vi.restoreAllMocks();
      await expect(state.db.commit()).rejects.toThrow(MutationRecoveryRequiredError);
      const reopened = await state.reopen();
      expect(await values(reopened)).toEqual([{ id: 1, tag: 'committed', score: 10 }]);
      expect(await values(reopened, 'tag')).toEqual(await values(reopened));
      await reopened.deleteDocument(1, 'docs');
      await reopened.commit();
      expect(await values(reopened)).toEqual([]);
    },
  );

  it('blocks committing after record deallocation fails during deletion', async () => {
    const state = await diskDatabase();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The mock supplies its original instance with apply.
    const original = RecordStore.prototype.deleteRecord;
    vi.spyOn(RecordStore.prototype, 'deleteRecord').mockImplementation(async function (this: RecordStore, ...args) {
      await original.apply(this, args);
      throw new Error('record deallocation failed');
    });
    await expect(state.db.deleteDocument(1, 'docs')).rejects.toThrow('record deallocation failed');
    vi.restoreAllMocks();
    await expect(state.db.commit()).rejects.toThrow('close and reopen');
    expect(await values(await state.reopen(), 'tag')).toEqual([{ id: 1, tag: 'committed', score: 10 }]);
  });

  it('blocks commit retries after a staged-node flush failure', async () => {
    const state = await diskDatabase();
    await state.db.insertDocument(parseRawDocument('docs', { id: 2, tag: 'staged', score: 20 }));
    vi.spyOn(BlockNodeStorage.prototype, 'flushDirtyNodes').mockRejectedValueOnce(new Error('node flush failed'));
    await expect(state.db.commit()).rejects.toThrow('node flush failed');
    vi.restoreAllMocks();
    await expect(state.db.commit()).rejects.toThrow('close and reopen');
    expect(await values(await state.reopen(), 'tag')).toEqual([{ id: 1, tag: 'committed', score: 10 }]);
  });

  it('blocks commit after a semantic insertion fails after ordinary indexes change', async () => {
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const config = { dimension: 3, M: 4, embeddingFn: () => Promise.resolve(new Float32Array([1, 0, 0])) };
    const db = await SimpleDbms.create(data, log, config);
    await db.insertDocumentObject('docs', { id: 1, tag: 'committed' });
    await db.commit();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The mock supplies its original instance with apply.
    const original = HNSWIndex.prototype.insert;
    vi.spyOn(HNSWIndex.prototype, 'insert').mockImplementation(async function (this: HNSWIndex, ...args) {
      await original.apply(this, args);
      throw new Error('semantic insertion failed');
    });
    await expect(db.insertDocumentObject('docs', { id: 2, tag: 'partial' })).rejects.toThrow(
      'semantic insertion failed',
    );
    vi.restoreAllMocks();
    await expect(db.commit()).rejects.toThrow('close and reopen');
    await expect(db.semanticSearch('docs', 'query', 2)).rejects.toThrow('close and reopen');
    await db.close();
    const reopened = await SimpleDbms.open(data, log, config);
    expect(
      (await reopened.semanticSearch('docs', 'query', 2)).map(
        (row) => (JSON.parse(row) as Record<string, unknown>)['id'],
      ),
    ).toEqual([1]);
    await reopened.close();
  });

  it('keeps validation and embedding preflight failures healthy without losing earlier staged documents', async () => {
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const embeddingFn = vi.fn(() => Promise.resolve(new Float32Array([1, 0, 0])));
    const db = await SimpleDbms.create(data, log, { dimension: 3, M: 4, embeddingFn });
    await db.insertDocumentObject('docs', { id: 1, tag: 'staged' });
    await expect(db.insertDocumentObject('docs', { id: 2, tag: 'x'.repeat(3000) })).rejects.toThrow('maximum indexed');
    embeddingFn.mockRejectedValueOnce(new Error('encoder unavailable'));
    await expect(db.insertDocumentObject('docs', { id: 2, tag: 'rejected' })).rejects.toThrow('encoder unavailable');
    expect(db.isHealthy).toBe(true);
    await db.insertDocumentObject('docs', { id: 3, tag: 'later' });
    await db.commit();
    await db.close();
    const reopened = await SimpleDbms.open(data, log);
    const ids = [];
    for await (const row of reopened.cursor('docs', 'tag'))
      ids.push((JSON.parse(row) as Record<string, unknown>)['id']);
    expect(ids.sort()).toEqual([1, 3]);
    await reopened.close();
  });
});
