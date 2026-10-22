import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimpleDbms, type HnswConfig } from '../src/database/simpledbms.mjs';
import { RealFile } from '../src/storage/file.mjs';
import { getClipHnswConfig } from '../src/webclient/server/embedding-config.mjs';
import { DatabaseCatalog } from '../src/webclient/server/database-catalog.mjs';
import { discoverDemoAssets, type DemoAssetOptions } from '../src/webclient/server/demo-assets.mjs';
import { generateShowcaseCollections, type ShowcaseCounts } from '../src/webclient/server/demo-showcase-data.mjs';
import {
  seedComprehensiveDemo,
  DEMO_MAX_BYTES,
  demoEmbeddingConfig,
  type DemoSeedOptions,
} from '../src/webclient/server/demo-seeder.mjs';

export type PersistentShowcaseOptions = {
  assetRoot?: string;
  assets?: DemoAssetOptions;
  counts?: Partial<ShowcaseCounts>;
  hnswConfig?: HnswConfig;
  onProgress?: DemoSeedOptions['onProgress'];
};

/** The standalone output remains persistent; it never enters temporary-demo ownership tracking. */
export async function createPersistentShowcase(
  filepath: string,
  options: PersistentShowcaseOptions = {},
): Promise<{ counts: Record<string, number>; bytes: number; skipped: Record<string, number>; durationMs: number }> {
  filepath = path.resolve(filepath);
  const outputFiles = [filepath, `${filepath}.log`, `${filepath}.model.json`];
  for (const file of outputFiles) {
    try {
      await fs.access(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`File already exists: ${file}. Choose a different filename.`);
  }
  const started = performance.now();
  const assets = await discoverDemoAssets(options.assetRoot ?? path.resolve(import.meta.dirname, '..'), options.assets);
  for (const [name, wanted] of [
    ['photos', options.assets?.photos ?? 450],
    ['gallery', options.assets?.gallery ?? 150],
    ['memes', options.assets?.memes ?? 240],
  ] as const)
    if (wanted > 0 && !assets[name].length)
      throw new Error(`No usable ${name} assets were found for the comprehensive demo.`);
  if (assets.estimatedBytes >= DEMO_MAX_BYTES) throw new Error('Demo assets exceed the conservative storage budget.');
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  const disk = await fs.statfs(path.dirname(filepath));
  if (disk.bavail * disk.bsize < assets.estimatedBytes * 2)
    throw new Error('Insufficient free disk space for database construction.');
  const reserved: string[] = [];
  const dataFile = new RealFile(filepath);
  const logFile = new RealFile(`${filepath}.log`);
  let database: SimpleDbms | undefined;
  let complete = false;
  try {
    // Exclusive reservations protect against a file appearing during asset inspection.
    for (const file of outputFiles.slice(0, 2)) {
      const handle = await fs.open(file, 'wx');
      reserved.push(file);
      await handle.close();
    }
    const models = demoEmbeddingConfig(options.hnswConfig ?? getClipHnswConfig());
    database = await SimpleDbms.create(dataFile, logFile, models.config);
    const footprint = async (): Promise<number> => {
      let bytes = 0;
      for (const file of outputFiles) {
        try {
          bytes += (await fs.stat(file)).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      return bytes;
    };
    const result = await seedComprehensiveDemo(
      database,
      generateShowcaseCollections(options.counts),
      assets,
      filepath,
      {
        signal: new AbortController().signal,
        footprint,
        checkEmbeddings: models.checkEmbeddings,
        onProgress: options.onProgress ?? (() => undefined),
      },
    );
    complete = true;
    return { ...result, skipped: assets.skipped, durationMs: performance.now() - started };
  } finally {
    try {
      if (database) await database.close();
    } finally {
      // Verification reopens with new handles; these originals can already be closed.
      await Promise.allSettled([dataFile.close(), logFile.close()]);
      if (!complete) for (const file of reserved) await fs.rm(file, { force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filepath = await new DatabaseCatalog().unused(process.argv[2] ?? 'webclient-test');
  let lastCollection: string | null = null;
  console.log('Inspecting local Flickr8k photographs, captions and meme templates...');
  const result = await createPersistentShowcase(filepath, {
    onProgress: (progress) => {
      if (progress.collection && progress.collection !== lastCollection) {
        console.log(progress.stage);
        lastCollection = progress.collection;
      }
    },
  });
  for (const [name, count] of Object.entries(result.counts)) console.log(`${name}: ${count}`);
  console.log(`Verified persistent database: ${filepath}`);
  console.log(`Final footprint: ${result.bytes.toLocaleString()} bytes; ${result.durationMs.toFixed(0)} ms.`);
  for (const [reason, count] of Object.entries(result.skipped)) console.log(`Skipped ${reason}: ${count}`);
}
