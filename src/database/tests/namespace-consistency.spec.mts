import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DbmsBack, type HnswConfig } from '../dbmsback.mjs';
import { parseRawDocument, type Document } from '../document.mjs';
import { safeDictionary, semanticIndexKey } from '../identity.mjs';
import type { CompressionAlgorithm } from '../compression.mjs';
import { RealFile } from '../../storage/file.mjs';
import type { EncodedDocument } from '../../storage/records/recordstore.mjs';
import type { FreeBlockFile } from '../../storage/blocks/freeblockfile.mjs';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';

const semantic: HnswConfig = {
  dimension: 3,
  M: 4,
  embeddingFn: () => Promise.resolve(new Float32Array([1, 0, 0])),
};

async function rows(db: DbmsBack, collection: string, field = 'id') {
  const result = [];
  for await (const document of await db.cursor(collection, field)) result.push(document.asDocument());
  return result;
}

async function diskFixture(
  run: (fixture: {
    create: (name: string, config?: HnswConfig) => Promise<DbmsBack>;
    open: (name: string, config?: HnswConfig) => Promise<DbmsBack>;
    close: (db: DbmsBack) => Promise<void>;
    data: (name: string) => string;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'siftwell-namespaces-'));
  const active = new Set<DbmsBack>();
  const files = (name: string) =>
    [new RealFile(path.join(directory, `${name}.db`)), new RealFile(path.join(directory, `${name}.log`))] as const;
  try {
    await run({
      create: async (name, config) => {
        const db = new DbmsBack(...files(name), config);
        await db.create();
        active.add(db);
        return db;
      },
      open: async (name, config) => {
        const db = await DbmsBack.open(...files(name), config);
        active.add(db);
        return db;
      },
      close: async (db) => {
        await db.close();
        active.delete(db);
      },
      data: (name) => path.join(directory, `${name}.db`),
    });
  } finally {
    for (const db of active) await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function codecs(document: EncodedDocument) {
  return Object.fromEntries(
    [...document.iterableEntries, ...document.nonIterableEntries].map((entry) => [entry.key, entry.compression]),
  );
}

describe('collection and field namespace consistency', () => {
  it('preserves prototype property field names through serialization, indexes and reopening', async () => {
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const db = new DbmsBack(data, log);
    await db.create();
    const raw = JSON.parse('{"id":"a","__proto__":"proto","constructor":"ctor","toString":"text"}') as Record<
      string,
      unknown
    >;
    try {
      await db.insertDocument(parseRawDocument('constructor', raw));
      expect(await rows(db, 'constructor', '__proto__')).toEqual([raw]);
      expect(await rows(db, 'constructor', 'constructor')).toEqual([raw]);
      await db.commit();
    } finally {
      await db.close();
    }
    const reopened = await DbmsBack.open(data, log);
    try {
      expect(await rows(reopened, 'constructor', 'toString')).toEqual([raw]);
      expect(reopened.listCollections()).toEqual(['constructor']);
    } finally {
      await reopened.close();
    }
  });

  it('keeps delimiter-containing collection and field cache keys independent', async () => {
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const db = new DbmsBack(data, log);
    await db.create();
    try {
      await db.insertDocument(parseRawDocument('a', { id: 'one', 'b:c': 'first' }));
      await db.insertDocument(parseRawDocument('a:b', { id: 'two', c: 'second' }));
      expect(await rows(db, 'a', 'b:c')).toEqual([{ id: 'one', 'b:c': 'first' }]);
      expect(await rows(db, 'a:b', 'c')).toEqual([{ id: 'two', c: 'second' }]);
      await db.commit();
    } finally {
      await db.close();
    }
  });

  it('deletes only the exact semantic collection when names share a prefix', async () => {
    const data = new MockFile(4096);
    const log = new MockFile(4096);
    const db = new DbmsBack(data, log, semantic);
    await db.create();
    try {
      await db.insertDocument(parseRawDocument('a', { id: 'one', title: 'first' }));
      await db.insertDocument(parseRawDocument('a::b', { id: 'two', title: 'second' }));
      await db.commit();
      await db.deleteCollection('a');
      expect((await db.semanticSearch('a::b', 'second', 1)).map((doc) => doc.getId())).toEqual(['two']);
      await db.commit();
    } finally {
      await db.close();
    }
    const reopened = await DbmsBack.open(data, log, semantic);
    try {
      expect((await reopened.semanticSearch('a::b', 'second', 1)).map((doc) => doc.getId())).toEqual(['two']);
    } finally {
      await reopened.close();
    }
  });

  it('preserves special-name metadata, compression and binary values across instances, relocations and full vacuum', async () => {
    const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
    const names = [
      '__proto__',
      'constructor',
      'toString',
      'a',
      'a:b',
      'a::b',
      '__ordinary',
      '',
      'é',
      'e\u0301',
      '\ud800',
    ];
    await diskFixture(async (fixture) => {
      let db = await fixture.create('source');
      const expected = new Map<string, Record<string, unknown>>();
      const text = 'exact field names and compression '.repeat(25);
      for (const collection of names) {
        const defaults = safeDictionary<CompressionAlgorithm>();
        defaults['__proto__'] = 'gzip';
        defaults['constructor'] = 'deflate';
        defaults['toString'] = 'brotli';
        db.setFieldCompressionDefaults(collection, defaults);
        const raw = Object.fromEntries<unknown>([
          ['id', ''],
          ['__proto__', text],
          ['constructor', text],
          ['toString', text],
          ['b:c', JSON.stringify(collection)],
          ['', 'empty field'],
          ['  ', 'space field'],
          ['binary', Buffer.from([0, 255, 128, 1])],
        ]);
        expected.set(collection, raw);
        await db.insertDocument(parseRawDocument(collection, raw), Object.fromEntries([['__proto__', 'off']]));
        expect(codecs((await db.getDocument('', collection, true)) as EncodedDocument)).toMatchObject({
          ['__proto__']: 'none',
          constructor: 'deflate',
          toString: 'brotli',
          binary: 'none',
        });
        expect(Object.getPrototypeOf(db.getFieldIndexConfig(collection))).toBeNull();
        expect(Object.getPrototypeOf(db.getFieldCompressionDefaults(collection))).toBeNull();
        await db.setFieldIndexed(collection, 'constructor', false);
        await db.editDocumentByID(collection, '', 'constructor', `${text} edited`);
        raw['constructor'] = `${text} edited`;
        await db.setFieldIndexed(collection, 'constructor', true);
        await db.setFieldIndexed(collection, '', false);
        await db.setFieldIndexed(collection, '', true);
        await db.setFieldIndexed(collection, '  ', false);
        await db.setFieldIndexed(collection, '  ', true);
        expect((await db.relocateDocument(collection, '')).relocated).toBe(true);
        const target = (await db.listBtreeRelocationTargets(1000)).find(
          (item) => item.collection === collection && item.field === '__proto__',
        );
        expect(target).toBeDefined();
        await db.relocateBtreeNode(collection, '__proto__', target!.blockNumber!);
      }
      const independent = await fixture.create('independent');
      expect(independent.listCollections()).toEqual([]);
      await independent.insertDocument(parseRawDocument('__proto__', { id: 'different', constructor: 'independent' }));
      expect(await rows(independent, '__proto__', 'constructor')).toEqual([
        { id: 'different', constructor: 'independent' },
      ]);
      const verify = async (checked: DbmsBack) => {
        expect(checked.listCollections().sort()).toEqual([...names].sort());
        for (const [collection, raw] of expected) {
          expect(((await checked.getDocument('', collection)) as Document).asDocument()).toEqual(raw);
          for (const field of ['__proto__', 'constructor', 'toString', 'b:c', '', '  ']) {
            expect(await rows(checked, collection, field)).toEqual([raw]);
          }
          expect(codecs((await checked.getDocument('', collection, true)) as EncodedDocument)).toMatchObject({
            ['__proto__']: 'none',
            constructor: 'deflate',
            toString: 'brotli',
          });
        }
        expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototypeBefore);
      };
      await db.commit();
      await fixture.close(db);
      db = await fixture.open('source');
      await verify(db);
      const targetData = new RealFile(fixture.data('vacuum'));
      const targetLog = new RealFile(fixture.data('vacuum').replace(/\.db$/, '.log'));
      const vacuum = await db.vacuumCompactInto(targetData, targetLog);
      try {
        await verify(vacuum);
      } finally {
        await vacuum.close();
      }
      await verify(await fixture.open('vacuum'));
      await db.deleteCollection('a');
      expect(await rows(db, 'a:b', 'b:c')).toEqual([expected.get('a:b')]);
      expect(await rows(db, 'a::b', 'constructor')).toEqual([expected.get('a::b')]);
      await db.commit();
      await fixture.close(db);
      db = await fixture.open('source');
      expect(db.listCollections()).not.toContain('a');
      expect(await rows(db, 'a:b', 'b:c')).toEqual([expected.get('a:b')]);
    });
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototypeBefore);
  });

  it('keeps delimiter-containing indexes independent through updates, toggles, deletion and reopening', async () => {
    await diskFixture(async (fixture) => {
      let db = await fixture.create('source');
      await db.insertDocument(parseRawDocument('a', { id: 'one', 'b:c': 'first' }));
      await db.insertDocument(parseRawDocument('a:b', { id: 'two', c: 'second' }));
      await db.editDocumentByID('a', 'one', 'b:c', 'changed');
      await db.setFieldIndexed('a', 'b:c', false);
      expect(await rows(db, 'a:b', 'c')).toEqual([{ id: 'two', c: 'second' }]);
      await db.setFieldIndexed('a', 'b:c', true);
      expect(await rows(db, 'a', 'b:c')).toEqual([{ id: 'one', 'b:c': 'changed' }]);
      await db.deleteCollection('a');
      await db.commit();
      await fixture.close(db);
      db = await fixture.open('source');
      expect(await rows(db, 'a:b', 'c')).toEqual([{ id: 'two', c: 'second' }]);
      await db.editDocumentByID('a:b', 'two', 'c', 'still independent');
      await db.deleteDocument('two', 'a:b');
      expect(await rows(db, 'a:b', 'c')).toEqual([]);
      await db.commit();
      await fixture.close(db);
      expect(await rows(await fixture.open('source'), 'a:b', 'c')).toEqual([]);
    });
  });

  it('isolates dual semantic index identities with mixed dimensions through repeated relocation, tombstones and vacuum', async () => {
    const dual: HnswConfig = {
      ...semantic,
      textIndex: semantic,
      imageIndex: {
        dimension: 4,
        M: 4,
        embeddingFn: () => Promise.resolve(new Float32Array([1, 0, 0, 0])),
        imageEmbeddingFn: () => Promise.resolve(new Float32Array([1, 0, 0, 0])),
      },
    };
    const names = ['a', 'a::text', 'a::image', 'a::b', '["a","text"]', '__proto__', ''];
    await diskFixture(async (fixture) => {
      let db = await fixture.create('source', dual);
      for (const collection of names) {
        for (const id of ['live', 'deleted'])
          await db.insertDocument(
            parseRawDocument(collection, { id, title: collection, 'photo.png': Buffer.from([0, 255, 128]) }),
          );
        await db.deleteDocument('deleted', collection);
        await db.ensureHnswCollection(`${collection}::empty`);
      }
      await db.commit();
      const ownerBefore = await db.inspectHnswGraphStructureSnapshot('a', 'text');
      const neighborBefore = await db.inspectHnswGraphStructureSnapshot('a::b', 'text');
      for (const target of await db.listHnswRelocationTargets('a::b')) {
        if (target.nodeId === undefined) continue;
        await expect(db.relocateHnswUnit({ ...target, collection: 'a', blockNumber: undefined })).rejects.toThrow(
          /belongs to this semantic index/,
        );
        expect(db.isHealthy).toBe(true);
      }
      expect(await db.inspectHnswGraphStructureSnapshot('a', 'text')).toEqual(ownerBefore);
      expect(await db.inspectHnswGraphStructureSnapshot('a::b', 'text')).toEqual(neighborBefore);
      const verify = async (checked: DbmsBack, vacuum = false) => {
        for (const collection of names.filter((name) => name !== 'a')) {
          expect((await checked.semanticSearch(collection, 'text', 10)).map((doc) => doc.getId())).toEqual(['live']);
          expect(
            (await checked.semanticImageSearch(collection, Buffer.from([1]), 10)).map((doc) => doc.getId()),
          ).toEqual(['live']);
          for (const kind of ['text', 'image'] as const) {
            const nodes = await checked.inspectHnswGraphStructure(collection, kind);
            expect(nodes.filter((node) => node.deleted)).toHaveLength(vacuum ? 0 : 1);
            expect(await checked.inspectHnswGraphStructure(`${collection}::empty`, kind)).toEqual([]);
          }
        }
      };
      await db.deleteCollection('a');
      const candidates = await db.listHnswRelocationCandidateTargets(1000);
      expect(new Set(candidates.map((candidate) => candidate.indexKind))).toEqual(new Set(['text', 'image']));
      expect(candidates.every((candidate) => candidate.collection !== 'a')).toBe(true);
      for (let pass = 0; pass < 2; pass++) {
        for (const collection of names.filter((name) => name !== 'a')) {
          expect((await db.relocateDocument(collection, 'live')).relocated).toBe(true);
          const targets = await db.listHnswRelocationTargets(collection);
          for (const kind of ['text', 'image'] as const) {
            for (const unit of ['hnsw-meta', 'hnsw-graph', 'hnsw-vector'] as const) {
              const target = targets.find((item) => item.indexKind === kind && item.kind === unit);
              expect(target).toBeDefined();
              // Resolve by page on each move because graph relocation updates node IDs.
              await db.relocateHnswUnit({ ...target!, nodeId: undefined });
            }
          }
        }
        await db.commit();
        await fixture.close(db);
        db = await fixture.open('source', dual);
        await verify(db);
      }
      const vacuum = await db.vacuumCompactInto(
        new RealFile(fixture.data('vacuum')),
        new RealFile(fixture.data('vacuum').replace(/\.db$/, '.log')),
      );
      try {
        await verify(vacuum, true);
      } finally {
        await vacuum.close();
      }
      await verify(await fixture.open('vacuum', dual), true);
    });
  });

  it('migrates only unambiguous legacy semantic namespace ownership', async () => {
    await diskFixture(async (fixture) => {
      let db = await fixture.create('source', semantic);
      await db.insertDocument(parseRawDocument('a::b', { id: 'live', title: 'legacy exact collection' }));
      await db.commit();
      const roots = db.getVacuumHnswMetaSnapshot();
      (db as unknown as { metaCache: Record<string, unknown> }).metaCache['__hnsw__'] = {
        'a::b': roots[semanticIndexKey('a::b', 'default')],
      };
      await db.commit();
      await fixture.close(db);
      db = await fixture.open('source', semantic);
      expect((await db.semanticSearch('a::b', 'legacy', 1)).map((doc) => doc.getId())).toEqual(['live']);
      expect(Object.keys(db.getVacuumHnswMetaSnapshot())).toEqual([semanticIndexKey('a::b', 'default')]);
      await db.commit();
      await fixture.close(db);
      expect(
        (await (await fixture.open('source', semantic)).semanticSearch('a::b', 'legacy', 1)).map((doc) => doc.getId()),
      ).toEqual(['live']);
    });
  });

  it.each([false, true])(
    'rejects empty legacy suffix ownership even when collection metadata exists: %s',
    async (exactMetadata) => {
      await diskFixture(async (fixture) => {
        const db = await fixture.create('source', semantic);
        await db.insertDocument(parseRawDocument('a', { id: 'first', title: 'first collection' }));
        if (exactMetadata) await db.ensurePrimaryIndex('a::text', 'string');
        await db.ensureHnswCollection('a::text');
        await db.commit();
        const roots = db.getVacuumHnswMetaSnapshot();
        (db as unknown as { metaCache: Record<string, unknown> }).metaCache['__hnsw__'] = {
          'a::text': roots[semanticIndexKey('a::text', 'default')],
        };
        await db.commit();
        await fixture.close(db);
        const before = await readFile(fixture.data('source'));
        await expect(fixture.open('source', semantic)).rejects.toThrow(/ambiguous collection ownership.*retained/);
        expect(await readFile(fixture.data('source'))).toEqual(before);
      });
    },
  );

  it.each(['default', 'text'] as const)(
    'uses record ownership to migrate nonempty legacy %s indexes without decoding vectors',
    async (kind) => {
      await diskFixture(async (fixture) => {
        const config = kind === 'text' ? { ...semantic, textIndex: semantic } : semantic;
        let db = await fixture.create('source', config);
        for (const collection of ['a', 'a::text'])
          await db.insertDocument(parseRawDocument(collection, { id: 'live', title: collection }));
        await db.commit();
        const roots = db.getVacuumHnswMetaSnapshot();
        (db as unknown as { metaCache: Record<string, unknown> }).metaCache['__hnsw__'] = {
          [kind === 'text' ? 'a::text' : 'a']: roots[semanticIndexKey('a', kind)],
          [kind === 'text' ? 'a::text::text' : 'a::text']: roots[semanticIndexKey('a::text', kind)],
        };
        await db.commit();
        await fixture.close(db);
        db = await fixture.open('source', config);
        expect(new Set(Object.keys(db.getVacuumHnswMetaSnapshot()))).toEqual(
          new Set([semanticIndexKey('a', kind), semanticIndexKey('a::text', kind)]),
        );
        await db.deleteCollection('a');
        expect((await db.semanticSearch('a::text', 'text', 1)).map((doc) => doc.getId())).toEqual(['live']);
        await db.commit();
        await fixture.close(db);
        expect(
          (await (await fixture.open('source', config)).semanticSearch('a::text', 'text', 1)).map((doc) => doc.getId()),
        ).toEqual(['live']);
      });
    },
  );

  it('refuses to infer legacy suffix ownership from retained tombstone record anchors', async () => {
    await diskFixture(async (fixture) => {
      const db = await fixture.create('source', semantic);
      await db.insertDocument(parseRawDocument('a', { id: 'parent', title: 'parent' }));
      await db.insertDocument(parseRawDocument('a::text', { id: 'deleted', title: 'retained tombstone' }));
      await db.deleteDocument('deleted', 'a::text');
      await db.commit();
      const graph = await db.inspectHnswGraphStructure('a::text');
      expect(graph).toHaveLength(1);
      expect(graph[0].deleted).toBe(true);
      const roots = db.getVacuumHnswMetaSnapshot();
      (db as unknown as { metaCache: Record<string, unknown> }).metaCache['__hnsw__'] = {
        'a::text': roots[semanticIndexKey('a::text', 'default')],
      };
      await db.commit();
      await fixture.close(db);
      const before = await readFile(fixture.data('source'));
      await expect(fixture.open('source', semantic)).rejects.toThrow(/ambiguous collection ownership/);
      expect(await readFile(fixture.data('source'))).toEqual(before);
    });
  });

  it('migrates legacy prototype-named fields with no existing secondary roots', async () => {
    await diskFixture(async (fixture) => {
      let db = await fixture.create('source');
      const raw = Object.fromEntries<unknown>([
        ['id', 'live'],
        ['__proto__', 'retained'],
        ['constructor', 'constructor value'],
        ['toString', 'text'],
      ]);
      for (const field of ['__proto__', 'constructor', 'toString']) await db.setFieldIndexed('__proto__', field, false);
      await db.insertDocument(parseRawDocument('__proto__', raw));
      await db.commit();
      delete (db as unknown as { metaCache: Record<string, unknown> }).metaCache['__indexing__'];
      await db.commit();
      await fixture.close(db);
      db = await fixture.open('source');
      expect(((await db.getDocument('live', '__proto__')) as Document).asDocument()).toEqual(raw);
      for (const field of ['__proto__', 'constructor', 'toString']) {
        expect(db.getFieldIndexConfig('__proto__')[field]).toBe(false);
        await db.setFieldIndexed('__proto__', field, true);
        expect(await rows(db, '__proto__', field)).toEqual([raw]);
      }
      await db.commit();
      await fixture.close(db);
      expect(await rows(await fixture.open('source'), '__proto__', '__proto__')).toEqual([raw]);
    });
  });

  it.each(['__hnsw__', '__compression__', '__indexing__'])(
    'rejects reserved semantic collection %s before allocation',
    async (collection) => {
      const db = new DbmsBack(new MockFile(4096), new MockFile(4096), semantic);
      await db.create();
      try {
        const before = await db.getCompactionStorageStats();
        await expect(db.ensureHnswCollection(collection)).rejects.toThrow(/reserved/);
        expect(db.isHealthy).toBe(true);
        expect((await db.getCompactionStorageStats()).usedBlocks).toBe(before.usedBlocks);
        expect(Object.keys(db.getVacuumHnswMetaSnapshot())).toEqual([]);
      } finally {
        await db.close();
      }
    },
  );

  it('disables incompatible or unknown legacy dimensions while retaining documents and persisted graphs', async () => {
    await diskFixture(async (fixture) => {
      let db = await fixture.create('source', semantic);
      await db.insertDocument(parseRawDocument('__proto__', { id: '', title: 'retained document' }));
      await db.ensureHnswCollection('empty');
      await db.commit();
      await fixture.close(db);
      const before = await readFile(fixture.data('source'));
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        db = await fixture.open('source', { ...semantic, dimension: 4 });
        expect(db.getVacuumHnswConfig()).toBeUndefined();
        expect(((await db.getDocument('', '__proto__')) as Document).asDocument()).toEqual({
          id: '',
          title: 'retained document',
        });
        await expect(db.semanticSearch('__proto__', 'text', 1)).rejects.toThrow(/not configured/);
        expect(warning).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/dimension/i));
        await fixture.close(db);
        expect(await readFile(fixture.data('source'))).toEqual(before);
        db = await fixture.open('source', semantic);
        expect((await db.semanticSearch('__proto__', 'text', 1)).map((doc) => doc.getId())).toEqual(['']);
        const roots = db.getVacuumHnswMetaSnapshot();
        const blocks = (db as unknown as { freeblockFile: FreeBlockFile }).freeblockFile;
        for (const [blockNumber] of Object.values(roots)) {
          const metadata = await blocks.readBlock(blockNumber);
          metadata.fill(0, 23, 31); // Remove only the appended HVD1 marker/dimension.
          await blocks.writeBlock(blockNumber, metadata.subarray(1));
        }
        await db.commit();
        await fixture.close(db);
        const legacyBytes = await readFile(fixture.data('source'));
        db = await fixture.open('source', semantic);
        expect(db.getVacuumHnswConfig()).toBeUndefined();
        expect(((await db.getDocument('', '__proto__')) as Document).getId()).toBe('');
        expect(warning).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/legacy.*dimension/i));
        await fixture.close(db);
        expect(await readFile(fixture.data('source'))).toEqual(legacyBytes);
      } finally {
        warning.mockRestore();
      }
    });
  });

  it.each([0, 10000])('rejects dimension %s before embeddings or document/index allocation', async (dimension) => {
    await diskFixture(async (fixture) => {
      const embeddingFn = vi.fn(() => Promise.resolve(new Float32Array(dimension)));
      let db = await fixture.create('source', { ...semantic, dimension, embeddingFn });
      const before = await db.getCompactionStorageStats();
      await expect(
        db.insertDocument(parseRawDocument('docs', { id: 'rejected', title: 'invalid dimension' })),
      ).rejects.toThrow(/dimension/i);
      expect(embeddingFn).not.toHaveBeenCalled();
      expect(db.isHealthy).toBe(true);
      expect(db.listCollections()).toEqual([]);
      expect((await db.getCompactionStorageStats()).usedBlocks).toBe(before.usedBlocks);
      await db.commit();
      await fixture.close(db);
      db = await fixture.open('source', semantic);
      await db.insertDocument(parseRawDocument('docs', { id: 'valid', title: 'healthy recovery' }));
      expect((await db.semanticSearch('docs', 'text', 1)).map((doc) => doc.getId())).toEqual(['valid']);
      await db.commit();
    });
  });
});
