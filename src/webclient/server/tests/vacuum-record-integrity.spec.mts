import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { SimpleDbms } from '../../../database/simpledbms.mjs';
import type { DbmsBack } from '../../../database/dbmsback.mjs';
import { RealFile } from '../../../storage/file.mjs';
import { DatabaseService } from '../service.mjs';

vi.mock('../embedding-config.mjs', () => ({ getClipHnswConfig: () => undefined }));

describe('vacuum source integrity on real files', () => {
  it.each(['io', 'decode'] as const)('preserves A, B and C when reading B fails at %s', async (failure) => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'siftwell-vacuum-record-'));
    const withinTemp = path.relative(path.resolve(tmpdir()), path.resolve(directory));
    if (!withinTemp || withinTemp.startsWith('..') || path.isAbsolute(withinTemp))
      throw new Error('Unsafe temporary directory');
    const filepath = path.join(directory, 'data.db');
    const service = new DatabaseService();
    let repair: (() => Promise<void>) | undefined;
    try {
      const database = await SimpleDbms.create(new RealFile(filepath), new RealFile(`${filepath}.log`));
      let pointer: number;
      try {
        for (const [index, id] of ['A', 'B', 'C'].entries()) {
          await database.insertDocumentObject('docs', { id, score: index + 1, title: `document ${id}` });
        }
        await database.commit();
        const back = (database as unknown as { dbmsback: DbmsBack }).dbmsback;
        pointer = (await back.getDocumentBlockId('docs', 'B'))!;
      } finally {
        await database.close();
      }

      if (failure === 'io') {
        const originalRead = Reflect.get(RealFile.prototype, 'read');
        const readSpy = vi.spyOn(RealFile.prototype, 'read').mockImplementation(function (
          this: RealFile,
          buffer,
          options,
        ) {
          if (this.filePath === filepath && options.position === pointer * 4096) {
            return Promise.reject(new Error('injected B file read failure'));
          }
          return originalRead.call(this, buffer, options);
        });
        repair = () => {
          readSpy.mockRestore();
          return Promise.resolve();
        };
      } else {
        const handle = await fs.open(filepath, 'r+');
        const saved = Buffer.alloc(4096);
        try {
          await handle.read(saved, 0, saved.length, pointer * 4096);
          await handle.write(Buffer.from('!'), 0, 1, pointer * 4096 + 9);
          await handle.sync();
        } finally {
          await handle.close();
        }
        repair = async () => {
          const target = await fs.open(filepath, 'r+');
          try {
            await target.write(saved, 0, saved.length, pointer * 4096);
            await target.sync();
          } finally {
            await target.close();
          }
        };
      }
      await service.connect(filepath);
      await expect(service.query('SELECT * FROM docs')).rejects.toThrow(/Cannot read record/);
      await expect(service.getDocuments('docs')).rejects.toThrow(/Cannot read record/);
      await expect(service.vacuum()).rejects.toThrow(/Cannot read record/);
      expect(service.isConnected).toBe(true);
      expect((await fs.readdir(directory)).sort()).toEqual(['data.db', 'data.db.log']);
      expect(await fs.stat(filepath)).toBeDefined();
      await service.disconnect();
      await repair();
      repair = undefined;

      const reopened = await SimpleDbms.open(new RealFile(filepath), new RealFile(`${filepath}.log`));
      try {
        const documents = [];
        for await (const raw of reopened.cursor('docs', 'id')) documents.push(JSON.parse(raw));
        expect(documents).toEqual(
          ['A', 'B', 'C'].map((id, index) => ({ id, score: index + 1, title: `document ${id}` })),
        );
        const indexed = [];
        for await (const raw of reopened.cursorEqual('docs', 'score', 2))
          indexed.push((JSON.parse(raw) as { id: string }).id);
        expect(indexed).toEqual(['B']);
      } finally {
        await reopened.close();
      }
    } finally {
      await service.disconnect();
      if (repair) await repair();
      vi.restoreAllMocks();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
