import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const OWNER_FILE = '.siftwelldb-demo.json';
const APPLICATION = 'siftwelldb-temporary-demo';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type OwnedDemoDirectory = Readonly<{
  id: string;
  directory: string;
  filepath: string;
  token: string;
  pid: number;
}>;

/** Ownership is established when creating a directory, never from a user database's filename. */
export class DemoDirectoryStore {
  readonly root: string;

  constructor(root = path.join(tmpdir(), 'siftwelldb-demos')) {
    this.root = path.resolve(root);
  }

  private async prepareRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const info = await fs.lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(this.root)) !== this.root)
      throw new Error('Temporary demo root must be a real directory without filesystem aliases.');
  }

  async create(id = randomUUID()): Promise<OwnedDemoDirectory> {
    if (!UUID.test(id)) throw new Error('Invalid temporary demo identity.');
    await this.prepareRoot();
    const directory = path.join(this.root, `demo-${id}`);
    await fs.mkdir(directory);
    const owned = Object.freeze({
      id,
      directory,
      filepath: path.join(directory, 'demo.db'),
      token: randomUUID(),
      pid: process.pid,
    });
    let marker: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      marker = await fs.open(path.join(directory, OWNER_FILE), 'wx');
      await marker.writeFile(JSON.stringify({ application: APPLICATION, version: 1, ...owned }));
      await marker.close();
    } catch (error) {
      // A failed write can leave a partial marker. Only remove one we exclusively created.
      try {
        if (marker) {
          await marker.close();
          await fs.rm(path.join(directory, OWNER_FILE), { force: true });
        }
        await fs.rmdir(directory);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Temporary demo ownership creation and cleanup failed.');
      }
      throw error;
    }
    return owned;
  }

  private async verify(owned: OwnedDemoDirectory): Promise<boolean> {
    if (
      !UUID.test(owned.id) ||
      !UUID.test(owned.token) ||
      path.dirname(owned.directory) !== this.root ||
      owned.directory !== path.join(this.root, `demo-${owned.id}`) ||
      owned.filepath !== path.join(owned.directory, 'demo.db')
    )
      throw new Error('Refusing cleanup outside an owned temporary demo directory.');
    await this.prepareRoot();
    let info;
    try {
      info = await fs.lstat(owned.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(owned.directory)) !== owned.directory)
      throw new Error('Refusing cleanup of an aliased temporary demo directory.');
    const ownerPath = path.join(owned.directory, OWNER_FILE);
    if ((await fs.lstat(ownerPath)).isSymbolicLink()) throw new Error('Invalid demo ownership marker.');
    const marker: unknown = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    if (!marker || typeof marker !== 'object' || Array.isArray(marker))
      throw new Error('Invalid demo ownership marker.');
    const record = marker as Record<string, unknown>;
    if (
      record['application'] !== APPLICATION ||
      record['version'] !== 1 ||
      record['id'] !== owned.id ||
      record['token'] !== owned.token ||
      record['pid'] !== owned.pid ||
      record['directory'] !== owned.directory ||
      record['filepath'] !== owned.filepath
    )
      throw new Error('Temporary demo ownership changed; files retained.');
    // Demo outputs are flat files (database, WAL, model, and vacuum recovery files).
    // Refuse nested directories or links rather than crossing their boundaries during recursive removal.
    for (const entry of await fs.readdir(owned.directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error('Unexpected directory or link in temporary demo; files retained.');
    }
    return true;
  }

  async remove(owned: OwnedDemoDirectory): Promise<void> {
    if (owned.pid !== process.pid && processExists(owned.pid))
      throw new Error('Another running process owns this temporary demo.');
    if (!(await this.verify(owned))) return;
    // Keep ownership evidence until every generated output has gone. Recursive
    // removal could erase the marker before a locked database/WAL reports failure.
    for (const name of await fs.readdir(owned.directory)) {
      if (name === OWNER_FILE) continue;
      const file = path.resolve(owned.directory, name);
      if (path.dirname(file) !== owned.directory) throw new Error('Unexpected demo cleanup target.');
      await fs.rm(file, { force: true });
    }
    await fs.rm(path.join(owned.directory, OWNER_FILE));
    try {
      await fs.rmdir(owned.directory);
    } catch (error) {
      // A directory removal failure is retryable too; restore its marker if it still exists.
      await fs
        .writeFile(
          path.join(owned.directory, OWNER_FILE),
          JSON.stringify({ application: APPLICATION, version: 1, ...owned }),
          { flag: 'wx' },
        )
        .catch(() => undefined);
      throw error;
    }
  }

  async footprint(owned: OwnedDemoDirectory): Promise<number> {
    if (!(await this.verify(owned))) return 0;
    let bytes = 0;
    for (const entry of await fs.readdir(owned.directory))
      bytes += (await fs.stat(path.join(owned.directory, entry))).size;
    return bytes;
  }

  async cleanupAbandoned(): Promise<string[]> {
    await this.prepareRoot();
    const warnings: string[] = [];
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('demo-')) continue;
      const id = entry.name.slice(5);
      if (!UUID.test(id)) continue;
      const directory = path.join(this.root, entry.name);
      try {
        const ownerPath = path.join(directory, OWNER_FILE);
        if (!(await fs.lstat(ownerPath)).isFile()) continue;
        const record = JSON.parse(await fs.readFile(ownerPath, 'utf8')) as Record<string, unknown>;
        if (
          record['application'] !== APPLICATION ||
          record['version'] !== 1 ||
          record['id'] !== id ||
          typeof record['token'] !== 'string' ||
          !UUID.test(record['token']) ||
          typeof record['pid'] !== 'number' ||
          !Number.isSafeInteger(record['pid']) ||
          record['pid'] <= 0
        )
          continue;
        if (processExists(record['pid'])) continue;
        await this.remove({
          id,
          directory,
          filepath: path.join(directory, 'demo.db'),
          token: record['token'],
          pid: record['pid'],
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        warnings.push(`Retained ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return warnings;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export class DemoSessionConflictError extends Error {}

export type DemoStatus = {
  id: string | null;
  state: 'idle' | 'creating' | 'ready' | 'failed' | 'cancelling';
  stage: string;
  collection: string | null;
  completed: number;
  total: number;
  counts: Record<string, number>;
  error: string | null;
  filepath: string | null;
  temporary: boolean;
  bytes: number | null;
  warnings: string[];
  durationMs: number | null;
  clientActive?: boolean;
};

export function emptyDemoStatus(): DemoStatus {
  return {
    id: null,
    state: 'idle',
    stage: '',
    collection: null,
    completed: 0,
    total: 0,
    counts: {},
    error: null,
    filepath: null,
    temporary: false,
    bytes: null,
    warnings: [],
    durationMs: null,
  };
}

/** Per-tab leases fit the daemon's existing single connected database model. */
export class DemoLeases {
  private readonly clients = new Map<string, number>();
  private unusedSince: number | null = null;

  constructor(
    readonly leaseMs = 90_000,
    readonly graceMs = 60_000,
  ) {}

  static validateClient(clientId: string): void {
    if (!/^[a-zA-Z0-9-]{8,128}$/.test(clientId)) throw new DemoSessionConflictError('Invalid demo client identity.');
  }

  touch(clientId: string, now = Date.now()): void {
    DemoLeases.validateClient(clientId);
    this.clients.set(clientId, now + this.leaseMs);
    this.unusedSince = null;
  }

  release(clientId: string, now = Date.now()): void {
    this.active(now);
    const wasActive = this.clients.has(clientId);
    this.clients.delete(clientId);
    if (this.clients.size === 0 && wasActive) this.unusedSince = now;
  }

  active(now = Date.now()): string[] {
    let lastExpiry = 0;
    for (const [client, expires] of this.clients) {
      if (expires <= now) {
        this.clients.delete(client);
        lastExpiry = Math.max(lastExpiry, expires);
      }
    }
    if (this.clients.size === 0) this.unusedSince ??= lastExpiry || now;
    return [...this.clients.keys()];
  }

  assertExclusive(clientId?: string): void {
    if (this.active().some((client) => client !== clientId))
      throw new DemoSessionConflictError(
        'This temporary demo is still in use in another tab. Disconnect the other tab before switching or ending it.',
      );
  }

  expired(now = Date.now()): boolean {
    return this.active(now).length === 0 && this.unusedSince !== null && now - this.unusedSince >= this.graceMs;
  }
}
