import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { SimpleDbms } from '../../database/simpledbms.mjs';
import { DbmsBack, type HnswConfig } from '../../database/dbmsback.mjs';
import { RealFile } from '../../storage/file.mjs';
import { AtomicFile } from '../../storage/wal/atomicfile.mjs';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { VacuumService } from '../vacuum/vacuumservice.mjs';

const directories: string[] = [];
const databases: SimpleDbms[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    if (!path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep))
      throw new Error('Unexpected vacuum test directory');
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function fixture(hnswConfig?: HnswConfig) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'siftwell-vacuum-alias-'));
  directories.push(directory);
  const data = path.join(directory, 'source.db');
  const log = data + '.log';
  const sourceData = new RealFile(data),
    sourceLog = new RealFile(log);
  const db = await SimpleDbms.create(sourceData, sourceLog, hnswConfig);
  databases.push(db);
  await db.insertDocumentObject('docs', { id: 'original', title: 'preserve me' });
  await db.commit();
  return { directory, data, log, db, sourceData, sourceLog };
}

async function readOptional(filepath: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(filepath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

async function expectRejected(
  source: Awaited<ReturnType<typeof fixture>>,
  outputData: RealFile,
  outputLog: RealFile,
  message = /Vacuum preflight.*alias/,
) {
  const files = [source.data, source.log, outputData.filePath, outputLog.filePath];
  const before = await Promise.all(files.map(readOptional));
  const names = await fs.readdir(source.directory);
  const creates = [vi.spyOn(outputData, 'create'), vi.spyOn(outputLog, 'create')];
  const sourceSync = vi.spyOn(source.sourceData, 'sync');
  const walTruncate = vi.spyOn(source.sourceLog, 'truncate');
  await expect(source.db.vacuumCompactInto(outputData, outputLog)).rejects.toThrow(message);
  for (const create of creates) expect(create).not.toHaveBeenCalled();
  expect(sourceSync).not.toHaveBeenCalled();
  expect(walTruncate).not.toHaveBeenCalled();
  expect(await Promise.all(files.map(readOptional))).toEqual(before);
  expect(await fs.readdir(source.directory)).toEqual(names);
  expect(source.db.isHealthy).toBe(true);
  expect(await source.db.getDocumentById('docs', 'original')).toContain('preserve me');
  await source.db.insertDocumentObject('docs', { id: 'continued', title: 'still writable' });
  await source.db.commit();
  await source.db.close();
  const reopened = await SimpleDbms.open(new RealFile(source.data), new RealFile(source.log));
  databases.push(reopened);
  expect(await reopened.getDocumentById('docs', 'continued')).toContain('still writable');
}

async function aliasIfSupported(context: TestContext, create: () => Promise<void>): Promise<void> {
  try {
    await create();
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? ''))
      context.skip('Filesystem alias creation is unavailable');
    throw error;
  }
}

describe('vacuum destination file safety', () => {
  it.runIf(process.platform === 'win32').for(['default', 'named'])(
    'rejects a new Windows %s stream destination before creation',
    async (kind) => {
      const source = await fixture();
      const output = path.join(source.directory, 'new.db');
      const data = new RealFile(kind === 'default' ? output : source.data + ':vacuum');
      const create = vi.spyOn(data, 'create').mockRejectedValue(new Error('unsafe output creation attempted'));
      await expectRejected(
        source,
        data,
        new RealFile(kind === 'default' ? output + '::$DATA' : path.join(source.directory, 'new.log')),
        /Vacuum preflight.*(ambiguous|alias)/,
      );
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('rejects distinct wrappers for the source path before creating either output', async () => {
    const { directory, data, log, db } = await fixture();
    const before = await Promise.all([fs.readFile(data), fs.readFile(log)]);
    const outputData = new RealFile(data);
    const outputLog = new RealFile(path.join(directory, 'target.log'));
    const createData = vi.spyOn(outputData, 'create').mockRejectedValue(new Error('unsafe output creation attempted'));
    const createLog = vi.spyOn(outputLog, 'create');
    await expect(db.vacuumCompactInto(outputData, outputLog)).rejects.toThrow(/Vacuum preflight.*alias/);
    expect(createData).not.toHaveBeenCalled();
    expect(createLog).not.toHaveBeenCalled();
    expect(await Promise.all([fs.readFile(data), fs.readFile(log)])).toEqual(before);
    expect(await db.getDocumentById('docs', 'original')).toContain('preserve me');
  });

  it.each([
    ['destination data / source data', 'data', 'target.log'],
    ['destination data / source WAL', 'log', 'target.log'],
    ['destination WAL / source data', 'target.db', 'data'],
    ['destination WAL / source WAL', 'target.db', 'log'],
    ['destination data / destination WAL', 'target.db', 'target.db'],
  ])('preserves every file and the session for %s with separate wrappers', async (_label, dataName, logName) => {
    const source = await fixture();
    await fs.writeFile(path.join(source.directory, 'target.db'), 'existing destination data');
    await fs.writeFile(path.join(source.directory, 'target.log'), 'existing destination WAL');
    const outputPath = (name: string) =>
      name === 'data' ? source.data : name === 'log' ? source.log : path.join(source.directory, name);
    await expectRejected(source, new RealFile(outputPath(dataName)), new RealFile(outputPath(logName)));
  });

  it.each(['relative', 'dot', 'parent'])('detects equivalent %s source paths', async (variation) => {
    const source = await fixture();
    await fs.mkdir(path.join(source.directory, 'child'));
    const equivalent =
      variation === 'relative'
        ? path.relative(process.cwd(), source.data)
        : source.directory +
          path.sep +
          (variation === 'dot' ? '.' : 'child' + path.sep + '..') +
          path.sep +
          'source.db';
    await expectRejected(source, new RealFile(equivalent), new RealFile(path.join(source.directory, 'target.log')));
  });

  it.runIf(process.platform === 'win32')('detects equivalent path separators', async () => {
    const source = await fixture();
    await expectRejected(
      source,
      new RealFile(source.data.replaceAll('\\', '/')),
      new RealFile(path.join(source.directory, 'target.log')),
    );
  });

  it('detects case aliases when the actual filesystem resolves them to the same file', async (context) => {
    const source = await fixture();
    const alias = path.join(source.directory, 'SOURCE.DB');
    let metadata;
    try {
      metadata = await fs.stat(alias, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') context.skip('This directory is case sensitive');
      throw error;
    }
    const original = await fs.stat(source.data, { bigint: true });
    expect([metadata.dev, metadata.ino]).toEqual([original.dev, original.ino]);
    await expectRejected(source, new RealFile(alias), new RealFile(path.join(source.directory, 'target.log')));
  });

  it.for(['data', 'log'])('detects hard-linked source %s files', async (role, context) => {
    const source = await fixture();
    const alias = path.join(source.directory, 'hardlink.db');
    await aliasIfSupported(context, () => fs.link(source[role as 'data' | 'log'], alias));
    await expectRejected(source, new RealFile(alias), new RealFile(path.join(source.directory, 'target.log')));
  });

  it('detects two existing hard-linked outputs', async (context) => {
    const source = await fixture();
    const output = path.join(source.directory, 'target.db'),
      alias = path.join(source.directory, 'target.log');
    await fs.writeFile(output, 'preserve existing output');
    await aliasIfSupported(context, () => fs.link(output, alias));
    await expectRejected(source, new RealFile(output), new RealFile(alias));
  });

  it('detects symbolic links to existing source files', async (context) => {
    const source = await fixture();
    const alias = path.join(source.directory, 'symlink.db');
    await aliasIfSupported(context, () => fs.symlink(source.data, alias, 'file'));
    await expectRejected(source, new RealFile(alias), new RealFile(path.join(source.directory, 'target.log')));
  });

  it('detects a dangling symbolic link to the other new output', async (context) => {
    const source = await fixture();
    const output = path.join(source.directory, 'new.db'),
      alias = path.join(source.directory, 'alias.db');
    await aliasIfSupported(context, () => fs.symlink('new.db', alias, 'file'));
    await expectRejected(source, new RealFile(alias), new RealFile(output));
  });

  it.for(['existing', 'new'])('detects %s paths through directory aliases or junctions', async (kind, context) => {
    const source = await fixture();
    const alias = path.join(source.directory, 'directory-alias');
    await aliasIfSupported(context, () =>
      fs.symlink(source.directory, alias, process.platform === 'win32' ? 'junction' : 'dir'),
    );
    const output = kind === 'existing' ? source.data : path.join(source.directory, 'new.db');
    const throughAlias = path.join(alias, path.basename(output));
    await expectRejected(source, new RealFile(throughAlias), new RealFile(output));
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')(
    'rejects case variants of the same new output location conservatively',
    async () => {
      const source = await fixture();
      await expectRejected(
        source,
        new RealFile(path.join(source.directory, 'new.db')),
        new RealFile(path.join(source.directory, 'NEW.DB')),
      );
    },
  );

  it('validates the second output before truncating an existing first output or committing pending writes', async () => {
    const source = await fixture();
    await source.db.insertDocumentObject('docs', { id: 'pending', title: 'not committed yet' });
    const output = path.join(source.directory, 'target.db');
    await fs.writeFile(output, 'existing first output');
    await expectRejected(source, new RealFile(output), new RealFile(source.log));
  });

  it('rejects an invalid source data/WAL configuration before source commit', async () => {
    const source = await fixture();
    const backend = (source.db as unknown as { dbmsback: DbmsBack }).dbmsback;
    const log = vi.spyOn(backend, 'getVacuumLogFile').mockReturnValue(new RealFile(source.data));
    try {
      await expectRejected(
        source,
        new RealFile(path.join(source.directory, 'target.db')),
        new RealFile(path.join(source.directory, 'target.log')),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('retains I/O errors as preflight causes without touching any files', async () => {
    const source = await fixture();
    const output = new RealFile(path.join(source.directory, 'target.db'));
    const failure = new Error('identity lookup failed');
    vi.spyOn(output, 'getStorageIdentities').mockRejectedValue(failure);
    await expect(
      source.db.vacuumCompactInto(output, new RealFile(path.join(source.directory, 'target.log'))),
    ).rejects.toMatchObject({ cause: failure });
    await expectRejected(
      source,
      output,
      new RealFile(path.join(source.directory, 'target.log')),
      /Vacuum preflight.*identity lookup failed/,
    );
  });

  it('rejects compound file wrappers whose sidecar aliases a source file', async () => {
    const source = await fixture();
    const output = new RealFile(path.join(source.directory, 'target.db'));
    const create = vi.spyOn(output, 'create');
    const before = await Promise.all([fs.readFile(source.data), fs.readFile(source.log)]);
    await expect(
      source.db.vacuumCompactInto(
        new AtomicFile(output, new RealFile(source.log)),
        new RealFile(path.join(source.directory, 'target.log')),
      ),
    ).rejects.toThrow(/Vacuum preflight.*alias/);
    expect(create).not.toHaveBeenCalled();
    expect(await Promise.all([fs.readFile(source.data), fs.readFile(source.log)])).toEqual(before);
  });

  it('requires an explicit identity contract for custom storage while preserving independent memory files', async () => {
    const source = await SimpleDbms.create(new MockFile(4096), new MockFile(4096));
    databases.push(source);
    await source.insertDocumentObject('docs', { id: 'original', title: 'memory' });
    const opaque = new MockFile(4096);
    Object.defineProperty(opaque, 'getStorageIdentities', { value: undefined });
    const create = vi.spyOn(opaque, 'create');
    await expect(source.vacuumCompactInto(opaque, new MockFile(4096))).rejects.toThrow(/getStorageIdentities/);
    expect(create).not.toHaveBeenCalled();
    const backing = new MockFile(4096);
    const first = new MockFile(4096),
      second = new MockFile(4096);
    vi.spyOn(first, 'getStorageIdentities').mockResolvedValue([{ kind: 'resource', resource: backing }]);
    vi.spyOn(second, 'getStorageIdentities').mockResolvedValue([{ kind: 'resource', resource: backing }]);
    await expect(source.vacuumCompactInto(first, second)).rejects.toThrow(/alias/);
    const target = await source.vacuumCompactInto(new MockFile(4096), new MockFile(4096));
    databases.push(target);
    expect(await target.getDocumentById('docs', 'original')).toContain('memory');
  });

  it('keeps identical wrapper checks for crossed roles through the direct vacuum entry point', async () => {
    const source = await fixture();
    const backend = (source.db as unknown as { dbmsback: DbmsBack }).dbmsback;
    const commit = vi.spyOn(backend, 'commit');
    const create = vi.spyOn(source.sourceLog, 'create');
    await expect(
      new VacuumService({
        source: backend,
        tempDataFile: source.sourceLog,
        tempLogFile: new RealFile(path.join(source.directory, 'new.log')),
      }).run(),
    ).rejects.toThrow(/Vacuum preflight.*alias/);
    expect(commit).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects missing custom identities before any output creation', async () => {
    const source = await fixture();
    const output = new RealFile(path.join(source.directory, 'new.db'));
    vi.spyOn(output, 'getStorageIdentities').mockResolvedValue([]);
    await expectRejected(
      source,
      output,
      new RealFile(path.join(source.directory, 'new.log')),
      /missing or invalid storage identities/,
    );
  });

  it('compares open source handles after their original path has moved', async () => {
    const source = await fixture();
    const moved = path.join(source.directory, 'moved.db');
    await fs.rename(source.data, moved);
    try {
      const before = await Promise.all([fs.readFile(moved), fs.readFile(source.log)]);
      const output = new RealFile(moved);
      const create = vi.spyOn(output, 'create');
      await expect(
        source.db.vacuumCompactInto(output, new RealFile(path.join(source.directory, 'new.log'))),
      ).rejects.toThrow(/alias/);
      expect(create).not.toHaveBeenCalled();
      expect(await Promise.all([fs.readFile(moved), fs.readFile(source.log)])).toEqual(before);
      expect(await source.db.getDocumentById('docs', 'original')).toContain('preserve me');
    } finally {
      await fs.rename(moved, source.data);
    }
  });

  it.each(['new', 'existing'])(
    'preserves documents, indexes, codecs, binary data and semantics with valid %s outputs and reopening',
    async (kind) => {
      const config: HnswConfig = {
        dimension: 3,
        M: 4,
        efConstruction: 16,
        efSearch: 16,
        embeddingFn: (text) => Promise.resolve(new Float32Array([text.includes('updated') ? 1 : 0, 1, 0])),
      };
      const source = await fixture(config);
      await source.db.setFieldIndexed('docs', 'body', false);
      source.db.setFieldCompressionDefaults('docs', { body: 'gzip', binary: 'gzip' });
      source.db.setFieldCompressionDefaults('empty', { content: 'deflate' });
      await source.db.editDocument('docs', 'original', 'title', 'updated');
      const binary = Buffer.from([0, 255, 128, 42]);
      await source.db.insertDocumentObject(
        'docs',
        { id: 'live', title: 'live', body: 'body '.repeat(1000), binary },
        { compression: { body: 'brotli', binary: 'none' } },
      );
      await source.db.insertDocumentObject('docs', { id: 'deleted', title: 'removed' });
      await source.db.deleteDocumentById('docs', 'deleted');
      await source.db.insertDocumentObject('numbers', { id: 42, score: 7 });
      await source.db.commit();
      const data = path.join(source.directory, 'vacuum.db'),
        log = path.join(source.directory, 'vacuum.log');
      if (kind === 'existing') {
        await fs.writeFile(data, 'replace existing destination data');
        await fs.writeFile(log, 'replace existing destination log');
      }
      const phases: string[] = [];
      const target = await source.db.vacuumCompactInto(new RealFile(data), new RealFile(log), (event) =>
        phases.push(event.phase),
      );
      databases.push(target);
      expect(phases).toContain('validate');
      expect(phases.at(-1)).toBe('done');
      const check = async () => {
        expect(target.listCollections().sort()).toEqual(source.db.listCollections().sort());
        expect(target.getFieldIndexConfig('docs')).toEqual(source.db.getFieldIndexConfig('docs'));
        expect(target.getFieldCompressionDefaults('docs')).toEqual(source.db.getFieldCompressionDefaults('docs'));
        expect(target.getFieldCompressionDefaults('empty')).toEqual({ content: 'deflate' });
        for (const id of ['original', 'live']) {
          expect(await target.getDocumentObjectById('docs', id)).toEqual(
            await source.db.getDocumentObjectById('docs', id),
          );
          expect(JSON.parse(await target.getDocumentById('docs', id, { encoded: true }))).toEqual(
            JSON.parse(await source.db.getDocumentById('docs', id, { encoded: true })),
          );
        }
        expect(await target.getDocumentObjectById('numbers', 42)).toMatchObject({ id: 42, score: 7 });
        const indexed = [];
        for await (const doc of target.cursorEqual('docs', 'title', 'updated')) indexed.push(JSON.parse(doc));
        expect(indexed).toEqual([{ id: 'original', title: 'updated' }]);
        expect(
          (await target.semanticSearch('docs', 'updated', 5))
            .map((doc) => (JSON.parse(doc) as { id: string }).id)
            .sort(),
        ).toEqual(['live', 'original']);
        const backend = (target as unknown as { dbmsback: DbmsBack }).dbmsback;
        expect((await backend.inspectHnswGraphStructureSnapshot('docs')).nodes.every((node) => !node.deleted)).toBe(
          true,
        );
      };
      await check();
      await target.reopen(new RealFile(data), new RealFile(log));
      await check();
    },
  );
});
