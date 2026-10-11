import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DbmsBack } from '../dbmsback.mjs';
import { parseRawDocument, type Document } from '../document.mjs';
import { RealFile } from '../../storage/file.mjs';
import { FreeBlockFile, MutationRecoveryRequiredError } from '../../storage/blocks/freeblockfile.mjs';
import { BlockLeafNode } from '../../indexes/btree/leafnode.mjs';

const directories: string[] = [];
const sessions: DbmsBack[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of sessions.splice(0)) await db.close();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected test directory');
    await rm(directory, { recursive: true, force: true });
  }
});

async function indexedIds(db: DbmsBack, field: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const document of await db.cursor('docs', field)) ids.push(document.getId() as string);
  return ids;
}

describe('document deletion merge durability', () => {
  it('rejects a real leaf merge failure and preserves every committed primary/secondary entry on disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'siftwell-merge-failure-'));
    directories.push(directory);
    const dataPath = join(directory, 'test.db');
    const logPath = dataPath + '.log';
    const db = new DbmsBack(new RealFile(dataPath), new RealFile(logPath));
    sessions.push(db);
    await db.create();
    // Long IDs fit the validated key limit but force several leaves in both indexes.
    const ids = Array.from({ length: 6 }, (_, index) => index.toString().padStart(4, '0') + 'x'.repeat(1250));
    for (const id of ids) await db.insertDocument(parseRawDocument('docs', { id, tag: 'same' }));
    await db.commit();
    const dataBefore = await readFile(dataPath);
    expect(await indexedIds(db, 'id')).toEqual(ids);
    expect(await indexedIds(db, 'tag')).toEqual(ids);

    const file = (db as unknown as { freeblockFile: FreeBlockFile }).freeblockFile;
    const fault = new Error('injected merged leaf block deallocation failure');
    const free = vi.spyOn(file, 'freeBlock');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The mock explicitly supplies the original leaf as this.
    const originalMerge = BlockLeafNode.prototype.mergeWithNext;
    let entriesBeforeMerge = 0;
    let entriesAfterMerge = 0;
    const merge = vi.spyOn(BlockLeafNode.prototype, 'mergeWithNext').mockImplementationOnce(async function (
      this: BlockLeafNode,
      ...args
    ) {
      entriesBeforeMerge = this.getEntryCount();
      free.mockRejectedValueOnce(fault);
      try {
        await originalMerge.apply(this, args);
      } finally {
        entriesAfterMerge = this.getEntryCount();
      }
    });
    await expect(db.deleteDocument(ids[0], 'docs')).rejects.toThrow(MutationRecoveryRequiredError);
    expect(merge).toHaveBeenCalledOnce();
    expect(free).toHaveBeenCalledOnce();
    expect(entriesAfterMerge).toBeGreaterThan(entriesBeforeMerge);
    vi.restoreAllMocks();

    await expect(db.insertDocument(parseRawDocument('docs', { id: 'later', tag: 'later' }))).rejects.toThrow(
      'close and reopen',
    );
    await expect(db.commit()).rejects.toThrow('close and reopen');
    await expect(file.commit()).rejects.toThrow('close and reopen');
    await expect(indexedIds(db, 'id')).rejects.toThrow('close and reopen');
    await expect(indexedIds(db, 'tag')).rejects.toThrow('close and reopen');
    await db.close();
    expect(await readFile(dataPath)).toEqual(dataBefore);
    expect(await readFile(logPath)).toHaveLength(0);

    const reopened = await DbmsBack.open(new RealFile(dataPath), new RealFile(logPath));
    sessions.push(reopened);
    expect(await indexedIds(reopened, 'id')).toEqual(ids);
    expect(await indexedIds(reopened, 'tag')).toEqual(ids);
    for (const id of ids)
      expect(((await reopened.getDocument(id, 'docs')) as Document).asDocument()).toEqual({ id, tag: 'same' });
    await reopened.deleteDocument(ids[0], 'docs');
    await reopened.commit();
    await reopened.close();

    const final = await DbmsBack.open(new RealFile(dataPath), new RealFile(logPath));
    sessions.push(final);
    expect(await indexedIds(final, 'id')).toEqual(ids.slice(1));
    expect(await indexedIds(final, 'tag')).toEqual(ids.slice(1));
    await expect(final.getDocument(ids[0], 'docs')).rejects.toThrow('Document not found');
    for (const id of ids.slice(1))
      expect(((await final.getDocument(id, 'docs')) as Document).asDocument()).toEqual({ id, tag: 'same' });
  });
});
