// author: Frederik Caeyman, Matisse De Gauquier
// date: 2025-12-08

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordStore } from '../recordstore.mjs';
import { parseRawDocument, type Document } from '../../../database/document.mjs';
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
    const result = await recordStore.readRecord(999);
    expect(result).toBeNull();
  });

  it('propagates read failures with the original cause instead of returning absence', async () => {
    const { recordStore, freeBlockFile } = await createRecordStore();
    const blockId = await recordStore.writeRecord(parseRawDocument('docs', { id: 'B', value: 'original' }));
    const failure = new Error('injected record read failure');
    const read = vi.spyOn(freeBlockFile, 'readBlock').mockRejectedValue(failure);
    try {
      await expect(recordStore.readRecord(blockId)).rejects.toMatchObject({ cause: failure });
      await expect(recordStore.readRecordEncoded(blockId)).rejects.toMatchObject({ cause: failure });
    } finally {
      read.mockRestore();
    }
  });

  it('rejects corrupt record JSON instead of returning absence', async () => {
    const { recordStore, freeBlockFile } = await createRecordStore();
    const blockId = await recordStore.writeRecord(parseRawDocument('docs', { id: 'B' }));
    const block = await freeBlockFile.readBlock(blockId);
    block[9] = '!'.charCodeAt(0);
    freeBlockFile._setDirtyBlock(blockId, block);
    await expect(recordStore.readRecord(blockId)).rejects.toThrow(/record.*block/i);
    await expect(recordStore.readRecordEncoded(blockId)).rejects.toThrow(/record.*block/i);
  });

  it('frees a block on delete', async () => {
    const { recordStore, freeBlockFile } = await createRecordStore();
    const doc = parseRawDocument('cities', { id: 'Leuven', population: 101032 });

    const blockId = await recordStore.writeRecord(doc);
    await recordStore.deleteRecord(blockId);

    const freeCount = await getFreeBlockCount(freeBlockFile);
    expect(freeCount).toBe(1);
  });

  it('validates decoded compressed and binary values while reusing the record traversal for deletion', async () => {
    const { recordStore, freeBlockFile } = await createRecordStore();
    const document = parseRawDocument('docs', {
      id: 'large',
      title: 'compressed text '.repeat(300),
      image: Buffer.alloc(2000, 7),
    });
    const pointer = await recordStore.writeRecord(document, { compressionDefaults: { title: 'gzip' } });
    await freeBlockFile.commit();
    const chain = await recordStore.readRecordBlockChain(pointer);
    expect(chain.length).toBeGreaterThan(1);
    const read = vi.spyOn(freeBlockFile, 'readBlock');
    const chainRead = vi.spyOn(recordStore, 'readRecordBlockChain');
    const free = vi.spyOn(freeBlockFile, 'freeBlock');
    const validate = vi.fn((decoded: Document | null) => {
      expect(decoded?.asDocument()).toEqual(document.asDocument());
      expect(free).not.toHaveBeenCalled();
      return Promise.resolve();
    });

    await recordStore.deleteRecord(pointer, validate);

    expect(validate).toHaveBeenCalledOnce();
    expect(chainRead).not.toHaveBeenCalled();
    // One decoding pass plus freeBlock's existing checked read; no extra chain walk.
    for (const block of chain) expect(read.mock.calls.filter(([id]) => id === block)).toHaveLength(2);
    expect(free).toHaveBeenCalledTimes(chain.length);
    expect(await getFreeBlockCount(freeBlockFile)).toBe(chain.length);
  });

  it('does not free any record blocks when identity validation fails', async () => {
    const { recordStore, freeBlockFile } = await createRecordStore();
    const document = parseRawDocument('docs', { id: 'wrong-owner', image: Buffer.alloc(2000, 7) });
    const pointer = await recordStore.writeRecord(document);
    const failure = new Error('record belongs to a different collection');
    const free = vi.spyOn(freeBlockFile, 'freeBlock');

    await expect(recordStore.deleteRecord(pointer, () => Promise.reject(failure))).rejects.toBe(failure);

    expect(free).not.toHaveBeenCalled();
    expect((await recordStore.readRecord(pointer))?.asDocument()).toEqual(document.asDocument());
    expect(await getFreeBlockCount(freeBlockFile)).toBe(0);
  });

  it('decodes compressed field payloads before validating or freeing a record', async () => {
    const { recordStore, freeBlockFile } = await createRecordStore();
    const pointer = await recordStore.writeRecordEncoded({
      collection: 'docs',
      id: 'corrupt',
      iterableEntries: [{ key: 'body', valueType: 'string', compression: 'gzip', payloadBase64: 'bm90LWd6aXA=' }],
      nonIterableEntries: [],
    });
    const validate = vi.fn(() => Promise.resolve());
    const free = vi.spyOn(freeBlockFile, 'freeBlock');

    await expect(recordStore.deleteRecord(pointer, validate)).rejects.toThrow(/Cannot read record/);

    expect(validate).not.toHaveBeenCalled();
    expect(free).not.toHaveBeenCalled();
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

  it('reads a smaller record from a reused block with nonzero bytes after its payload', async () => {
    const { recordStore } = await createRecordStore(4096);
    const original = await recordStore.writeRecord(parseRawDocument('docs', { id: 'large', title: 'x'.repeat(1000) }));
    await recordStore.deleteRecord(original);
    const smaller = parseRawDocument('docs', { id: 'small', score: 1 });
    const reused = await recordStore.writeRecord(smaller);
    expect(reused).toBe(original);
    expect((await recordStore.readRecord(reused))?.asDocument()).toEqual(smaller.asDocument());
  });

  it.each(['cycle', 'length'] as const)('rejects a malformed record %s before freeing its chain', async (failure) => {
    const { recordStore, freeBlockFile } = await createRecordStore(4096);
    const pointer = await recordStore.writeRecord(parseRawDocument('docs', { id: 'A', score: 1 }));
    const block = await freeBlockFile.readBlock(pointer);
    if (failure === 'cycle') block.writeUInt32LE(pointer, 1);
    else block.writeUInt32BE(8192, 5);
    freeBlockFile._setDirtyBlock(pointer, block);
    await expect(recordStore.readRecord(pointer)).rejects.toThrow(
      failure === 'cycle' ? 'Cyclic record chain' : 'length exceeds',
    );
    await expect(recordStore.readRecordEncoded(pointer)).rejects.toThrow(
      failure === 'cycle' ? 'Cyclic record chain' : 'length exceeds',
    );
    const validate = vi.fn(() => Promise.resolve());
    const free = vi.spyOn(freeBlockFile, 'freeBlock');
    await expect(recordStore.deleteRecord(pointer, validate)).rejects.toThrow(
      failure === 'cycle' ? 'Cyclic record chain' : 'length exceeds',
    );
    expect(validate).not.toHaveBeenCalled();
    expect(free).not.toHaveBeenCalled();
    if (failure === 'cycle') {
      await expect(recordStore.deleteRecord(pointer)).rejects.toThrow('Cyclic record chain');
      expect((await freeBlockFile.readBlock(pointer))[0]).toBe(2);
    }
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
