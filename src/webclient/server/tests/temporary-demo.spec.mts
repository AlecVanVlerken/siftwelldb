import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoDirectoryStore, DemoLeases } from '../temporary-demo.mjs';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

let root: string;
let store: DemoDirectoryStore;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'siftwell-demo-ownership-test-'));
  store = new DemoDirectoryStore(path.join(root, 'owned'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (
    path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) ||
    !path.basename(root).startsWith('siftwell-demo-ownership-test-')
  )
    throw new Error('Unexpected cleanup path');
  await fs.rm(root, { recursive: true, force: true });
});

describe('owned temporary demo directories', () => {
  it('removes a partially written ownership marker when directory creation fails', async () => {
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await original.open(file, flags, mode);
      if (path.basename(String(file)) === '.siftwelldb-demo.json') {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementation(async () => {
          await write('{partial');
          throw new Error('Ownership write failed');
        });
      }
      return handle;
    });
    await expect(store.create()).rejects.toThrow('Ownership write failed');
    expect(await fs.readdir(store.root)).toEqual([]);
  });

  it('retains its ownership marker after an output deletion fails and can safely retry', async () => {
    const owned = await store.create();
    const blocked = path.join(owned.directory, 'demo.db.log');
    await fs.writeFile(path.join(owned.directory, 'demo.db'), 'generated');
    await fs.writeFile(blocked, 'locked output');
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const remove = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      if (file === blocked) throw new Error('Output is locked');
      await original.rm(file, options);
    });
    await expect(store.remove(owned)).rejects.toThrow('Output is locked');
    expect((await fs.stat(path.join(owned.directory, '.siftwelldb-demo.json'))).isFile()).toBe(true);
    expect(await fs.readFile(blocked, 'utf8')).toBe('locked output');
    remove.mockRestore();
    await store.remove(owned);
    await expect(fs.stat(owned.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('removes only positively owned flat outputs, including WAL, models and vacuum files, and is idempotent', async () => {
    const owned = await store.create();
    const unrelated = path.join(root, 'user-demo.db');
    await fs.writeFile(unrelated, 'valuable user data');
    for (const filename of ['demo.db', 'demo.db.log', 'demo.db.model.json', '.vacuum-manifest.json'])
      await fs.writeFile(path.join(owned.directory, filename), 'generated');
    expect(await store.footprint(owned)).toBeGreaterThan(36);
    await store.remove(owned);
    await store.remove(owned);
    await expect(fs.stat(owned.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(unrelated, 'utf8')).toBe('valuable user data');
  });

  it('refuses forged targets, changed ownership and unexpected nested directories', async () => {
    const owned = await store.create();
    await expect(store.remove({ ...owned, directory: root })).rejects.toThrow('outside');
    await expect(store.remove({ ...owned, token: randomUUID() })).rejects.toThrow('ownership changed');
    await fs.mkdir(path.join(owned.directory, 'source-assets'));
    await fs.writeFile(path.join(owned.directory, 'source-assets', 'keep.jpg'), 'source image');
    await expect(store.remove(owned)).rejects.toThrow('Unexpected directory');
    expect(await fs.readFile(path.join(owned.directory, 'source-assets', 'keep.jpg'), 'utf8')).toBe('source image');
  });

  it('startup removes dead-process owned demos while preserving live owners and unmarked lookalikes', async () => {
    const live = await store.create();
    const abandoned = await store.create();
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
    const pid = child.pid!;
    await new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve());
      child.once('error', reject);
    });
    const markerPath = path.join(abandoned.directory, '.siftwelldb-demo.json');
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as Record<string, unknown>;
    marker['pid'] = pid;
    await fs.writeFile(markerPath, JSON.stringify(marker));
    const unmarked = path.join(store.root, `demo-${randomUUID()}`);
    await fs.mkdir(unmarked);
    await fs.writeFile(path.join(unmarked, 'precious.db'), 'keep');
    expect(await store.cleanupAbandoned()).toEqual([]);
    await expect(fs.stat(abandoned.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(live.directory)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(unmarked, 'precious.db'), 'utf8')).toBe('keep');
  });

  it('retains ambiguous or tampered startup markers instead of inferring ownership from names', async () => {
    const owned = await store.create();
    const markerPath = path.join(owned.directory, '.siftwelldb-demo.json');
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as Record<string, unknown>;
    marker['pid'] = 2_000_000_000;
    marker['filepath'] = path.join(root, 'user.db');
    await fs.writeFile(markerPath, JSON.stringify(marker));
    expect(await store.cleanupAbandoned()).toEqual([expect.stringContaining('files retained')]);
    expect((await fs.stat(owned.directory)).isDirectory()).toBe(true);
  });
});

describe('demo tab leases', () => {
  it('allows heartbeat recovery and keeps another active tab protected after a page release', () => {
    const leases = new DemoLeases(90, 60);
    leases.touch('client-one', 0);
    leases.touch('client-two', 40);
    leases.release('client-one', 50);
    expect(leases.expired(100)).toBe(false);
    expect(leases.active(100)).toEqual(['client-two']);
    leases.touch('client-two', 120);
    expect(leases.expired(200)).toBe(false);
    expect(leases.expired(269)).toBe(false);
    expect(leases.expired(270)).toBe(true);
  });

  it('uses a release grace period and refuses invalid client identities', () => {
    const leases = new DemoLeases(90, 60);
    leases.touch('client-one', 0);
    leases.release('client-one', 50);
    expect(leases.expired(109)).toBe(false);
    expect(leases.expired(110)).toBe(true);
    expect(() => leases.touch('../user-db')).toThrow('Invalid');
  });
});
