import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type StoredDatabase = { name: string; filename: string };
export const DEFAULT_DATABASE_DIRECTORY = path.resolve(import.meta.dirname, '../../../databases');

export class DatabaseCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseCatalogError';
  }
}

function folded(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

function databaseName(value: string): StoredDatabase {
  if (typeof value !== 'string') throw new DatabaseCatalogError('Enter a database name.');
  const name = value.replace(/\.db$/i, '').normalize('NFC');
  if (
    !name ||
    name !== name.trim() ||
    !/^[\p{L}\p{M}\p{N} _-]+$/u.test(name) ||
    /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(name) ||
    Buffer.byteLength(`${name}.db`, 'utf8') > 160
  )
    throw new DatabaseCatalogError(
      'Use a database name containing letters, numbers, spaces, hyphens or underscores, with an optional .db suffix. Paths and reserved filenames are not allowed.',
    );
  return { name, filename: `${name}.db` };
}

function isCompanion(filename: string, databaseFilename: string): boolean {
  const file = folded(filename);
  const database = folded(databaseFilename);
  return (
    file === database ||
    file === `${database}.log` ||
    file === `${database}.model.json` ||
    file.startsWith(`${database}.vacuum-`) ||
    file.startsWith(`${database}.log.vacuum-`)
  );
}

/** The webclient's persistent database directory. Raw library paths are independent of this catalog. */
export class DatabaseCatalog {
  readonly directory: string;

  constructor(directory = DEFAULT_DATABASE_DIRECTORY) {
    this.directory = path.resolve(directory);
  }

  private async entries(): Promise<string[]> {
    await fs.mkdir(this.directory, { recursive: true });
    const directory = await fs.lstat(this.directory);
    const realDirectory = await fs.realpath(this.directory);
    const canonical = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
    if (
      directory.isSymbolicLink() ||
      !directory.isDirectory() ||
      canonical(realDirectory) !== canonical(this.directory)
    )
      throw new DatabaseCatalogError(
        'The databases folder must be a real directory, without symbolic links or junctions.',
      );
    return fs.readdir(this.directory);
  }

  private async regularFile(filename: string): Promise<void> {
    const stat = await fs.lstat(path.join(this.directory, filename));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new DatabaseCatalogError(`Database files must be regular files without links: ${filename}`);
  }

  private async validateCompanions(filename: string, entries: string[]): Promise<void> {
    for (const companion of entries.filter((entry) => isCompanion(entry, filename))) await this.regularFile(companion);
    for (const suffix of ['', '.log', '.model.json']) {
      const matches = entries.filter((entry) => folded(entry) === folded(`${filename}${suffix}`));
      if (matches.length > 1 || (matches.length === 1 && matches[0] !== `${filename}${suffix}`))
        throw new DatabaseCatalogError(`Database companion filenames have conflicting capitalization: ${filename}`);
    }
  }

  async list(): Promise<StoredDatabase[]> {
    const entries = await this.entries();
    const databases: StoredDatabase[] = [];
    const candidates = new Set(entries.map((entry) => entry.replace(/\.vacuum-state\.json$/i, '')));
    for (const filename of candidates) {
      if (!/\.db$/i.test(filename)) continue;
      let database: StoredDatabase;
      try {
        database = databaseName(filename);
      } catch (error) {
        if (error instanceof DatabaseCatalogError) continue;
        throw error;
      }
      try {
        await this.validateCompanions(filename, entries);
      } catch (error) {
        if (error instanceof DatabaseCatalogError) continue;
        throw error;
      }
      databases.push({ name: database.name, filename });
    }
    return databases.sort(
      (a, b) => folded(a.name).localeCompare(folded(b.name)) || a.filename.localeCompare(b.filename),
    );
  }

  /** Validate every existing companion before a caller closes its current database. */
  async existing(name: string, requireData = false): Promise<string> {
    const requested = databaseName(name);
    const entries = await this.entries();
    const matches = entries.filter((entry) => folded(entry) === folded(requested.filename));
    const manifests = entries.filter((entry) => folded(entry) === folded(`${requested.filename}.vacuum-state.json`));
    if (matches.length > 1 || (!matches.length && (requireData || manifests.length !== 1)))
      throw new DatabaseCatalogError(
        matches.length
          ? 'Database filenames have conflicting capitalization.'
          : 'The selected database does not exist.',
      );
    const filename = matches[0] ?? manifests[0].slice(0, -'.vacuum-state.json'.length);
    await this.validateCompanions(filename, entries);
    return path.join(this.directory, filename);
  }

  /** An orphan WAL, model sidecar or vacuum artifact reserves its database name. */
  async unused(name: string): Promise<string> {
    const requested = databaseName(name);
    const entries = await this.entries();
    if (entries.some((entry) => isCompanion(entry, requested.filename)))
      throw new DatabaseCatalogError(
        'A database or companion file already exists with that name. Choose a different name or open the existing database.',
      );
    return path.join(this.directory, requested.filename);
  }
}
