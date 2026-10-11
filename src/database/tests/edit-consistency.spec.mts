import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { RealFile } from '../../storage/file.mjs';
import { RecordStore, type EncodedDocument } from '../../storage/records/recordstore.mjs';
import { DbmsBack, type HnswConfig } from '../dbmsback.mjs';
import { Document, type FieldValue, parseRawDocument } from '../document.mjs';
import { SimpleDbms } from '../simpledbms.mjs';

const embedding = (text: string) => Promise.resolve(new Float32Array(text.includes('rabbit') ? [1, 0, 0] : [0, 1, 0]));
const semantic: HnswConfig = { dimension: 3, M: 4, embeddingFn: embedding };

async function documents(cursor: AsyncIterable<string>): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  for await (const json of cursor) result.push(JSON.parse(json) as Record<string, unknown>);
  return result;
}

function encodedEntries(encoded: EncodedDocument) {
  return Object.fromEntries(
    [...encoded.iterableEntries, ...encoded.nonIterableEntries].map((entry) => [entry.key, entry]),
  );
}

describe('document edit consistency', () => {
  it('preserves stored codecs, binary content, numeric identity and semantic/index state through edits and disk reopen', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'siftwell-edit-codecs-'));
    const dataPath = path.join(directory, 'data.db');
    const logPath = path.join(directory, 'data.log');
    const embeddingFn = vi.fn(embedding);
    const config = { ...semantic, embeddingFn };
    let db = new DbmsBack(new RealFile(dataPath), new RealFile(logPath), config);
    await db.create();
    try {
      const longText = 'rabbit compression preservation '.repeat(200);
      const binary = Buffer.from([0, 255, 128, 42].flatMap((byte) => Array<number>(1000).fill(byte)));
      for (const field of ['body', 'notes', 'inherited']) await db.setFieldIndexed('docs', field, false);
      db.setFieldCompressionDefaults('docs', { body: 'gzip', notes: 'gzip', inherited: 'gzip', binary: 'gzip' });
      await db.insertDocument(
        parseRawDocument('docs', {
          id: 42,
          title: 'rabbit original',
          score: 1,
          body: longText,
          notes: longText,
          inherited: longText,
          binary,
        }),
        { body: 'deflate', notes: 'off', binary: 'brotli' },
      );
      const original = encodedEntries((await db.getDocument(42, 'docs', true)) as EncodedDocument);
      expect(Object.fromEntries(Object.entries(original).map(([key, entry]) => [key, entry.compression]))).toEqual({
        title: 'none',
        score: 'none',
        body: 'deflate',
        notes: 'none',
        inherited: 'gzip',
        binary: 'brotli',
      });
      db.setFieldCompressionDefaults('docs', {
        body: 'brotli',
        notes: 'deflate',
        inherited: 'deflate',
        binary: 'gzip',
      });
      const beforeEditCalls = embeddingFn.mock.calls.length;
      await db.editDocumentByID('docs', 42, 'title', 'rabbit edited');
      expect(embeddingFn).toHaveBeenCalledTimes(beforeEditCalls + 1);
      const check = async (database: DbmsBack, title: string) => {
        const decoded = (await database.getDocument(42, 'docs')) as Document;
        expect(decoded.asDocument()).toEqual({
          id: 42,
          title,
          score: 1,
          body: longText,
          notes: longText,
          inherited: longText,
          binary,
        });
        const entries = encodedEntries((await database.getDocument(42, 'docs', true)) as EncodedDocument);
        for (const field of ['body', 'notes', 'inherited', 'binary']) expect(entries[field]).toEqual(original[field]);
        expect(database.getFieldIndexConfig('docs')).toMatchObject({
          title: true,
          score: true,
          body: false,
          notes: false,
          inherited: false,
          binary: false,
        });
        expect((await database.semanticSearch('docs', 'rabbit', 1)).map((doc) => doc.getId())).toEqual([42]);
        const indexed = [];
        for await (const doc of await database.cursor('docs', 'title')) indexed.push(doc.asDocument());
        expect(indexed).toEqual([decoded.asDocument()]);
      };
      await check(db, 'rabbit edited');
      await db.replaceDocumentByID(
        'docs',
        42,
        parseRawDocument('docs', {
          id: 42,
          title: 'rabbit replaced',
          score: 1,
          body: longText,
          notes: longText,
          inherited: longText,
          binary,
        }),
        undefined,
        true,
      );
      await check(db, 'rabbit replaced');
      await db.commit();
      await db.close();
      db = await DbmsBack.open(new RealFile(dataPath), new RealFile(logPath), config);
      await check(db, 'rabbit replaced');
    } finally {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps MIME sidecar edits and base64 image conversion consistent with replacement', async () => {
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const db = await SimpleDbms.create(data, log, semantic);
    await db.insertDocumentObject('docs', {
      id: 'a',
      title: 'rabbit',
      asset: 'YWJj',
      _asset_mime: 'application/octet-stream',
    });
    await db.setFieldIndexed('docs', 'asset', false);
    await db.editDocument('docs', 'a', '_asset_mime', 'image/png');
    await db.editDocument('docs', 'a', 'asset', 'eHl6');
    expect(JSON.parse(await db.getDocumentById('docs', 'a'))).toEqual({
      id: 'a',
      title: 'rabbit',
      asset: 'eHl6',
      _asset_mime: 'image/png',
    });
    const encoded = JSON.parse(await db.getDocumentById('docs', 'a', { encoded: true })) as {
      asset: { valueType: string };
    };
    expect(encoded.asset.valueType).toBe('buffer');
    expect(db.getFieldIndexConfig('docs')['asset']).toBe(false);
    await db.replaceDocument(
      'docs',
      'a',
      {
        id: 'a',
        title: 'rabbit',
        asset: 'eHl6',
        _asset_mime: 'image/png',
      },
      { preserveCompression: true },
    );
    await db.commit();
    await db.close();
    const reopened = await SimpleDbms.open(data, log, semantic);
    const reopenedEncoded = JSON.parse(await reopened.getDocumentById('docs', 'a', { encoded: true })) as {
      asset: { valueType: string };
    };
    expect(reopenedEncoded.asset.valueType).toBe('buffer');
    expect(JSON.parse(await reopened.getDocumentById('docs', 'a'))).toEqual({
      id: 'a',
      title: 'rabbit',
      asset: 'eHl6',
      _asset_mime: 'image/png',
    });
    await reopened.close();
  });

  it.each([NaN, Infinity, -Infinity])(
    'rejects %s from raw-object insertion, replacement and IDs without harming valid documents',
    async (value) => {
      const data = new MockFile(4096);
      const log = new MockFile(4096);
      const db = await SimpleDbms.create(data, log);
      await db.insertDocumentObject('docs', { id: 42, score: 1 });
      await expect(db.insertDocumentObject('docs', { id: 43, score: value })).rejects.toThrow(
        'Field score must be finite',
      );
      await expect(db.replaceDocument('docs', 42, { id: 42, score: value })).rejects.toThrow(
        'Field score must be finite',
      );
      await expect(db.insertDocumentObject('docs', { id: value, score: 1 })).rejects.toThrow(
        'Document id must be finite',
      );
      expect(JSON.parse(await db.getDocumentById('docs', 42))).toEqual({ id: 42, score: 1 });
      await db.commit();
      await db.close();
      const reopened = await SimpleDbms.open(data, log);
      expect(await documents(reopened.cursor('docs', 'score'))).toEqual([{ id: 42, score: 1 }]);
      await reopened.close();
    },
  );

  it.each([NaN, Infinity, -Infinity])(
    'rejects %s on single-field edits before record or semantic writes and remains usable',
    async (value) => {
      const data = new MockFile(4096);
      const log = new MockFile(4096);
      const embeddingFn = vi.fn(embedding);
      const config = { ...semantic, embeddingFn };
      const db = await SimpleDbms.create(data, log, config);
      await db.setFieldIndexed('docs', 'unindexed', false);
      await db.insertDocumentObject('docs', { id: 42, title: 'rabbit', score: 1, unindexed: 1 });
      await db.commit();
      const beforeCalls = embeddingFn.mock.calls.length;
      const write = vi.spyOn(RecordStore.prototype, 'writeRecord');
      try {
        for (const field of ['score', 'unindexed']) {
          await expect(db.editDocument('docs', 42, field, value)).rejects.toThrow(`Field ${field} must be finite`);
        }
        expect(write).not.toHaveBeenCalled();
        expect(embeddingFn).toHaveBeenCalledTimes(beforeCalls);
        expect(JSON.parse(await db.getDocumentById('docs', 42))).toEqual({
          id: 42,
          title: 'rabbit',
          score: 1,
          unindexed: 1,
        });
        expect(await documents(db.cursor('docs', 'score'))).toEqual([
          { id: 42, title: 'rabbit', score: 1, unindexed: 1 },
        ]);
        await db.editDocument('docs', 42, 'score', 2.5);
        await db.commit();
        await db.close();
        const reopened = await SimpleDbms.open(data, log, config);
        expect(JSON.parse(await reopened.getDocumentById('docs', 42))).toEqual({
          id: 42,
          title: 'rabbit',
          score: 2.5,
          unindexed: 1,
        });
        await reopened.close();
      } finally {
        write.mockRestore();
        await db.close();
      }
    },
  );

  it.each([NaN, Infinity, -Infinity])(
    'validates directly constructed documents containing %s before backend insertion and replacement',
    async (value) => {
      const data = new MockFile(4096);
      const log = new MockFile(4096);
      const embeddingFn = vi.fn(embedding);
      const config = { ...semantic, embeddingFn };
      const db = new DbmsBack(data, log, config);
      await db.create();
      await db.setFieldIndexed('docs', 'unindexed', false);
      await db.insertDocument(parseRawDocument('docs', { id: 42, title: 'rabbit', unindexed: 1 }));
      await db.commit();
      const beforeCalls = embeddingFn.mock.calls.length;
      const write = vi.spyOn(RecordStore.prototype, 'writeRecord');
      try {
        await expect(
          db.insertDocument(new Document('docs', 43, [['title', 'rabbit']], [['unindexed', value]])),
        ).rejects.toThrow('Field unindexed must be finite');
        await expect(
          db.replaceDocumentByID('docs', 42, new Document('docs', 42, [['title', 'rabbit']], [['unindexed', value]])),
        ).rejects.toThrow('Field unindexed must be finite');
        await expect(db.insertDocument(new Document('docs', value, [['title', 'rabbit']], []))).rejects.toThrow(
          'Document id must be finite',
        );
        expect(write).not.toHaveBeenCalled();
        expect(embeddingFn).toHaveBeenCalledTimes(beforeCalls);
        expect(((await db.getDocument(42, 'docs')) as Document).asDocument()).toEqual({
          id: 42,
          title: 'rabbit',
          unindexed: 1,
        });
        await db.insertDocument(parseRawDocument('docs', { id: 44, title: 'rabbit healthy', unindexed: -2.5 }));
        await db.commit();
        await db.close();
        const reopened = await DbmsBack.open(data, log, config);
        expect(((await reopened.getDocument(42, 'docs')) as Document).asDocument()).toEqual({
          id: 42,
          title: 'rabbit',
          unindexed: 1,
        });
        expect(((await reopened.getDocument(44, 'docs')) as Document).getFields()['unindexed']).toBe(-2.5);
        await reopened.close();
      } finally {
        write.mockRestore();
        await db.close();
      }
    },
  );

  it.each([null, undefined, {}, [], BigInt(1)])(
    'rejects unsupported edit and direct document values (%s) without changing state',
    async (value) => {
      const data = new MockFile(4096);
      const log = new MockFile(4096);
      const db = new DbmsBack(data, log);
      await db.create();
      await db.setFieldIndexed('docs', 'unindexed', false);
      await db.insertDocument(parseRawDocument('docs', { id: 'a', unindexed: 'original' }));
      await db.commit();
      const unsupported = value as FieldValue;
      await expect(db.editDocumentByID('docs', 'a', 'unindexed', unsupported)).rejects.toThrow(
        'Unsupported value type for field unindexed',
      );
      await expect(db.insertDocument(new Document('docs', 'b', [], [['unindexed', unsupported]]))).rejects.toThrow(
        'Unsupported value type for field unindexed',
      );
      expect(((await db.getDocument('a', 'docs')) as Document).getFields()['unindexed']).toBe('original');
      await db.insertDocument(parseRawDocument('docs', { id: 'c', unindexed: 'valid' }));
      await db.commit();
      await db.close();
    },
  );
});
