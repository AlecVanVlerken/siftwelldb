import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPRESSION_ALGORITHMS } from '../../database/compression.mjs';
import { DbmsBack } from '../../database/dbmsback.mjs';
import { parseRawDocument, type Document } from '../../database/document.mjs';
import { RealFile } from '../../storage/file.mjs';
import type { EncodedDocument } from '../../storage/records/recordstore.mjs';

describe('full vacuum compression preservation', () => {
  it('preserves stored codecs and contents across changed defaults, vacuum and disk reopening', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'siftwell-vacuum-codecs-'));
    const source = new DbmsBack(
      new RealFile(path.join(directory, 'source.db')),
      new RealFile(path.join(directory, 'source.log')),
    );
    const targetData = new RealFile(path.join(directory, 'vacuum.db'));
    const targetLog = new RealFile(path.join(directory, 'vacuum.log'));
    let target: DbmsBack | undefined;
    await source.create();
    try {
      await source.setFieldIndexed('docs', 'text', false);
      await source.setFieldIndexed('docs', 'disabled', false);
      await source.setFieldIndexed('docs', 'inherited', false);
      source.setFieldCompressionDefaults('docs', {
        text: 'gzip',
        binary: 'gzip',
        disabled: 'gzip',
        inherited: 'deflate',
        short: 'gzip',
      });
      const text = 'preserve the stored compression choice '.repeat(200);
      const binary = Buffer.from([0, 255, 128, 1, 42].flatMap((byte) => Array<number>(1000).fill(byte)));
      const originals = COMPRESSION_ALGORITHMS.map((algorithm, id) => ({
        algorithm,
        document: parseRawDocument('docs', {
          id,
          text,
          binary,
          disabled: text,
          inherited: text,
          short: 'x',
          active: true,
        }),
      }));
      for (const { algorithm, document } of originals) {
        await source.insertDocument(document, { text: algorithm, binary: algorithm, disabled: 'off' });
      }
      // Defaults are policy for future writes; they must not replace existing stored choices.
      source.setFieldCompressionDefaults('docs', {
        text: 'brotli',
        binary: 'zstd',
        disabled: 'gzip',
        inherited: 'gzip',
        short: 'gzip',
      });
      await source.commit();
      const stored = new Map<number, EncodedDocument>();
      for (const { algorithm, document } of originals) {
        const encoded = (await source.getDocument(document.getId(), 'docs', true)) as EncodedDocument;
        const codecs = Object.fromEntries(
          [...encoded.iterableEntries, ...encoded.nonIterableEntries].map((entry) => [entry.key, entry.compression]),
        );
        expect(codecs).toEqual({
          text: algorithm,
          binary: algorithm,
          disabled: 'none',
          inherited: 'deflate',
          short: 'none',
          active: 'none',
        });
        stored.set(document.getId() as number, encoded);
      }
      target = await source.vacuumCompactInto(targetData, targetLog);
      const check = async (db: DbmsBack) => {
        expect(db.getFieldCompressionDefaults('docs')).toEqual(source.getFieldCompressionDefaults('docs'));
        expect(db.getFieldIndexConfig('docs')).toEqual(source.getFieldIndexConfig('docs'));
        for (const { document } of originals) {
          expect(((await db.getDocument(document.getId(), 'docs')) as Document).asDocument()).toEqual(
            document.asDocument(),
          );
          expect(await db.getDocument(document.getId(), 'docs', true)).toEqual(stored.get(document.getId() as number));
        }
      };
      await check(target);
      await target.close();
      target = undefined;
      target = await DbmsBack.open(targetData, targetLog);
      await check(target);
      // The preserved defaults still apply to new documents after vacuum.
      await target.insertDocument(parseRawDocument('docs', { id: 100, text, binary, disabled: text, inherited: text }));
      const inserted = (await target.getDocument(100, 'docs', true)) as EncodedDocument;
      expect(
        Object.fromEntries(
          [...inserted.iterableEntries, ...inserted.nonIterableEntries].map((entry) => [entry.key, entry.compression]),
        ),
      ).toEqual({ text: 'brotli', binary: 'zstd', disabled: 'gzip', inherited: 'gzip' });
    } finally {
      await target?.close();
      await source.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
