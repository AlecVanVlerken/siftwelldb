import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { QueryLanguage } from '../../query/querylanguage.mjs';
import { RealFile } from '../../storage/file.mjs';
import { RecordStore } from '../../storage/records/recordstore.mjs';
import { DbmsBack } from '../dbmsback.mjs';
import { Document, documentToJSON, JSONtoDocument, parseRawDocument } from '../document.mjs';
import { SimpleDbms } from '../simpledbms.mjs';

const malformedIds = ['\ud800', '\ud801', '\udfff', 'prefix\ud800suffix', '\ud800\ud800\udc00', '\udc00\ud800'];
const malformedError = /(?:Document id|Query string).*unpaired.*surrogate/i;

async function collect(cursor: AsyncIterable<string>): Promise<Record<string, unknown>[]> {
  const documents: Record<string, unknown>[] = [];
  for await (const json of cursor) documents.push(JSON.parse(json) as Record<string, unknown>);
  return documents;
}

describe('document identity validation', () => {
  it('serializes prototype property field names and binary values without losing own properties', () => {
    const document = parseRawDocument(
      'docs',
      Object.fromEntries([
        ['id', 'normal'],
        ['__proto__', Buffer.from([0, 255])],
        ['constructor', 'own value'],
        ['toString', 'own text'],
      ]),
    );
    const serialized = JSON.parse(documentToJSON(document)) as Record<string, unknown>;
    expect(Object.keys(serialized).sort()).toEqual(['__proto__', 'constructor', 'id', 'toString']);
    expect(Object.hasOwn(serialized, '__proto__')).toBe(true);
    expect(serialized['__proto__']).toBe('AP8=');
    expect(serialized['constructor']).toBe('own value');
    expect(serialized['toString']).toBe('own text');
  });

  it('returns encoded metadata for every prototype property field name', async () => {
    const db = await SimpleDbms.create(new MockFile(4096), new MockFile(4096));
    const fields = ['__proto__', 'constructor', 'toString'];
    const text = 'stored prototype field codec '.repeat(50);
    try {
      await db.insertDocumentObject(
        'docs',
        Object.fromEntries([['id', 'normal'], ...fields.map((field) => [field, text])]),
        { compression: Object.fromEntries(fields.map((field) => [field, 'gzip'])) },
      );
      const encoded = JSON.parse(await db.getDocumentById('docs', 'normal', { encoded: true })) as Record<
        string,
        unknown
      >;
      expect(Object.keys(encoded).sort()).toEqual(['__proto__', 'constructor', 'id', 'toString']);
      for (const field of fields) {
        expect(Object.hasOwn(encoded, field)).toBe(true);
        expect(encoded[field]).toMatchObject({ valueType: 'string', compression: 'gzip' });
      }
    } finally {
      await db.close();
    }
  });

  it.each(malformedIds)('rejects malformed UTF-16 ID %j through both parsers', (id) => {
    expect(() => parseRawDocument('docs', { id, title: 'original' })).toThrow(malformedError);
    expect(() => JSONtoDocument(JSON.stringify({ id, title: 'original' }), 'docs')).toThrow(malformedError);
  });

  it.each(['\ud800', '\ud801', '\udfff'])(
    'rejects invalid ID %j before every direct backend addressing operation',
    async (id) => {
      const db = new DbmsBack(new MockFile(4096), new MockFile(4096));
      await db.create();
      try {
        await db.insertDocument(parseRawDocument('docs', { id: '\ufffd', title: 'untouched' }));
        await db.commit();
        const operations = [
          () => db.getDocument(id, 'docs'),
          () => db.getDocument(id, 'docs', true),
          () => db.getDocumentBlockId('docs', id),
          () => db.getDocumentStoredBytes('docs', id),
          () => db.editDocumentByID('docs', id, 'title', 'incorrect'),
          () => db.replaceDocumentByID('docs', id, parseRawDocument('docs', { id: '\ufffd', title: 'incorrect' })),
          () => db.deleteDocument(id, 'docs'),
          () => db.relocateDocument('docs', id),
          () => db.tombstoneSemanticEntry(id, 'docs'),
          () => db.cursor('docs', 'id', id),
          () => db.getDocumentBlockId('missing', id),
        ];
        for (const operation of operations) {
          await expect(operation()).rejects.toThrow(malformedError);
          expect(db.isHealthy).toBe(true);
          expect(((await db.getDocument('\ufffd', 'docs')) as Document).asDocument()).toEqual({
            id: '\ufffd',
            title: 'untouched',
          });
        }
        await db.insertDocument(parseRawDocument('docs', { id: 'later', title: 'valid' }));
        await db.commit();
      } finally {
        await db.close();
      }
    },
  );

  it('validates programmatically constructed Documents before insertion or replacement writes', async () => {
    const db = new DbmsBack(new MockFile(4096), new MockFile(4096));
    await db.create();
    const write = vi.spyOn(RecordStore.prototype, 'writeRecord');
    try {
      await db.insertDocument(parseRawDocument('docs', { id: 'valid', title: 'original' }));
      write.mockClear();
      const invalid = new Document('docs', '\ud800', [['title', 'bad']], []);
      expect(() => db.validateDocument(invalid)).toThrow(malformedError);
      await expect(db.insertDocument(invalid)).rejects.toThrow(malformedError);
      await expect(db.replaceDocumentByID('docs', 'valid', invalid)).rejects.toThrow(malformedError);
      expect(write).not.toHaveBeenCalled();
      expect(db.isHealthy).toBe(true);
      expect(((await db.getDocument('valid', 'docs')) as Document).asDocument()).toEqual({
        id: 'valid',
        title: 'original',
      });
    } finally {
      write.mockRestore();
      await db.close();
    }
  });

  it('rejects malformed IDs through SimpleDbms and SQL without affecting the replacement-character document', async () => {
    const db = await SimpleDbms.create(new MockFile(4096), new MockFile(4096));
    try {
      await db.insertDocumentObject('docs', { id: '\ufffd', title: 'untouched' });
      const sql = new QueryLanguage(db);
      const invalid = '\ud800';
      const operations = [
        () => db.insertDocumentObject('docs', { id: invalid, title: 'bad' }),
        () => db.getDocumentById('docs', invalid),
        () => db.getDocumentObjectById('docs', invalid),
        () => db.getDocumentStoredBytes('docs', invalid),
        () => db.editDocument('docs', invalid, 'title', 'bad'),
        () => db.replaceDocument('docs', invalid, { id: '\ufffd', title: 'bad' }),
        () => db.deleteDocumentById('docs', invalid),
        () => collect(db.cursorEqual('docs', 'id', invalid)),
        () => sql.execute(`INSERT INTO docs VALUES {id: '${invalid}', title: 'bad'}`),
        () => sql.execute(`SELECT * FROM docs WHERE id = '${invalid}'`),
        () => sql.execute(`UPDATE docs SET title = 'bad' WHERE id = '${invalid}'`),
        () => sql.execute(`DELETE FROM docs WHERE id = '${invalid}'`),
      ];
      for (const operation of operations) {
        await expect(operation()).rejects.toThrow(malformedError);
        expect(db.isHealthy).toBe(true);
        expect(await db.getDocumentObjectById('docs', '\ufffd')).toEqual({ id: '\ufffd', title: 'untouched' });
      }
      await db.commit();
    } finally {
      await db.close();
    }
  });

  it('preserves distinct valid Unicode, empty, punctuation and numeric IDs across disk reopening and vacuum', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'siftwell-document-identity-'));
    const dataPath = path.join(directory, 'data.db');
    const logPath = path.join(directory, 'data.log');
    let db = await SimpleDbms.create(new RealFile(dataPath), new RealFile(logPath));
    let compacted: SimpleDbms | undefined;
    const ids = [
      '',
      'metadata',
      'edit',
      '.',
      '..',
      '42',
      'a/b?c#d',
      'A',
      'a',
      'constructor',
      'toString',
      '__proto__',
      'nul\u0000inside',
      'é',
      'e\u0301',
      '\ud800\udc00',
      '🙂',
      '\ufffd',
    ];
    try {
      for (const [index, id] of ids.entries()) await db.insertDocumentObject('docs', { id, title: `value-${index}` });
      await db.insertDocumentObject('numbers', { id: 42, title: 'numeric' });
      const verify = async (database: SimpleDbms) => {
        for (const [index, id] of ids.entries()) {
          expect(await database.getDocumentObjectById('docs', id)).toEqual({ id, title: `value-${index}` });
          expect(await collect(database.cursorEqual('docs', 'title', `value-${index}`))).toEqual([
            { id, title: `value-${index}` },
          ]);
        }
        expect(await database.getDocumentObjectById('numbers', 42)).toEqual({ id: 42, title: 'numeric' });
        await expect(database.getDocumentById('numbers', '42')).rejects.toThrow(/id|not found/i);
        await expect(database.getDocumentById('docs', 42)).rejects.toThrow(/id|not found/i);
        await expect(database.deleteDocumentById('numbers', '42')).rejects.toThrow(/id|not found/i);
        await expect(database.deleteDocumentById('docs', 42)).rejects.toThrow(/id|not found/i);
        expect(database.isHealthy).toBe(true);
      };
      await verify(db);
      await db.commit();
      await db.close();
      db = await SimpleDbms.open(new RealFile(dataPath), new RealFile(logPath));
      await verify(db);
      await db.editDocument('docs', '', 'title', 'temporary');
      await db.editDocument('docs', '', 'title', 'value-0');
      await db.insertDocumentObject('docs', { id: 'delete-me', title: 'temporary' });
      await db.deleteDocumentById('docs', 'delete-me');
      const backend = (db as unknown as { dbmsback: DbmsBack }).dbmsback;
      await backend.relocateDocument('docs', '🙂');
      await db.commit();
      await verify(db);
      const vacuumData = path.join(directory, 'vacuum.db');
      const vacuumLog = path.join(directory, 'vacuum.log');
      compacted = await db.vacuumCompactInto(new RealFile(vacuumData), new RealFile(vacuumLog));
      await verify(compacted);
      await compacted.close();
      compacted = await SimpleDbms.open(new RealFile(vacuumData), new RealFile(vacuumLog));
      await verify(compacted);
      await expect(compacted.getDocumentById('docs', 'delete-me')).rejects.toThrow('Document not found');
    } finally {
      await compacted?.close();
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses legacy malformed record identities without rewriting or deleting the original disk data', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'siftwell-legacy-document-identity-'));
    const dataPath = path.join(directory, 'data.db');
    const logPath = path.join(directory, 'data.log');
    const semantic = {
      dimension: 3,
      M: 4,
      embeddingFn: () => Promise.resolve(new Float32Array([1, 0, 0])),
    };
    let db = new DbmsBack(new RealFile(dataPath), new RealFile(logPath), semantic);
    await db.create();
    const legacyWrite = vi.spyOn(RecordStore.prototype, 'writeRecord').mockImplementationOnce(function (
      this: RecordStore,
      document: Document,
    ) {
      // Old releases encoded this exact malformed ID into the U+FFFD primary key,
      // while JSON record storage retained the original surrogate escape.
      return this.writeRecordEncoded({
        collection: document.getCollectionName(),
        id: '\ud800',
        iterableEntries: [
          {
            key: 'title',
            valueType: 'string',
            compression: 'none',
            payloadBase64: Buffer.from('legacy contents').toString('base64'),
          },
        ],
        nonIterableEntries: [],
      });
    });
    try {
      await db.insertDocument(parseRawDocument('docs', { id: '\ufffd', title: 'legacy contents' }));
      legacyWrite.mockRestore();
      await db.commit();
      const pointer = (await db.getDocumentBlockId('docs', '\ufffd'))!;
      await db.close();
      const committed = await readFile(dataPath);
      db = await DbmsBack.open(new RealFile(dataPath), new RealFile(logPath), semantic);
      await expect(db.getDocument('\ud800', 'docs')).rejects.toThrow(malformedError);
      await expect(db.getDocument('\ufffd', 'docs')).rejects.toThrow(/malformed|unpaired.*surrogate|legacy/i);
      await expect(db.getDocument('\ufffd', 'docs', true)).rejects.toThrow(/malformed|unpaired.*surrogate|legacy/i);
      await expect(db.deleteDocument('\ufffd', 'docs')).rejects.toThrow(/malformed|unpaired.*surrogate|legacy/i);
      await expect(db.editDocumentByID('docs', '\ufffd', 'title', 'bad')).rejects.toThrow(
        /malformed|unpaired.*surrogate|legacy/i,
      );
      await expect(db.tombstoneSemanticEntry('\ufffd', 'docs')).rejects.toThrow(
        /malformed|unpaired.*surrogate|legacy/i,
      );
      await expect(db.semanticSearch('docs', 'legacy contents', 1)).rejects.toThrow(
        /malformed|unpaired.*surrogate|legacy/i,
      );
      const cursor = await db.cursor('docs', 'id');
      await expect(cursor[Symbol.asyncIterator]().next()).rejects.toThrow(/malformed|unpaired.*surrogate|legacy/i);
      await expect(
        db.vacuumCompactInto(
          new RealFile(path.join(directory, 'vacuum.db')),
          new RealFile(path.join(directory, 'vacuum.log')),
        ),
      ).rejects.toThrow(/malformed|unpaired.*surrogate|legacy/i);
      expect(db.isHealthy).toBe(true);
      const store = (db as unknown as { recordStore: RecordStore }).recordStore;
      expect((await store.readRecord(pointer))?.asDocument()).toEqual({ id: '\ud800', title: 'legacy contents' });
      await db.commit();
      expect(await readFile(dataPath)).toEqual(committed);
      await db.close();
      db = await DbmsBack.open(new RealFile(dataPath), new RealFile(logPath), semantic);
      await expect(db.getDocument('\ufffd', 'docs')).rejects.toThrow(/malformed|unpaired.*surrogate|legacy/i);
    } finally {
      legacyWrite.mockRestore();
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
