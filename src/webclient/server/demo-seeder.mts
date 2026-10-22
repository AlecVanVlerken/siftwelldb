import * as fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { SimpleDbms, type HnswConfig } from '../../database/simpledbms.mjs';
import { RealFile } from '../../storage/file.mjs';
import type { FieldValue } from '../../database/document.mjs';
import type { DemoAssetSelection, DemoImageAsset } from './demo-assets.mjs';
import type { ShowcaseCollection } from './demo-showcase-data.mjs';
import type { DemoStatus } from './temporary-demo.mjs';

export const DEMO_MAX_BYTES = 1_000_000_000;

/** Ordinary image ingestion permits unusable images; a complete demo requires every selected image's encoder. */
export function demoEmbeddingConfig(original: HnswConfig): { config: HnswConfig; checkEmbeddings: () => void } {
  let failure: Error | undefined;
  const wrap =
    (encoder: (bytes: Buffer) => Promise<Float32Array>, dimension: number) =>
    async (bytes: Buffer): Promise<Float32Array> => {
      try {
        const vector = await encoder(bytes);
        if (!(vector instanceof Float32Array) || vector.length !== dimension || !vector.every(Number.isFinite))
          throw new Error('Required image model returned an invalid embedding.');
        return vector;
      } catch (error) {
        failure = error instanceof Error ? error : new Error(`Required image encoder failed: ${String(error)}`);
        throw error;
      }
    };
  return {
    config: {
      ...original,
      ...(original.imageEmbeddingFn ? { imageEmbeddingFn: wrap(original.imageEmbeddingFn, original.dimension) } : {}),
      ...(original.imageIndex
        ? {
            imageIndex: {
              ...original.imageIndex,
              imageEmbeddingFn: wrap(original.imageIndex.imageEmbeddingFn, original.imageIndex.dimension),
            },
          }
        : {}),
    },
    checkEmbeddings: () => {
      if (failure !== undefined) throw failure;
    },
  };
}

export type DemoSeedOptions = {
  signal: AbortSignal;
  onProgress: (progress: Partial<DemoStatus>) => void;
  maxBytes?: number;
  batchSize?: number;
  footprint: () => Promise<number>;
  checkEmbeddings?: () => void;
};

export async function seedComprehensiveDemo(
  database: SimpleDbms,
  collections: ShowcaseCollection[],
  assets: DemoAssetSelection,
  filepath: string,
  options: DemoSeedOptions,
): Promise<{ counts: Record<string, number>; bytes: number }> {
  const maxBytes = options.maxBytes ?? DEMO_MAX_BYTES;
  const batchSize = options.batchSize ?? 25;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new Error('Demo commit batch size must be between 1 and 100.');
  const counts: Record<string, number> = {};
  const imageGroups = ['photos', 'gallery', 'memes'] as const;
  const total =
    collections.reduce((sum, collection) => sum + collection.documents.length, 0) +
    imageGroups.reduce((sum, name) => sum + assets[name].length, 0);
  options.onProgress({ total });
  let completed = 0;
  let pending = 0;

  async function commitBatch(): Promise<void> {
    options.signal.throwIfAborted();
    const staged = await database.getCompactionStorageStats();
    // Include dirty allocations before committing, with room for the metadata flush.
    if (staged.fileSizeBytes + 64 * 1024 > maxBytes)
      throw new Error(`Demo exceeded its ${Math.round(maxBytes / 1_000_000)} MB storage budget; creation stopped.`);
    await database.commit();
    const bytes = await options.footprint();
    if (bytes >= maxBytes) throw new Error('Temporary demo exceeded its storage budget.');
    options.onProgress({ bytes });
    pending = 0;
  }

  async function insert(name: string, document: Record<string, FieldValue>): Promise<void> {
    options.signal.throwIfAborted();
    await database.insertDocumentObject(name, document);
    options.checkEmbeddings?.();
    options.signal.throwIfAborted();
    counts[name] = (counts[name] ?? 0) + 1;
    completed++;
    pending++;
    options.onProgress({ completed, counts: { ...counts } });
    if (pending >= batchSize) await commitBatch();
  }

  for (const collection of collections) {
    options.signal.throwIfAborted();
    options.onProgress({ collection: collection.name, stage: `Writing ${collection.name} and text indexes` });
    for (const field of collection.unindexedFields) await database.setFieldIndexed(collection.name, field, false);
    if (collection.compressionDefaults)
      database.setFieldCompressionDefaults(collection.name, collection.compressionDefaults);
    for (const document of collection.documents) await insert(collection.name, document);
    await commitBatch();
  }

  for (const name of imageGroups) {
    options.onProgress({ collection: name, stage: `Importing ${name} and image indexes` });
    if (name === 'photos') {
      for (const field of ['description', 'captions']) await database.setFieldIndexed(name, field, false);
      database.setFieldCompressionDefaults(name, { captions: 'gzip' });
    }
    for (const [index, asset] of assets[name].entries()) {
      options.signal.throwIfAborted();
      const image = await fs.readFile(asset.path);
      if (image.length !== asset.bytes) throw new Error(`Source image changed during demo creation: ${asset.filename}`);
      const document: Record<string, FieldValue> = {
        id: `${name === 'photos' ? 'photo' : name === 'gallery' ? 'gallery' : 'meme'}${String(index + 1).padStart(4, '0')}`,
      };
      if (name === 'photos') {
        document['title'] = Array.from(asset.captions[0]).slice(0, 150).join('');
        document['description'] = asset.captions[0];
        document['captions'] = asset.captions.join('\n');
        document['category'] = asset.category;
        document['filename'] = asset.filename;
      } else if (name === 'memes') {
        // Filenames describe the supplied templates; they are not OCR transcriptions.
        document['title'] = asset.filename.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
        document['filename'] = asset.filename;
      }
      document['image'] = image;
      document['_image_mime'] = asset.mime;
      document['width'] = asset.width;
      document['height'] = asset.height;
      await insert(name, document);
    }
    if (assets[name].length) await commitBatch();
  }
  if (pending) await commitBatch();

  options.onProgress({ stage: 'Verifying persisted documents and indexes', collection: null });
  // Reopen with the original model providers to verify persisted state, not just caches.
  await database.reopen(new RealFile(filepath), new RealFile(`${filepath}.log`));
  options.signal.throwIfAborted();
  for (const [name, expected] of Object.entries(counts)) {
    let actual = 0;
    for await (const document of database.cursor(name, 'id')) {
      void document;
      actual++;
    }
    if (actual !== expected)
      throw new Error(`Demo verification failed for ${name}: ${actual} of ${expected} documents.`);
  }
  for (const collection of collections) {
    if (!collection.documents.length) continue;
    const first = collection.documents[0];
    const stored = await database.getDocumentObjectById(collection.name, first['id'] as string);
    if (!isDeepStrictEqual(stored, first))
      throw new Error(`Demo document did not survive reopening: ${collection.name}`);
    const settings = database.getFieldIndexConfig(collection.name);
    for (const field of collection.unindexedFields)
      if (settings[field] !== false) throw new Error(`Demo index configuration missing: ${collection.name}.${field}`);
    if (collection.compressionDefaults) {
      const encoded = JSON.parse(
        await database.getDocumentById(collection.name, first['id'] as string, { encoded: true }),
      ) as Record<string, { compression?: string }>;
      for (const [field, codec] of Object.entries(collection.compressionDefaults))
        if (first[field] !== undefined && encoded[field]?.compression !== codec)
          throw new Error(`Demo compression did not persist: ${collection.name}.${field}`);
    }
  }
  for (const name of imageGroups) {
    const asset: DemoImageAsset | undefined = assets[name][0];
    if (!asset) continue;
    const prefix = name === 'photos' ? 'photo' : name === 'gallery' ? 'gallery' : 'meme';
    const stored = await database.getDocumentObjectById(name, `${prefix}0001`);
    const expected = await fs.readFile(asset.path);
    if (!Buffer.isBuffer(stored['image']) || !stored['image'].equals(expected))
      throw new Error(`Demo binary image did not survive reopening: ${name}`);
    if (name === 'photos' && stored['captions'] !== asset.captions.join('\n'))
      throw new Error('Flickr8k descriptions lost their image association.');
    if (name === 'gallery' && ['title', 'description', 'captions', 'category'].some((field) => field in stored))
      throw new Error('Image-only gallery unexpectedly contains descriptions.');
    if (!(await database.semanticImageSearch(name, expected, 3)).length)
      throw new Error(`Demo image semantic index is unavailable: ${name}`);
  }
  for (const collection of collections) {
    const first = collection.documents[0];
    if (!first) continue;
    const query = String(first['summary'] ?? first['title'] ?? first['name'] ?? first['category'] ?? 'document');
    if (!(await database.semanticSearch(collection.name, query, 3)).length)
      throw new Error(`Demo text semantic index is unavailable: ${collection.name}`);
  }
  options.signal.throwIfAborted();
  const bytes = await options.footprint();
  if (bytes >= maxBytes || bytes >= 2_000_000_000) throw new Error('Finished demo exceeded its storage budget.');
  return { counts, bytes };
}
