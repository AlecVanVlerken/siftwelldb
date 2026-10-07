// author: Frederik Caeyman, Matisse De Gauquier
// date: 2025-12-08

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordStore } from '../recordstore.mjs';
import { parseRawDocument } from '../../../database/document.mjs';
import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { AtomicFile } from '../../wal/atomicfile.mjs';
import { FreeBlockFile } from '../../blocks/freeblockfile.mjs';
import { getFreeBlockCount } from '../../blocks/freelist.mjs';

type StoreSetup = { recordStore: RecordStore; freeBlockFile: FreeBlockFile };

const openFiles: FreeBlockFile[] = [];

async function createRecordStore(blockSize = 256): Promise<StoreSetup> {
  const dataFile = new MockFile(512);
  const logFile = new MockFile(512);
  const atomicFile = new AtomicFile(dataFile, logFile);
  const freeBlockFile = new FreeBlockFile(atomicFile, blockSize);
  await freeBlockFile.create();
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

    const result = await recordStore.readRecord(999);
    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
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

  it('returns encoded fields with compression metadata', async () => {
    const { recordStore } = await createRecordStore();
    const doc = parseRawDocument('docs', { id: 'enc1', title: 'A'.repeat(300), count: 7 });

    const blockId = await recordStore.writeRecord(doc, { compressionDefaults: { title: 'gzip' } });
    const encoded = await recordStore.readRecordEncoded(blockId);

    expect(encoded).not.toBeNull();
    const title = encoded!.iterableEntries.find((entry) => entry.key === 'title');
    expect(title?.compression).toBe('gzip');
    expect(title?.payloadBase64).toBeTypeOf('string');
  });

  it('stores a smaller payload with gzip than without compression for repetitive text', async () => {
    const { recordStore } = await createRecordStore();
    const repetitive = 'ABCD '.repeat(500);
    const doc = parseRawDocument('docs', { id: 'cmp1', content: repetitive });

    const compressedBlock = await recordStore.writeRecord(doc, { compressionDefaults: { content: 'gzip' } });
    const uncompressedBlock = await recordStore.writeRecord(doc, { compressionDefaults: { content: 'none' } });

    const compressed = await recordStore.readRecordEncoded(compressedBlock);
    const uncompressed = await recordStore.readRecordEncoded(uncompressedBlock);

    expect(compressed).not.toBeNull();
    expect(uncompressed).not.toBeNull();

    const compressedEntry = compressed!.iterableEntries.find((entry) => entry.key === 'content');
    const uncompressedEntry = uncompressed!.iterableEntries.find((entry) => entry.key === 'content');

    expect(compressedEntry?.compression).toBe('gzip');
    expect(uncompressedEntry?.compression).toBe('none');

    const compressedBytes = Buffer.from(compressedEntry!.payloadBase64, 'base64').length;
    const uncompressedBytes = Buffer.from(uncompressedEntry!.payloadBase64, 'base64').length;

    expect(compressedBytes).toBeLessThan(uncompressedBytes);
  });

  it('estimates block savings with the same serializer used for writes', async () => {
    const { recordStore } = await createRecordStore();
    const doc = parseRawDocument('docs', { id: 'cmp2', content: 'ABCD '.repeat(1200) });

    const raw = recordStore.estimateRecordStorage(doc, { compressionDefaults: { content: 'none' } });
    const compressed = recordStore.estimateRecordStorage(doc, { compressionDefaults: { content: 'zstd-fast' } });

    expect(compressed.serializedBytes).toBeLessThan(raw.serializedBytes);
    expect(compressed.blocks).toBeLessThanOrEqual(raw.blocks);
    expect(raw.blockSize).toBe(compressed.blockSize);
  });
});
