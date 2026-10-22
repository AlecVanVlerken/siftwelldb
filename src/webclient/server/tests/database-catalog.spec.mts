import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimpleDbms, type HnswConfig } from '../../../database/simpledbms.mjs';
import { RealFile } from '../../../storage/file.mjs';
import { DatabaseCatalog, DEFAULT_DATABASE_DIRECTORY } from '../database-catalog.mjs';
import { DatabaseInputError, DatabaseService } from '../service.mjs';
import { installVacuumReplacement, prepareVacuumReplacement, vacuumPaths } from '../vacuum-recovery.mjs';

const hnswConfig: HnswConfig = {
  dimension: 2,
  M: 4,
  efConstruction: 16,
  efSearch: 16,
  embeddingFn: () => Promise.resolve(new Float32Array([1, 0])),
};

describe('managed persistent webclient databases', () => {
  let directory: string;
  let databaseDirectory: string;
  let service: DatabaseService;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(tmpdir(), 'siftwell-database-catalog-'));
    databaseDirectory = path.join(directory, 'databases');
    service = new DatabaseService({ databaseDirectory, hnswConfig });
  });

  afterEach(async () => {
    await service.shutdown();
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Unsafe temporary directory');
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('resolves the default folder from the project location rather than the process working directory', () => {
    expect(DEFAULT_DATABASE_DIRECTORY).toBe(path.resolve(import.meta.dirname, '../../../../databases'));
  });

  it('creates the folder automatically and keeps data, WAL and model sidecar together across reopen', async () => {
    expect(await service.listDatabases()).toEqual([]);
    await service.createStoredDatabase('Research notes');
    const filepath = path.join(databaseDirectory, 'Research notes.db');
    expect(service.filepath).toBe(filepath);
    await service.insertDocument('notes', { id: 1, title: 'A persistent note' });
    await service.disconnect();
    await fs.writeFile(`${filepath}.model.json`, JSON.stringify({ description: 'a schema model' }));
    expect((await fs.readdir(databaseDirectory)).sort()).toEqual([
      'Research notes.db',
      'Research notes.db.log',
      'Research notes.db.model.json',
    ]);
    expect(await service.listDatabases()).toEqual([{ name: 'Research notes', filename: 'Research notes.db' }]);
    await service.openStoredDatabase('Research notes.db');
    expect(JSON.parse(await service.getDocumentById('notes', 1))).toMatchObject({ title: 'A persistent note' });
    expect(JSON.parse(await fs.readFile(`${filepath}.model.json`, 'utf8'))).toEqual({ description: 'a schema model' });
  });

  it('accepts Unicode names and resolves existing names without capitalization differences', async () => {
    await service.createStoredDatabase('Études_2026-研究.DB');
    expect(service.filepath).toBe(path.join(databaseDirectory, 'Études_2026-研究.db'));
    await service.disconnect();
    await service.openStoredDatabase('études_2026-研究.db');
    expect(service.isConnected).toBe(true);
  });

  it.each([
    '',
    '.',
    '..',
    '../outside',
    '..\\outside',
    '/tmp/outside.db',
    'C:\\outside.db',
    'a/b',
    'a\\b',
    'a:b',
    'a?b',
    'a\nb',
    'a\0b',
    'trailing.',
    'trailing ',
    ' leading',
    'double.db.db',
    'CON',
    'nul.db',
    'COM1',
    'LPT9',
    'COM¹',
  ])('rejects an invalid name (%j) without closing the active database', async (name) => {
    await service.createStoredDatabase('keep');
    const active = service.rawDbms;
    await expect(service.createStoredDatabase(name)).rejects.toBeInstanceOf(DatabaseInputError);
    await expect(service.openStoredDatabase(name)).rejects.toBeInstanceOf(DatabaseInputError);
    expect(service.rawDbms).toBe(active);
    expect(await fs.readdir(databaseDirectory)).toEqual(['keep.db', 'keep.db.log']);
  });

  it('does not implicitly create a missing database or replace the active connection', async () => {
    await service.createStoredDatabase('keep');
    const active = service.rawDbms;
    await expect(service.openStoredDatabase('missing')).rejects.toThrow('does not exist');
    expect(service.rawDbms).toBe(active);
    expect(await fs.readdir(databaseDirectory)).toEqual(['keep.db', 'keep.db.log']);
  });

  it('rejects duplicate names case-insensitively and preserves existing data', async () => {
    await service.createStoredDatabase('Notes');
    await service.insertDocument('notes', { id: 1, title: 'keep this' });
    const active = service.rawDbms;
    const bytes = await fs.readFile(service.filepath!);
    await expect(service.createStoredDatabase('notes.DB')).rejects.toThrow('already exists');
    expect(service.rawDbms).toBe(active);
    expect(await fs.readFile(service.filepath!)).toEqual(bytes);
  });

  it('serializes competing creates and retains the first database', async () => {
    const outcomes = await Promise.allSettled([
      service.createStoredDatabase('shared'),
      service.createStoredDatabase('SHARED.db'),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await service.listDatabases()).toHaveLength(1);
    expect(service.isConnected).toBe(true);
    await service.insertDocument('notes', { id: 'still usable' });
  });

  it('works inside the API operation context without deadlocking', async () => {
    await service.runExclusiveOperation('api-create', () => service.createStoredDatabase('nested'));
    await service.runExclusiveOperation('api-open', () => service.openStoredDatabase('nested'));
    expect(service.isConnected).toBe(true);
  });

  it.each(['.log', '.model.json', '.vacuum-state.json', '.vacuum-test.tmp', '.log.vacuum-test.bak'])(
    'preserves orphan companion evidence (%s) when creating a database',
    async (suffix) => {
      await service.createStoredDatabase('keep');
      const active = service.rawDbms;
      const evidence = path.join(databaseDirectory, `orphan.db${suffix}`);
      await fs.writeFile(evidence, 'must not overwrite');
      await expect(service.createStoredDatabase('ORPHAN')).rejects.toThrow('already exists');
      expect(await fs.readFile(evidence, 'utf8')).toBe('must not overwrite');
      expect(service.rawDbms).toBe(active);
      await expect(fs.access(path.join(databaseDirectory, 'orphan.db'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('lists databases in name order without WALs, sidecars, scratch files or directories', async () => {
    await service.createStoredDatabase('Zebra');
    await service.createStoredDatabase('alpha');
    await service.disconnect();
    await fs.mkdir(path.join(databaseDirectory, 'directory.db'));
    await fs.writeFile(path.join(databaseDirectory, 'alpha.db.vacuum-temp.tmp'), 'scratch');
    await fs.writeFile(path.join(databaseDirectory, 'alpha.db.model.json'), '{}');
    await fs.writeFile(path.join(databaseDirectory, 'orphan.db.log'), 'evidence');
    await fs.writeFile(path.join(databaseDirectory, 'bad.name.db'), 'not a catalog name');
    expect(await service.listDatabases()).toEqual([
      { name: 'alpha', filename: 'alpha.db' },
      { name: 'Zebra', filename: 'Zebra.db' },
    ]);
  });

  it.each(['', '.log', '.model.json'])(
    'rejects hard-linked database or companion files (%s) before closing the active database',
    async (suffix) => {
      await service.createStoredDatabase('keep');
      const active = service.rawDbms;
      const external = path.join(directory, 'outside');
      await fs.writeFile(external, 'unchanged');
      const target = path.join(databaseDirectory, `linked.db${suffix}`);
      if (suffix) await fs.writeFile(path.join(databaseDirectory, 'linked.db'), 'placeholder');
      await fs.link(external, target);
      await expect(service.openStoredDatabase('linked')).rejects.toThrow('without links');
      await expect(service.createStoredDatabase('linked')).rejects.toThrow('already exists');
      expect(service.rawDbms).toBe(active);
      expect(await fs.readFile(external, 'utf8')).toBe('unchanged');
      expect(await service.listDatabases()).not.toContainEqual({ name: 'linked', filename: 'linked.db' });
    },
  );

  it('rejects a database folder redirected by a symbolic link or junction', async () => {
    const external = path.join(directory, 'outside');
    await fs.mkdir(external);
    await fs.symlink(external, databaseDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(service.listDatabases()).rejects.toThrow('without symbolic links or junctions');
    await expect(service.createStoredDatabase('blocked')).rejects.toThrow('without symbolic links or junctions');
    expect(await fs.readdir(external)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked data file, WAL or model sidecar', async () => {
    await service.createStoredDatabase('keep');
    const active = service.rawDbms;
    const external = path.join(directory, 'outside');
    await fs.writeFile(external, 'unchanged');
    for (const [index, suffix] of ['', '.log', '.model.json'].entries()) {
      const filename = `linked${index}.db`;
      if (suffix) await fs.writeFile(path.join(databaseDirectory, filename), 'placeholder');
      await fs.symlink(external, path.join(databaseDirectory, `${filename}${suffix}`));
      await expect(service.openStoredDatabase(`linked${index}`)).rejects.toThrow('without links');
      expect(service.rawDbms).toBe(active);
    }
  });

  it('exposes and recovers a database interrupted after the first vacuum backup rename', async () => {
    await service.createStoredDatabase('recover');
    await service.insertDocument('notes', { id: 'original', title: 'retain committed data' });
    const filepath = service.filepath!;
    await service.disconnect();
    const paths = vacuumPaths(filepath);
    const replacement = await SimpleDbms.create(new RealFile(paths.tempData), new RealFile(paths.tempLog), hnswConfig);
    await replacement.insertDocumentObject('notes', { id: 'replacement', title: 'unverified replacement' });
    await replacement.commit();
    await replacement.close();
    await prepareVacuumReplacement(paths);
    await expect(
      installVacuumReplacement(paths, (phase) => {
        if (phase === 'firstbackup') throw new Error('simulated interruption');
        return Promise.resolve();
      }),
    ).rejects.toThrow('simulated interruption');
    await expect(fs.access(filepath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await service.listDatabases()).toEqual([{ name: 'recover', filename: 'recover.db' }]);
    await service.openStoredDatabase('recover');
    expect(JSON.parse(await service.getDocumentById('notes', 'original'))).toMatchObject({
      title: 'retain committed data',
    });
    expect((await fs.readdir(databaseDirectory)).sort()).toEqual(['recover.db', 'recover.db.log']);
  });

  it('keeps raw internal path APIs independent of the managed catalog', async () => {
    const filepath = path.join(directory, 'raw.db');
    await service.create(filepath);
    await service.insertDocument('notes', { id: 'raw' });
    await service.disconnect();
    await service.connect(filepath);
    expect(await service.listDatabases()).toEqual([]);
    expect(JSON.parse(await service.getDocumentById('notes', 'raw'))).toEqual({ id: 'raw' });
  });

  it('allows the catalog to validate a seed destination without creating database files', async () => {
    const catalog = new DatabaseCatalog(databaseDirectory);
    expect(await catalog.unused('seed')).toBe(path.join(databaseDirectory, 'seed.db'));
    expect(await fs.readdir(databaseDirectory)).toEqual([]);
  });
});
