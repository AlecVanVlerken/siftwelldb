import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BigIntStats } from 'node:fs';
import type { File } from './file.mjs';

export type FileIdentity =
  | { kind: 'filesystem'; path: string; device?: bigint; inode?: bigint }
  | { kind: 'resource'; resource: object };

/** Resolve existing links, including a dangling link to an intended new file. */
async function canonicalPath(filepath: string): Promise<string> {
  try {
    return await fs.realpath(filepath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let link: string;
  try {
    link = await fs.readlink(filepath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // NTFS streams can share a physical file even when the stream does not yet
    // exist (including the unnamed stream alias `file::$DATA`).
    if (process.platform === 'win32' && path.basename(filepath).includes(':'))
      throw new Error(`Cannot validate an ambiguous new Windows stream path: ${filepath}`);
    return path.join(await fs.realpath(path.dirname(filepath)), path.basename(filepath));
  }
  return canonicalPath(path.isAbsolute(link) ? link : path.dirname(filepath) + path.sep + link);
}

function physicalIdentity(canonical: string, stat: BigIntStats): FileIdentity {
  if (!stat.isFile() || stat.ino === 0n)
    throw new Error(`Cannot establish a regular file's physical identity: ${canonical}`);
  return { kind: 'filesystem', path: canonical, device: stat.dev, inode: stat.ino };
}

/** Includes the open handle's identity if its original path has since moved. */
export async function filesystemIdentities(filepath: string, handle: fs.FileHandle | null): Promise<FileIdentity[]> {
  const canonical = await canonicalPath(filepath);
  const identities: FileIdentity[] = [];
  try {
    identities.push(physicalIdentity(canonical, await fs.stat(filepath, { bigint: true })));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    identities.push({ kind: 'filesystem', path: canonical });
  }
  if (handle) identities.push(physicalIdentity(canonical, await handle.stat({ bigint: true })));
  return identities;
}

export async function fileIdentities(file: File): Promise<readonly FileIdentity[]> {
  if (!file.getStorageIdentities)
    throw new Error('File implementation must provide getStorageIdentities() for vacuum.');
  const identities = await file.getStorageIdentities();
  if (
    identities.length === 0 ||
    identities.some((identity) =>
      identity.kind === 'resource'
        ? identity.resource === null || typeof identity.resource !== 'object'
        : identity.kind !== 'filesystem' || !path.isAbsolute(identity.path),
    )
  )
    throw new Error('File implementation returned missing or invalid storage identities.');
  return identities;
}

export function identitiesAlias(a: FileIdentity, b: FileIdentity): boolean {
  if (a.kind === 'resource' || b.kind === 'resource')
    return a.kind === 'resource' && b.kind === 'resource' && a.resource === b.resource;
  if (a.device !== undefined && a.inode !== undefined && a.device === b.device && a.inode === b.inode) return true;
  if (a.path === b.path) return true;
  // New case variants are conservatively rejected on platforms commonly using
  // case-insensitive filesystems. Existing distinct files retain their identities.
  return (
    (process.platform === 'win32' || process.platform === 'darwin') &&
    (a.inode === undefined || b.inode === undefined) &&
    a.path.toLowerCase() === b.path.toLowerCase()
  );
}
