import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

type Fingerprint = { size: number; sha256: string };
type Pair = { data: Fingerprint; log: Fingerprint };
export type VacuumPaths = {
  data: string;
  log: string;
  tempData: string;
  tempLog: string;
  backupData: string;
  backupLog: string;
  manifest: string;
  nextManifest: string;
  id: string;
};
export type VacuumManifest = {
  version: 1;
  id: string;
  phase: 'prepared' | 'verified';
  original: Pair;
  replacement: Pair;
};
export type VacuumCheckpoint = (phase: string) => Promise<void>;

export function vacuumPaths(filepath: string, id: string = randomUUID()): VacuumPaths {
  const data = path.resolve(filepath);
  const log = `${data}.log`;
  return {
    data,
    log,
    tempData: `${data}.vacuum-${id}.tmp`,
    tempLog: `${log}.vacuum-${id}.tmp`,
    backupData: `${data}.vacuum-${id}.bak`,
    backupLog: `${log}.vacuum-${id}.bak`,
    manifest: `${data}.vacuum-state.json`,
    nextManifest: `${data}.vacuum-state.json.next`,
    id,
  };
}

async function exists(filepath: string): Promise<boolean> {
  try {
    await fs.lstat(filepath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function fingerprint(filepath: string): Promise<Fingerprint | null> {
  let stat;
  try {
    stat = await fs.lstat(filepath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile()) throw new Error(`Vacuum recovery requires a regular file: ${filepath}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filepath)) hash.update(chunk as Buffer);
  return { size: stat.size, sha256: hash.digest('hex') };
}

function matches(actual: Fingerprint | null, expected: Fingerprint): boolean {
  return actual !== null && actual.size === expected.size && actual.sha256 === expected.sha256;
}

async function requiredFingerprint(filepath: string): Promise<Fingerprint> {
  const result = await fingerprint(filepath);
  if (!result) throw new Error(`Vacuum replacement is missing a required file: ${filepath}`);
  return result;
}

async function syncFile(filepath: string): Promise<void> {
  const handle = await fs.open(filepath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Node cannot fsync directories on Windows. File fsync still runs there;
 * directory-entry durability across power loss is consequently not guaranteed.
 * On other platforms, directory open/sync failures propagate. */
async function syncDirectory(filepath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await fs.open(path.dirname(filepath), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function rename(source: string, target: string): Promise<void> {
  if (await exists(target)) throw new Error(`Vacuum recovery refuses to overwrite ${target}`);
  await fs.rename(source, target);
  await syncDirectory(target);
}

async function remove(filepath: string): Promise<void> {
  try {
    await fs.unlink(filepath);
    await syncDirectory(filepath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function artifactNames(filepath: string): Promise<string[]> {
  const paths = vacuumPaths(filepath);
  const basename = artifactName(paths.data);
  try {
    return (await fs.readdir(path.dirname(paths.data))).filter(
      (name) =>
        artifactName(name).startsWith(`${basename}.vacuum-`) ||
        artifactName(name).startsWith(`${basename}.log.vacuum-`),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function artifactName(filepath: string): string {
  const name = path.basename(filepath);
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

export async function assertNoVacuumArtifacts(filepath: string): Promise<void> {
  const artifacts = await artifactNames(filepath);
  if (artifacts.length) {
    throw new Error(
      `Unfinished or ambiguous vacuum files exist for ${filepath}: ${artifacts.join(', ')}. Files were retained.`,
    );
  }
}

function parseManifest(raw: string): VacuumManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('Vacuum recovery manifest is incomplete or malformed. Files were retained.', { cause: error });
  }
  const validFingerprint = (item: unknown): item is Fingerprint => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as Fingerprint;
    return Number.isSafeInteger(candidate.size) && candidate.size >= 0 && /^[a-f0-9]{64}$/.test(candidate.sha256);
  };
  const candidate = value as VacuumManifest | null;
  if (
    !candidate ||
    candidate.version !== 1 ||
    typeof candidate.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(candidate.id) ||
    !['prepared', 'verified'].includes(candidate.phase) ||
    !validFingerprint(candidate.original?.data) ||
    !validFingerprint(candidate.original?.log) ||
    !validFingerprint(candidate.replacement?.data) ||
    !validFingerprint(candidate.replacement?.log)
  ) {
    throw new Error('Vacuum recovery manifest is invalid. Files were retained.');
  }
  return candidate;
}

async function publishManifest(paths: VacuumPaths, manifest: VacuumManifest): Promise<void> {
  // The only overwrite in this protocol is a complete, fsynced manifest replacing
  // its previous phase. A leftover .next never authorizes a verified decision.
  const handle = await fs.open(paths.nextManifest, 'wx');
  try {
    await handle.writeFile(JSON.stringify(manifest));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(paths.nextManifest, paths.manifest);
  await syncDirectory(paths.manifest);
}

/** Both generations must be closed and the replacement logically validated. */
export async function prepareVacuumReplacement(paths: VacuumPaths): Promise<VacuumManifest> {
  const allowed = new Set([artifactName(paths.tempData), artifactName(paths.tempLog)]);
  const unexpected = (await artifactNames(paths.data)).filter((name) => !allowed.has(artifactName(name)));
  if (unexpected.length) throw new Error(`Vacuum artifacts already exist: ${unexpected.join(', ')}`);
  for (const filepath of [paths.data, paths.log, paths.tempData, paths.tempLog]) await syncFile(filepath);
  const manifest: VacuumManifest = {
    version: 1,
    id: paths.id,
    phase: 'prepared',
    original: { data: await requiredFingerprint(paths.data), log: await requiredFingerprint(paths.log) },
    replacement: { data: await requiredFingerprint(paths.tempData), log: await requiredFingerprint(paths.tempLog) },
  };
  await publishManifest(paths, manifest);
  return manifest;
}

export async function installVacuumReplacement(paths: VacuumPaths, checkpoint?: VacuumCheckpoint): Promise<void> {
  await checkpoint?.('prepare');
  await rename(paths.data, paths.backupData);
  await checkpoint?.('firstbackup');
  await rename(paths.log, paths.backupLog);
  await checkpoint?.('bothbackup');
  await rename(paths.tempData, paths.data);
  await checkpoint?.('datainstall');
  await rename(paths.tempLog, paths.log);
  await checkpoint?.('loginstall');
}

type State = { canonical: Fingerprint | null; backup: Fingerprint | null; temporary: Fingerprint | null };

async function inspect(paths: VacuumPaths, manifest: VacuumManifest): Promise<{ data: State; log: State }> {
  const allowed = new Set(
    [paths.tempData, paths.tempLog, paths.backupData, paths.backupLog, paths.manifest, paths.nextManifest].map((file) =>
      artifactName(file),
    ),
  );
  if ((await artifactNames(paths.data)).some((name) => !allowed.has(artifactName(name)))) {
    throw new Error('Vacuum recovery found artifacts from another operation. Files were retained.');
  }
  const result = {} as { data: State; log: State };
  for (const kind of ['data', 'log'] as const) {
    const state: State = {
      canonical: await fingerprint(paths[kind]),
      backup: await fingerprint(kind === 'data' ? paths.backupData : paths.backupLog),
      temporary: await fingerprint(kind === 'data' ? paths.tempData : paths.tempLog),
    };
    if (
      (state.canonical &&
        !matches(state.canonical, manifest.original[kind]) &&
        !matches(state.canonical, manifest.replacement[kind])) ||
      (state.backup && !matches(state.backup, manifest.original[kind])) ||
      (state.temporary && !matches(state.temporary, manifest.replacement[kind]))
    )
      throw new Error(`Vacuum recovery found an unrecognized ${kind} generation. Files were retained.`);
    result[kind] = state;
  }
  return result;
}

async function cleanup(paths: VacuumPaths, checkpoint?: VacuumCheckpoint): Promise<void> {
  // The selected canonical pair has reopened successfully before any deletion.
  for (const filepath of [paths.backupData, paths.backupLog, paths.tempData, paths.tempLog]) {
    await remove(filepath);
    await checkpoint?.('cleanup');
  }
  await remove(paths.nextManifest);
  await remove(paths.manifest); // Always last, so partial cleanup remains recoverable.
}

/** Call only after the installed replacement has successfully reopened. */
export async function finishVacuumReplacement(
  paths: VacuumPaths,
  manifest: VacuumManifest,
  checkpoint?: VacuumCheckpoint,
): Promise<void> {
  const state = await inspect(paths, manifest);
  for (const kind of ['data', 'log'] as const) {
    if (!matches(state[kind].canonical, manifest.replacement[kind]))
      throw new Error('Installed vacuum pair changed before verification.');
  }
  await publishManifest(paths, { ...manifest, phase: 'verified' });
  await checkpoint?.('beforecleanup');
  await cleanup(paths, checkpoint);
}

/** Before verification, restore the fingerprinted original pair. After the
 * verified decision, retain the replacement. Never choose a file by filename
 * alone, and validate the complete selected pair before the first mutation. */
export async function recoverVacuumReplacement(
  filepath: string,
  verify: () => Promise<void>,
  checkpoint?: VacuumCheckpoint,
): Promise<boolean> {
  const initial = vacuumPaths(filepath);
  if (!(await exists(initial.manifest))) {
    if (!(await exists(initial.nextManifest))) {
      await assertNoVacuumArtifacts(filepath);
      return false;
    }
    const staged = parseManifest(await fs.readFile(initial.nextManifest, 'utf8'));
    if (staged.phase !== 'prepared') throw new Error('Vacuum recovery has no published phase. Files were retained.');
    const stagedPaths = vacuumPaths(filepath, staged.id);
    const stagedState = await inspect(stagedPaths, staged);
    for (const kind of ['data', 'log'] as const) {
      if (!matches(stagedState[kind].canonical, staged.original[kind])) {
        throw new Error('Vacuum preparation was not published and the original pair changed. Files were retained.');
      }
    }
    await rename(initial.nextManifest, initial.manifest);
  }
  const manifest = parseManifest(await fs.readFile(initial.manifest, 'utf8'));
  const paths = vacuumPaths(filepath, manifest.id);
  // Parse stale staging evidence before it can be removed. It must belong to
  // this operation; a partial phase write is safely ignored only because the
  // published manifest is intact and defines the recovery decision.
  if (await exists(paths.nextManifest)) {
    let staged: VacuumManifest | undefined;
    try {
      staged = parseManifest(await fs.readFile(paths.nextManifest, 'utf8'));
    } catch {
      /* Published phase wins. */
    }
    if (staged && JSON.stringify({ ...staged, phase: manifest.phase }) !== JSON.stringify(manifest)) {
      throw new Error('Vacuum manifests disagree. Files were retained.');
    }
  }
  const state = await inspect(paths, manifest);
  for (const kind of ['data', 'log'] as const) {
    const selected = manifest.phase === 'prepared' ? manifest.original[kind] : manifest.replacement[kind];
    if (
      !matches(state[kind].canonical, selected) &&
      !(manifest.phase === 'prepared' && matches(state[kind].backup, selected))
    ) {
      throw new Error(
        `Vacuum recovery cannot locate the complete ${manifest.phase === 'prepared' ? 'original' : 'replacement'} pair. Files were retained.`,
      );
    }
  }
  if (manifest.phase === 'prepared') {
    for (const kind of ['data', 'log'] as const) {
      if (matches(state[kind].canonical, manifest.original[kind])) continue;
      const canonical = paths[kind];
      const temporary = kind === 'data' ? paths.tempData : paths.tempLog;
      const backup = kind === 'data' ? paths.backupData : paths.backupLog;
      if (state[kind].canonical) {
        if (state[kind].temporary) await remove(canonical);
        else await rename(canonical, temporary);
      }
      await rename(backup, canonical);
      await checkpoint?.('recovery');
    }
  }
  await verify();
  // Verification must be read-only. Refuse cleanup if opening or an external
  // writer changed either selected file while recovery was in progress.
  const verified = await inspect(paths, manifest);
  for (const kind of ['data', 'log'] as const) {
    const selected = manifest.phase === 'prepared' ? manifest.original[kind] : manifest.replacement[kind];
    if (!matches(verified[kind].canonical, selected)) {
      throw new Error('Vacuum verification changed the selected generation. Recovery files were retained.');
    }
  }
  await cleanup(paths, checkpoint);
  return true;
}
