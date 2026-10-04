import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RealFile } from '../core/file.mjs';
import { AtomicFile } from './atomicfile.mjs';

describe('WAL recovery after process termination', () => {
  it.each(['before-log', 'after-log', 'during-data'] as const)(
    'recovers an interrupted transaction at %s',
    async (failpoint) => {
      const directory = await mkdtemp(join(tmpdir(), 'simpledbms-wal-'));
      const target = resolve(directory);
      if (!target.startsWith(resolve(tmpdir()) + '\\') && !target.startsWith(resolve(tmpdir()) + '/')) {
        throw new Error('Temporary directory is outside the system temporary directory');
      }
      const dataPath = join(directory, 'data.bin');
      const logPath = join(directory, 'log.wal');
      try {
        const original = Buffer.concat([Buffer.alloc(4096, 1), Buffer.alloc(4096, 2)]);
        const initial = new AtomicFile(new RealFile(dataPath), new RealFile(logPath));
        await initial.create();
        expect(await initial.atomicWrite(new Map([[0, original]]))).toBe(true);
        await initial.close();

        // Resolve the source worker even when this test is run from build/.
        const worker = fileURLToPath(new URL('../../src/atomic/fixtures/crash-worker.mts', import.meta.url));
        const result = spawnSync(process.execPath, ['--import', 'tsx', worker, directory, failpoint], {
          encoding: 'utf-8',
          timeout: 20_000,
          windowsHide: true,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(86);
        expect(result.stderr).toContain(`FAILPOINT:${failpoint}`);

        const recovered = new AtomicFile(new RealFile(dataPath), new RealFile(logPath));
        await recovered.open();
        await recovered.close();
        const expected =
          failpoint === 'before-log'
            ? original
            : Buffer.concat([Buffer.alloc(4096, 3), Buffer.alloc(4096, 4), Buffer.alloc(4096, 5)]);
        expect(await readFile(dataPath)).toEqual(expected);
        expect((await stat(logPath)).size).toBe(0);

        // A second reopen must be idempotent after recovery cleared the WAL.
        const reopened = new AtomicFile(new RealFile(dataPath), new RealFile(logPath));
        await reopened.open();
        await reopened.close();
        expect(await readFile(dataPath)).toEqual(expected);
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
