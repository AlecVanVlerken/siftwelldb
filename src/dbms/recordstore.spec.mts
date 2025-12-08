import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordStore } from './recordstore.mjs';
import { parseRawDocument } from './document.mjs';
import { MockFile } from '../core/mockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { getFreeBlockCount } from '../freeblockfile/freelist.mjs';

type StoreSetup = { recordStore: RecordStore; freeBlockFile: FreeBlockFile };

const openFiles: FreeBlockFile[] = [];

async function createRecordStore(blockSize = 256): Promise<StoreSetup> {
  const dataFile = new MockFile(512);
  const logFile = new MockFile(512);
  const atomicFile = new AtomicFile(dataFile, logFile);
  const freeBlockFile = new FreeBlockFile(atomicFile, blockSize);
  await freeBlockFile.create();
  await freeBlockFile.open();
  openFiles.push(freeBlockFile);

  return { recordStore: new RecordStore(freeBlockFile), freeBlockFile };
}

afterEach(async () => {
  for (const file of openFiles) {
    await file.close();
  }
  openFiles.length = 0;
});

describe('RecordStore', () => {
  it('writes and reads back a document', async () => {
    const { recordStore } = await createRecordStore();
    const doc = parseRawDocument('cities', { id: 'Leuven', population: 101032, _isProvinceCapital: true });

    const blockId = await recordStore.writeRecord(doc);
    const readDoc = await recordStore.readRecord(blockId);

    expect(readDoc?.asDocument()).toEqual(doc.asDocument());
  });

  it('returns null when reading a non-existent block', async () => {
    const { recordStore } = await createRecordStore();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await recordStore.readRecord(999);
      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('frees a block on delete', async () => {
    const { recordStore, freeBlockFile } = await createRecordStore();
    const doc = parseRawDocument('cities', { id: 'Leuven', population: 101032 });

    const blockId = await recordStore.writeRecord(doc);
    await recordStore.deleteRecord(blockId);

    const freeCount = await getFreeBlockCount(freeBlockFile);
    expect(freeCount).toBe(1);
  });

  it('reuses freed blocks when allocating new records', async () => {
    const { recordStore } = await createRecordStore();
    const doc1 = parseRawDocument('cities', { id: 'first', population: 1 });
    const firstBlock = await recordStore.writeRecord(doc1);

    await recordStore.deleteRecord(firstBlock);

    const doc2 = parseRawDocument('cities', { id: 'second', population: 2 });
    const secondBlock = await recordStore.writeRecord(doc2);

    expect(secondBlock).toBe(firstBlock);

    const fetched = await recordStore.readRecord(secondBlock);
    expect(fetched?.asDocument()).toEqual(doc2.asDocument());
  });

  it('stores large documents across multiple blocks when needed', async () => {
    const { recordStore, freeBlockFile } = await createRecordStore(20); // small blocks force chaining
    const doc = parseRawDocument('tiny', { id: 'oversized', payload: 'x'.repeat(50) });

    const firstBlock = await recordStore.writeRecord(doc);
    const readBack = await recordStore.readRecord(firstBlock);

    // Ensure data round-trips
    expect(readBack?.asDocument()).toEqual(doc.asDocument());

    // And the first block points to a successor (multi-block storage)
    const block = await freeBlockFile.readBlock(firstBlock);
    const nextBlockId = block.readUInt32LE(1);
    expect(nextBlockId).toBeGreaterThan(0);
  });
});
