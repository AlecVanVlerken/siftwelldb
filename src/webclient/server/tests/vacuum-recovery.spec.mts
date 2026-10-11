import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimpleDbms } from '../../../database/simpledbms.mjs';
import { RealFile } from '../../../storage/file.mjs';
import { DatabaseService } from '../service.mjs';
import { recoverVacuumReplacement, vacuumPaths, type VacuumManifest } from '../vacuum-recovery.mjs';

vi.mock('../embedding-config.mjs', () => ({ getClipHnswConfig: () => undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});

const fixture = path.join(import.meta.dirname, 'fixtures', 'vacuum-crash.mts');

async function crashAt(filepath: string, phase: string, mode = 'replace'): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, mode, filepath, phase], { windowsHide: true });
  let output = '';
  let errors = '';
  let reached = false;
  child.stderr.on('data', (chunk) => {
    errors += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out before ${phase}: ${errors}`));
    }, 25000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes(`checkpoint:${phase}\n`) && !reached) {
        reached = true;
        child.kill('SIGKILL');
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (reached) resolve();
      else reject(new Error(`Child exited before ${phase}: ${errors}`));
    });
  });
}

describe('recoverable vacuum replacement on real files', () => {
  let directory: string;
  let filepath: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(tmpdir(), 'siftwell-vacuum-crash-'));
    filepath = path.join(directory, 'database.db');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    const withinTemp = path.relative(path.resolve(tmpdir()), path.resolve(directory));
    if (!withinTemp || withinTemp.startsWith('..') || path.isAbsolute(withinTemp))
      throw new Error('Unsafe temporary directory');
    await fs.rm(directory, { recursive: true, force: true });
  });

  const open = () => SimpleDbms.open(new RealFile(filepath), new RealFile(`${filepath}.log`));
  const verify = async () => {
    const database = await open();
    await database.close();
  };
  async function assertUseful(expected: 'original' | 'replacement'): Promise<void> {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'expected.json'), 'utf8')) as VacuumManifest;
    const bytes = await fs.readFile(filepath);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest[expected].data.sha256);
    expect(
      createHash('sha256')
        .update(await fs.readFile(`${filepath}.log`))
        .digest('hex'),
    ).toBe(manifest[expected].log.sha256);
    const database = await open();
    try {
      const documents: Array<{ id: string; _payload: string }> = [];
      for await (const raw of database.cursor('books', 'id'))
        documents.push(JSON.parse(raw) as { id: string; _payload: string });
      expect(documents.map((document) => document.id)).toEqual(['b08', 'b09', 'b10', 'b11']);
      expect(documents.every((document) => document._payload === 'x'.repeat(8000))).toBe(true);
      const indexed = [];
      for await (const raw of database.cursor('books', 'title', 'second'))
        indexed.push((JSON.parse(raw) as { id: string }).id);
      expect(indexed).toEqual(['b09', 'b11']);
      expect(database.getFieldIndexConfig('books')['_payload']).toBe(false);
      await database.insertDocumentObject('books', { id: 'b12', title: 'third', _payload: 'still writable' });
      await database.commit();
    } finally {
      await database.close();
    }
    const reopened = await open();
    try {
      const inserted = [];
      for await (const raw of reopened.cursor('books', 'title', 'third')) inserted.push(JSON.parse(raw));
      expect(inserted).toEqual([{ id: 'b12', title: 'third', _payload: 'still writable' }]);
    } finally {
      await reopened.close();
    }
    expect((await fs.readdir(directory)).filter((name) => name.includes('.vacuum-'))).toEqual([]);
  }

  it.each(['prepare', 'firstbackup', 'bothbackup', 'datainstall', 'loginstall', 'beforecleanup', 'cleanup'])(
    'recovers contents and indexes after actual process termination at %s',
    async (phase) => {
      await crashAt(filepath, phase);
      expect(await recoverVacuumReplacement(filepath, verify)).toBe(true);
      expect(await recoverVacuumReplacement(filepath, verify)).toBe(false);
      await assertUseful(['beforecleanup', 'cleanup'].includes(phase) ? 'replacement' : 'original');
    },
    35000,
  );

  it('retries after a process is also terminated during rollback recovery', async () => {
    await crashAt(filepath, 'loginstall');
    await crashAt(filepath, 'recovery', 'recover');
    expect(await recoverVacuumReplacement(filepath, verify)).toBe(true);
    expect(await recoverVacuumReplacement(filepath, verify)).toBe(false);
    await assertUseful('original');
  }, 65000);

  it('retains both generations and the manifest when verification fails, then retries', async () => {
    await crashAt(filepath, 'loginstall');
    await expect(
      recoverVacuumReplacement(filepath, () => Promise.reject(new Error('temporary open failure'))),
    ).rejects.toThrow('temporary open failure');
    expect((await fs.readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(true);
    expect(await fs.readFile(vacuumPaths(filepath).manifest, 'utf8')).toContain('prepared');
    await recoverVacuumReplacement(filepath, verify);
    await assertUseful('original');
  }, 35000);

  it('refuses a changed canonical generation without deleting any recovery evidence', async () => {
    await crashAt(filepath, 'datainstall');
    await fs.writeFile(filepath, 'unrecognized generation');
    const before = (await fs.readdir(directory)).sort();
    await expect(recoverVacuumReplacement(filepath, verify)).rejects.toThrow('unrecognized data generation');
    expect((await fs.readdir(directory)).sort()).toEqual(before);
    expect(await fs.readFile(filepath, 'utf8')).toBe('unrecognized generation');
  }, 35000);

  it.each(['.vacuum-old.bak', '.vacuum-old.tmp', '.vacuum-state.json'])(
    'connect and force-create preserve orphan recovery evidence %s',
    async (suffix) => {
      await fs.writeFile(`${filepath}${suffix}`, suffix === '.vacuum-state.json' ? '{broken' : 'existing data');
      const service = new DatabaseService();
      await expect(service.connect(filepath)).rejects.toThrow(/vacuum/i);
      await expect(service.create(filepath)).rejects.toThrow(/vacuum/i);
      expect(await fs.readFile(`${filepath}${suffix}`, 'utf8')).toBe(
        suffix === '.vacuum-state.json' ? '{broken' : 'existing data',
      );
      await expect(fs.stat(filepath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('connect never overwrites an orphan WAL with a new empty database', async () => {
    await fs.writeFile(`${filepath}.log`, 'pending WAL');
    const service = new DatabaseService();
    await expect(service.connect(filepath)).rejects.toThrow('WAL exists');
    expect(await fs.readFile(`${filepath}.log`, 'utf8')).toBe('pending WAL');
    await expect(fs.stat(filepath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform !== 'win32')(
    'detects orphan artifacts when the requested filename casing differs',
    async () => {
      const orphan = `${filepath.toUpperCase()}.vacuum-old.bak`;
      await fs.writeFile(orphan, 'existing database generation');
      const service = new DatabaseService();
      await expect(service.connect(filepath)).rejects.toThrow(/vacuum/);
      expect(await fs.readFile(orphan, 'utf8')).toBe('existing database generation');
      await expect(fs.stat(filepath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('refuses recovery when one original file is missing, before moving the other file', async () => {
    await crashAt(filepath, 'bothbackup');
    const manifest = JSON.parse(await fs.readFile(vacuumPaths(filepath).manifest, 'utf8')) as VacuumManifest;
    const paths = vacuumPaths(filepath, manifest.id);
    await fs.unlink(paths.backupLog);
    const before = (await fs.readdir(directory)).sort();
    await expect(recoverVacuumReplacement(filepath, verify)).rejects.toThrow('complete original pair');
    expect((await fs.readdir(directory)).sort()).toEqual(before);
    await expect(fs.stat(filepath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.stat(paths.backupData)).toBeDefined();
  }, 35000);

  it('retains recovery evidence if verification changes the selected generation', async () => {
    await crashAt(filepath, 'prepare');
    await expect(
      recoverVacuumReplacement(filepath, async () => {
        await fs.appendFile(filepath, 'changed during verification');
      }),
    ).rejects.toThrow(/generation/);
    expect(await fs.stat(vacuumPaths(filepath).manifest)).toBeDefined();
    expect((await fs.readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(true);
  }, 35000);

  it('normal service vacuum preserves documents, indexes and continued writes', async () => {
    const service = new DatabaseService();
    try {
      await service.connect(filepath);
      await service.setFieldIndexed('books', '_payload', false);
      for (let i = 0; i < 12; i++)
        await service.insertDocument('books', { id: i, score: i % 2, _payload: 'x'.repeat(8000) });
      for (let i = 0; i < 8; i++) await service.deleteDocument('books', String(i));
      const result = await service.vacuum();
      expect(result.bytesSaved).toBeGreaterThan(0);
      expect((await service.getDocuments('books')).total).toBe(4);
      await service.insertDocument('books', { id: 12, score: 2 });
      await service.disconnect();
      await service.connect(filepath);
      expect((await service.getDocuments('books')).total).toBe(5);
      expect((await fs.readdir(directory)).filter((name) => name.includes('.vacuum-'))).toEqual([]);
    } finally {
      await service.disconnect();
    }
  });

  it('service restores the original pair after an installation rename fails', async () => {
    const service = new DatabaseService();
    try {
      await service.connect(filepath);
      await service.insertDocument('books', { id: 'A', score: 1 });
      const { rename } = await vi.importActual<typeof fs>('node:fs/promises');
      const renameSpy = vi.mocked(fs.rename).mockImplementation(async (source, target) => {
        if (String(source).endsWith('.tmp') && String(target) === `${filepath}.log`)
          throw new Error('injected installation rename failure');
        await rename(source, target);
      });
      await expect(service.vacuum()).rejects.toThrow('injected installation rename failure');
      renameSpy.mockReset();
      expect(service.isConnected).toBe(true);
      expect((await service.getDocuments('books')).total).toBe(1);
      await service.insertDocument('books', { id: 'B', score: 2 });
      await service.disconnect();
      await service.connect(filepath);
      expect((await service.getDocuments('books')).total).toBe(2);
      expect((await fs.readdir(directory)).filter((name) => name.includes('.vacuum-'))).toEqual([]);
    } finally {
      await service.disconnect();
    }
  });

  it('retries cleanup after a backup deletion fails following verification', async () => {
    await crashAt(filepath, 'beforecleanup');
    const { unlink } = await vi.importActual<typeof fs>('node:fs/promises');
    const unlinkSpy = vi.mocked(fs.unlink).mockImplementation(async (file) => {
      if (String(file).endsWith('.bak')) throw new Error('injected backup deletion failure');
      await unlink(file);
    });
    await expect(recoverVacuumReplacement(filepath, verify)).rejects.toThrow('injected backup deletion failure');
    expect(await fs.readFile(vacuumPaths(filepath).manifest, 'utf8')).toContain('verified');
    unlinkSpy.mockReset();
    await recoverVacuumReplacement(filepath, verify);
    await assertUseful('replacement');
  }, 35000);

  it('service connect performs recovery before opening and permits normal writes', async () => {
    await crashAt(filepath, 'bothbackup');
    const service = new DatabaseService();
    try {
      await expect(service.connect(filepath)).resolves.toBe('Connected to existing database');
      expect((await service.getDocuments('books')).total).toBe(4);
      await service.insertDocument('books', { id: 'b12', title: 'third', _payload: 'new data' });
    } finally {
      await service.disconnect();
    }
    expect((await fs.readdir(directory)).filter((name) => name.includes('.vacuum-'))).toEqual([]);
  }, 35000);
});
