import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface DemoImageAsset {
  path: string;
  filename: string;
  bytes: number;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
  captions: string[];
  category: string;
}

export interface DemoAssetOptions {
  photos?: number;
  gallery?: number;
  memes?: number;
  imageMaxBytes?: number;
  sourceBudgetBytes?: number;
}

export interface DemoAssetSelection {
  photos: DemoImageAsset[];
  gallery: DemoImageAsset[];
  memes: DemoImageAsset[];
  selectedSourceBytes: number;
  estimatedBytes: number;
  discovery: { flickrDirectories: string[]; captionFiles: string[]; memeDirectories: string[] };
  inventory: {
    photos: number;
    memes: number;
    captionImages: number;
    captionLines: number;
    sourceBytes: number;
    formats: Record<string, number>;
    minWidth: number;
    maxWidth: number;
    minHeight: number;
    maxHeight: number;
  };
  skipped: Record<string, number>;
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const OTHER_IMAGE_EXTENSIONS = new Set(['.gif', '.bmp', '.tif', '.tiff', '.svg', '.avif']);
const MAX_PIXELS = 32_000_000;

function increment(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

/** Flickr8k's raw token format is filename#caption-number<TAB>description. */
export function parseFlickrCaptions(text: string): { captions: Map<string, string[]>; invalidLines: number } {
  const indexed = new Map<string, Map<number, string>>();
  let invalidLines = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^([^\t/\\]+)#(\d+)\t(.+)$/u.exec(line);
    if (!match || !match[3].trim()) {
      invalidLines++;
      continue;
    }
    const filename = match[1];
    const index = Number(match[2]);
    if (!Number.isSafeInteger(index)) {
      invalidLines++;
      continue;
    }
    const entries = indexed.get(filename) ?? new Map<number, string>();
    // Repeated metadata must not overwrite a caption with an unrelated variant.
    if (!entries.has(index)) entries.set(index, match[3].trim());
    indexed.set(filename, entries);
  }
  return {
    captions: new Map(
      [...indexed].map(([filename, entries]) => [
        filename,
        [...entries].sort(([a], [b]) => a - b).map(([, caption]) => caption),
      ]),
    ),
    invalidLines,
  };
}

/** Caption-derived browsing labels, rather than additional claims about image content. */
function captionCategory(captions: string[]): string {
  const text = captions.join(' ').toLowerCase();
  const categories: [string, RegExp][] = [
    ['Animals', /\b(dogs?|puppy|puppies|cats?|horses?|birds?|ducks?|elephants?|cows?|sheep)\b/u],
    ['Sports', /\b(football|soccer|basketball|baseball|tennis|hockey|skateboard\w*|surf\w*|ski\w*|snowboard\w*)\b/u],
    ['Vehicles', /\b(bikes?|bicycles?|motorcycles?|cars?|trucks?|trains?|boats?|buses?|airplanes?)\b/u],
    ['Outdoor activities', /\b(hik\w*|climb\w*|camp\w*|swim\w*|running|jogging|fishing)\b/u],
    ['Urban scenes', /\b(street|sidewalk|buildings?|city|market|shops?|traffic)\b/u],
    ['Nature', /\b(mountains?|forest|trees?|beach|ocean|river|lake|snow|flowers?|grass|waterfall)\b/u],
    ['People', /\b(people|persons?|men|man|women|woman|boys?|girls?|children|child|baby|babies)\b/u],
  ];
  return categories.find(([, pattern]) => pattern.test(text))?.[0] ?? 'Everyday scenes';
}

async function discoverFiles(directory: string, skipped: Record<string, number>, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  const files: string[] = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    if (entry.name === '__MACOSX' || entry.name.startsWith('._')) {
      increment(skipped, 'archiveMetadata');
      continue;
    }
    // Do not follow directory symlinks out of the supplied dataset roots.
    if (entry.isDirectory()) files.push(...(await discoverFiles(path.join(directory, entry.name), skipped, depth + 1)));
    else if (entry.isFile()) files.push(path.join(directory, entry.name));
  }
  return files;
}

function imageHeader(data: Buffer): Pick<DemoImageAsset, 'mime' | 'width' | 'height'> | null {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    if (data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { mime: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 0xff) return null;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) return null;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) return null;
        return { mime: 'image/jpeg', width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    if (data.readUInt32LE(4) + 8 > data.length) return null;
    const format = data.toString('ascii', 12, 16);
    if (format === 'VP8X')
      return { mime: 'image/webp', width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    if (format === 'VP8 ' && data.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a])))
      return { mime: 'image/webp', width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (format === 'VP8L' && data[20] === 0x2f) {
      const packed = data.readUInt32LE(21);
      return { mime: 'image/webp', width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

function orderedByCategory(assets: DemoImageAsset[]): DemoImageAsset[] {
  const buckets = new Map<string, DemoImageAsset[]>();
  const rank = (asset: DemoImageAsset): string =>
    createHash('sha256').update(`siftwell-demo-42:${asset.filename}`).digest('hex');
  for (const asset of [...assets].sort((a, b) => rank(a).localeCompare(rank(b)))) {
    const bucket = buckets.get(asset.category) ?? [];
    bucket.push(asset);
    buckets.set(asset.category, bucket);
  }
  const ordered: DemoImageAsset[] = [];
  const categories = [...buckets.keys()].sort();
  for (let index = 0; ordered.length < assets.length; index++) {
    for (const category of categories) {
      const asset = buckets.get(category)?.[index];
      if (asset) ordered.push(asset);
    }
  }
  return ordered;
}

/** Only local files are inspected; original assets are never modified or copied. */
export async function discoverDemoAssets(
  root: string,
  options: DemoAssetOptions = {},
  signal?: AbortSignal,
): Promise<DemoAssetSelection> {
  signal?.throwIfAborted();
  const counts = { photos: options.photos ?? 450, gallery: options.gallery ?? 150, memes: options.memes ?? 240 };
  const imageMaxBytes = options.imageMaxBytes ?? 8 * 1024 * 1024;
  const sourceBudgetBytes = options.sourceBudgetBytes ?? 256 * 1024 * 1024;
  for (const [name, value] of Object.entries({ ...counts, imageMaxBytes, sourceBudgetBytes })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid demo asset setting: ${name}`);
  }
  const skipped: Record<string, number> = {};
  const rootPath = path.resolve(root);
  const curatedRoot = path.join(rootPath, 'examples/assets/images');
  const curated = await fs
    .stat(path.join(curatedRoot, 'photos'))
    .then((info) => info.isDirectory())
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
  const directories = (await fs.readdir(rootPath, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const flickrDirectories = curated
    ? [path.join(curatedRoot, 'photos')]
    : directories
        .filter((entry) => /flick(?:r|er)[\s_-]*8k/iu.test(entry.name))
        .map((entry) => path.join(rootPath, entry.name))
        .sort();
  const memeDirectories = curated
    ? [path.join(curatedRoot, 'memes')]
    : directories
        .filter((entry) => /memes?/iu.test(entry.name))
        .map((entry) => path.join(rootPath, entry.name))
        .sort();
  const flickrFiles: string[] = [];
  for (const directory of flickrDirectories) flickrFiles.push(...(await discoverFiles(directory, skipped)));
  const galleryFiles = curated ? await discoverFiles(path.join(curatedRoot, 'gallery'), skipped) : [];
  const memeFiles: string[] = [];
  for (const directory of memeDirectories) memeFiles.push(...(await discoverFiles(directory, skipped)));
  const captionFiles = flickrFiles.filter((file) =>
    (curated ? /^captions\.json$/iu : /^flickr8k\.token\.txt$/iu).test(path.basename(file)),
  );
  if (
    (counts.photos || counts.gallery) &&
    ![...flickrFiles, ...galleryFiles].some((file) => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()))
  )
    throw new Error('Demo photographs were not found. Supply images under examples/assets/images/photos and gallery.');
  if (counts.photos && !captionFiles.length)
    throw new Error('Photo captions were not found. Supply photos/captions.json or the raw Flickr8k.token.txt file.');
  if (counts.memes && !memeDirectories.length)
    throw new Error('Meme images were not found. Supply images under examples/assets/images/memes.');

  const captions = new Map<string, string[]>();
  for (const file of captionFiles) {
    const text = await fs.readFile(file, 'utf8');
    let parsed: ReturnType<typeof parseFlickrCaptions>;
    if (curated) {
      const metadata: unknown = JSON.parse(text);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        throw new Error('Photo captions.json must map image filenames to nonempty arrays of descriptions.');
      const entries = new Map<string, string[]>();
      for (const [filename, descriptions] of Object.entries(metadata)) {
        if (
          /[/\\]/u.test(filename) ||
          !Array.isArray(descriptions) ||
          !descriptions.length ||
          !descriptions.every((value: unknown) => typeof value === 'string' && value.trim().length > 0)
        )
          throw new Error(`Invalid photo captions for ${filename}.`);
        entries.set(
          filename,
          (descriptions as string[]).map((value) => value.trim()),
        );
      }
      parsed = { captions: entries, invalidLines: 0 };
    } else parsed = parseFlickrCaptions(text);
    skipped['invalidCaptionLines'] = (skipped['invalidCaptionLines'] ?? 0) + parsed.invalidLines;
    for (const [filename, values] of parsed.captions) if (!captions.has(filename)) captions.set(filename, values);
  }
  const inventory: DemoAssetSelection['inventory'] = {
    photos: 0,
    memes: 0,
    captionImages: captions.size,
    captionLines: [...captions.values()].reduce((sum, values) => sum + values.length, 0),
    sourceBytes: 0,
    formats: {},
    minWidth: Infinity,
    maxWidth: 0,
    minHeight: Infinity,
    maxHeight: 0,
  };
  const hashes = new Set<string>();
  const filenames = new Set<string>();
  const ambiguousFilenames = new Set<string>();
  const available: Record<'photos' | 'gallery' | 'memes', DemoImageAsset[]> = { photos: [], gallery: [], memes: [] };
  for (const [kind, files] of [
    ['photos', flickrFiles],
    ['gallery', galleryFiles],
    ['memes', memeFiles],
  ] as const) {
    for (const file of files) {
      signal?.throwIfAborted();
      const extension = path.extname(file).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension)) {
        if (OTHER_IMAGE_EXTENSIONS.has(extension)) increment(skipped, 'unsupportedFormat');
        continue;
      }
      const stat = await fs.stat(file);
      if (!stat.size || stat.size > imageMaxBytes) {
        increment(skipped, 'fileSize');
        continue;
      }
      // One bounded compressed image at a time, not an in-memory copy of the dataset.
      const data = await fs.readFile(file);
      const header = imageHeader(data);
      if (!header || !header.width || !header.height || header.width * header.height > MAX_PIXELS) {
        increment(skipped, 'invalidImage');
        continue;
      }
      const hash = createHash('sha256').update(data).digest('hex');
      if (hashes.has(hash)) {
        increment(skipped, 'duplicateContent');
        continue;
      }
      const filename = path.basename(file);
      if (kind === 'photos' && (filenames.has(filename) || ambiguousFilenames.has(filename))) {
        const previous = available.photos.findIndex((asset) => asset.filename === filename);
        // Distinct images sharing a name have an ambiguous caption association; omit both.
        if (previous >= 0) {
          available.photos.splice(previous, 1);
          filenames.delete(filename);
          increment(skipped, 'duplicateFilename');
        }
        ambiguousFilenames.add(filename);
        increment(skipped, 'duplicateFilename');
        continue;
      }
      hashes.add(hash);
      if (kind === 'photos') filenames.add(filename);
      const descriptions = kind === 'photos' ? (captions.get(filename) ?? []) : [];
      if (kind === 'photos' && !descriptions.length) increment(skipped, 'missingCaptions');
      available[kind].push({
        path: file,
        filename,
        bytes: stat.size,
        ...header,
        captions: descriptions,
        category: kind === 'photos' ? captionCategory(descriptions) : kind === 'memes' ? 'Meme templates' : 'Gallery',
      });
    }
  }
  inventory.photos = available.photos.length + available.gallery.length;
  inventory.memes = available.memes.length;
  for (const asset of [...available.photos, ...available.gallery, ...available.memes]) {
    inventory.sourceBytes += asset.bytes;
    increment(inventory.formats, asset.mime);
    inventory.minWidth = Math.min(inventory.minWidth, asset.width);
    inventory.maxWidth = Math.max(inventory.maxWidth, asset.width);
    inventory.minHeight = Math.min(inventory.minHeight, asset.height);
    inventory.maxHeight = Math.max(inventory.maxHeight, asset.height);
  }
  for (const filename of captions.keys()) if (!filenames.has(filename)) increment(skipped, 'missingCaptionImage');
  if (!Number.isFinite(inventory.minWidth)) inventory.minWidth = inventory.minHeight = 0;

  const selected: Pick<DemoAssetSelection, 'photos' | 'gallery' | 'memes'> = { photos: [], gallery: [], memes: [] };
  let remainingCount = counts.photos + counts.gallery + counts.memes;
  let remainingBudget = sourceBudgetBytes;
  const selectedPaths = new Set<string>();
  let selectedSourceBytes = 0;
  const { RawImage } = await import('@huggingface/transformers');
  for (const kind of ['photos', 'gallery', 'memes'] as const) {
    const pool =
      kind === 'memes'
        ? available.memes
        : kind === 'gallery' && curated
          ? available.gallery
          : available.photos.filter((asset) => kind === 'gallery' || asset.captions.length > 0);
    const budget = remainingCount ? Math.floor((remainingBudget * counts[kind]) / remainingCount) : 0;
    let usedBytes = 0;
    for (const asset of orderedByCategory(pool)) {
      signal?.throwIfAborted();
      if (selected[kind].length >= counts[kind]) break;
      if (selectedPaths.has(asset.path)) continue;
      if (usedBytes + asset.bytes > budget) {
        increment(skipped, 'selectionBudget');
        continue;
      }
      try {
        // Use the existing CLIP decoder to reject corrupt selected images before database creation.
        const image = await RawImage.fromBlob(
          new Blob([new Uint8Array(await fs.readFile(asset.path))], { type: asset.mime }),
        );
        if (image.width !== asset.width || image.height !== asset.height)
          throw new Error('Image dimensions differ from header');
      } catch {
        increment(skipped, 'invalidImage');
        continue;
      }
      selected[kind].push(asset);
      selectedPaths.add(asset.path);
      usedBytes += asset.bytes;
      selectedSourceBytes += asset.bytes;
    }
    remainingBudget -= usedBytes;
    remainingCount -= counts[kind];
  }
  return {
    ...selected,
    selectedSourceBytes,
    // Conservative preflight only; the seeder also enforces the actual on-disk footprint.
    estimatedBytes: selectedSourceBytes * 3 + selectedPaths.size * 64 * 1024 + 64 * 1024 * 1024,
    discovery: { flickrDirectories, captionFiles, memeDirectories },
    inventory,
    skipped,
  };
}
