import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HNSWGraphStorage } from '../../indexes/hnsw/hnswGraphStorage.mjs';
import { VectorHeapFile } from '../../indexes/hnsw/vectorHeapFile.mjs';
import { FreeBlockFile, MutationRecoveryRequiredError } from '../../storage/blocks/freeblockfile.mjs';
import { RealFile } from '../../storage/file.mjs';
import { DbmsBack, type HnswConfig } from '../dbmsback.mjs';
import { parseRawDocument } from '../document.mjs';

const embedding = (text: string) => Promise.resolve(new Float32Array(text.includes('rabbit') ? [1, 0, 0] : [0, 1, 0]));
const config: HnswConfig = { dimension: 3, M: 4, embeddingFn: embedding };
const directories: string[] = [];
const sessions: DbmsBack[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of sessions.splice(0)) await db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function pendingDatabase() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'siftwell-semantic-mutation-'));
  directories.push(directory);
  const dataPath = path.join(directory, 'test.db');
  const logPath = path.join(directory, 'test.log');
  const db = new DbmsBack(new RealFile(dataPath), new RealFile(logPath), config);
  sessions.push(db);
  await db.create();
  await db.insertDocument(parseRawDocument('docs', { id: 1, title: 'rabbit', score: 1 }));
  await db.insertDocument(parseRawDocument('docs', { id: 2, title: 'dolphin', score: 2 }));
  await db.commit();
  await db.close();
  const offline = await DbmsBack.open(new RealFile(dataPath), new RealFile(logPath));
  sessions.push(offline);
  await offline.editDocumentByID('docs', 1, 'score', 3);
  expect(offline.getPendingSemanticCollections()).toEqual(['docs']);
  await offline.commit();
  const originalRoots = offline.getVacuumHnswMetaSnapshot();
  await offline.close();
  return { dataPath, logPath, originalRoots, dataBefore: await readFile(dataPath) };
}

async function rows(db: DbmsBack, field = 'id') {
  const result = [];
  for await (const document of await db.cursor('docs', field)) result.push(document.asDocument());
  return result;
}

async function vectorCount(db: DbmsBack) {
  const file = (db as unknown as { freeblockFile: FreeBlockFile }).freeblockFile;
  const entries = [];
  for await (const entry of new VectorHeapFile(file, config.dimension).scan()) entries.push(entry);
  return entries.length;
}

const documents = [
  { id: 1, title: 'rabbit', score: 3 },
  { id: 2, title: 'dolphin', score: 2 },
];

describe('semantic rebuild mutation recovery', () => {
  it('rejects opening after graph insertion fails following vector allocation and leaves durable data unchanged', async () => {
    const state = await pendingDatabase();
    const vectorInsert = vi.spyOn(VectorHeapFile.prototype, 'insert');
    const graphInsert = vi
      .spyOn(HNSWGraphStorage.prototype, 'insertNode')
      .mockRejectedValueOnce(new Error('graph insertion failed'));
    await expect(DbmsBack.open(new RealFile(state.dataPath), new RealFile(state.logPath), config)).rejects.toThrow(
      MutationRecoveryRequiredError,
    );
    expect(vectorInsert).toHaveBeenCalledTimes(1);
    expect(graphInsert).toHaveBeenCalledTimes(1);
    expect(await readFile(state.dataPath)).toEqual(state.dataBefore);
    expect(await readFile(state.logPath)).toHaveLength(0);
    vi.restoreAllMocks();

    const verified = await DbmsBack.open(new RealFile(state.dataPath), new RealFile(state.logPath));
    sessions.push(verified);
    expect(verified.isHealthy).toBe(true);
    expect(verified.getPendingSemanticCollections()).toEqual(['docs']);
    expect(verified.getVacuumHnswMetaSnapshot()).toEqual(state.originalRoots);
    expect(await rows(verified)).toEqual(documents);
    expect(await rows(verified, 'score')).toEqual([documents[1], documents[0]]);
    expect(await vectorCount(verified)).toBe(2);
    await verified.close();

    const repaired = await DbmsBack.open(new RealFile(state.dataPath), new RealFile(state.logPath), config);
    sessions.push(repaired);
    expect(repaired.getPendingSemanticCollections()).toEqual([]);
    expect(await rows(repaired)).toEqual(documents);
    expect((await repaired.semanticSearch('docs', 'rabbit', 1)).map((document) => document.getId())).toEqual([1]);
    expect(await vectorCount(repaired)).toBe(2);
  });

  it('keeps the session healthy after discarding a completed unpublished graph when a later embedding fails', async () => {
    const state = await pendingDatabase();
    const embeddingFn = vi
      .fn(embedding)
      .mockResolvedValueOnce(new Float32Array([1, 0, 0]))
      .mockRejectedValueOnce(new Error('model unavailable for second document'));
    const vectorInsert = vi.spyOn(VectorHeapFile.prototype, 'insert');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = await DbmsBack.open(new RealFile(state.dataPath), new RealFile(state.logPath), {
      ...config,
      embeddingFn,
    });
    sessions.push(db);
    expect(embeddingFn).toHaveBeenCalledTimes(2);
    expect(vectorInsert).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      'Semantic reindex pending for "docs":',
      'model unavailable for second document',
    );
    expect(db.isHealthy).toBe(true);
    expect(db.getPendingSemanticCollections()).toEqual(['docs']);
    expect(db.getVacuumHnswMetaSnapshot()).toEqual(state.originalRoots);
    expect(await rows(db)).toEqual(documents);
    expect(await vectorCount(db)).toBe(2);
    await db.commit();
    await db.close();
    vi.restoreAllMocks();

    const reopened = await DbmsBack.open(new RealFile(state.dataPath), new RealFile(state.logPath), config);
    sessions.push(reopened);
    expect(reopened.isHealthy).toBe(true);
    expect(reopened.getPendingSemanticCollections()).toEqual([]);
    expect(await rows(reopened)).toEqual(documents);
    expect((await reopened.semanticSearch('docs', 'dolphin', 1)).map((document) => document.getId())).toEqual([2]);
    expect(await vectorCount(reopened)).toBe(2);
  });
});
