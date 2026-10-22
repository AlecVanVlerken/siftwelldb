import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { RawImage } from '@huggingface/transformers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverDemoAssets, parseFlickrCaptions } from '../demo-assets.mjs';

describe('Flickr8k caption parsing', () => {
  it('associates all descriptions by exact filename and caption number', () => {
    const text = [
      'dog.jpg#4\tA fifth view of the dog.',
      'dog.jpg#0\t  A dog running.  ',
      'other.jpg#0\tA bicycle rider.',
      'dog.jpg#2\tA dog outside.',
      'dog.jpg#1\tA brown dog.',
      'dog.jpg#3\tA dog on grass.',
      'dog.jpg#0\tA conflicting duplicated caption.',
      'bad caption without a tab',
      '../dog.jpg#0\tA path is not a filename.',
      '',
    ].join('\r\n');
    const parsed = parseFlickrCaptions(text);
    expect(parsed.captions.get('dog.jpg')).toEqual([
      'A dog running.',
      'A brown dog.',
      'A dog outside.',
      'A dog on grass.',
      'A fifth view of the dog.',
    ]);
    expect(parsed.captions.get('other.jpg')).toEqual(['A bicycle rider.']);
    expect(parsed.invalidLines).toBe(2);
  });
});

describe('local demo asset discovery', () => {
  let root: string;
  let imageDirectory: string;
  let memeDirectory: string;

  it('stops cancelled discovery before reading source files', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Demo cancelled'));
    await expect(discoverDemoAssets(root, {}, controller.signal)).rejects.toThrow('Demo cancelled');
  });

  async function image(directory: string, filename: string, color: number): Promise<string> {
    await fs.mkdir(directory, { recursive: true });
    const filepath = path.join(directory, filename);
    const pixels = new Uint8Array(3 * 2 * 3).fill(color);
    await new RawImage(pixels, 3, 2, 3).save(filepath);
    return filepath;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'siftwell-demo-assets-test-'));
    imageDirectory = path.join(root, 'Flickr8k downloaded images', 'Flicker8k_Dataset');
    memeDirectory = path.join(root, 'Memes downloaded - arbitrary timestamp', 'templates');
    const captionsDirectory = path.join(root, 'Flickr8k text metadata');
    await fs.mkdir(captionsDirectory);
    const captions: string[] = [];
    for (const [index, filename, caption] of [
      [1, 'dog.png', 'A dog playing on grass.'],
      [2, 'sports.jpg', 'Children playing football.'],
      [3, 'vehicle.webp', 'A person riding a bicycle.'],
      [4, 'nature.png', 'A beautiful mountain lake.'],
      [5, 'people.png', 'A child wearing a colorful dress.'],
    ] as const) {
      await image(imageDirectory, filename, index * 30);
      for (let number = 0; number < 5; number++)
        captions.push(`${filename}#${number}\t${caption} Description ${number + 1}.`);
    }
    await fs.writeFile(path.join(captionsDirectory, 'Flickr8k.token.txt'), captions.join('\n'));
    await image(memeDirectory, 'Readable template name.jpg', 180);
    await image(memeDirectory, 'Another_template.png', 210);
  });

  afterEach(async () => {
    const absolute = path.resolve(root);
    if (
      !absolute.startsWith(path.resolve(tmpdir()) + path.sep) ||
      !path.basename(absolute).startsWith('siftwell-demo-assets-test-')
    )
      throw new Error('Unexpected fixture cleanup path');
    await fs.rm(absolute, { recursive: true, force: true });
  });

  it('discovers nested sources, reads MIME/dimensions, and deterministically balances distinct photographs', async () => {
    const original = await fs.readFile(path.join(imageDirectory, 'dog.png'));
    const options = { photos: 4, gallery: 1, memes: 2 };
    const first = await discoverDemoAssets(root, options);
    const second = await discoverDemoAssets(root, options);
    expect(second).toEqual(first);
    expect(first.photos).toHaveLength(4);
    expect(new Set(first.photos.map((asset) => asset.category)).size).toBe(4);
    expect(first.gallery).toHaveLength(1);
    expect(first.memes).toHaveLength(2);
    expect(new Set([...first.photos, ...first.gallery].map((asset) => asset.path)).size).toBe(5);
    expect(first.photos.every((asset) => asset.captions.length === 5 && asset.width === 3 && asset.height === 2)).toBe(
      true,
    );
    expect(first.inventory.formats).toEqual({ 'image/png': 4, 'image/jpeg': 2, 'image/webp': 1 });
    expect(first.inventory.captionImages).toBe(5);
    expect(first.inventory.captionLines).toBe(25);
    expect(first.discovery.captionFiles[0]).toContain('Flickr8k.token.txt');
    expect(first.selectedSourceBytes).toBe(
      [...first.photos, ...first.gallery, ...first.memes].reduce((sum, asset) => sum + asset.bytes, 0),
    );
    expect(first.estimatedBytes).toBeGreaterThan(first.selectedSourceBytes);
    expect(await fs.readFile(path.join(imageDirectory, 'dog.png'))).toEqual(original);
  });

  it('ignores archive sidecars, deduplicates bytes/names, and reports missing mappings and unsupported assets', async () => {
    const archive = path.join(imageDirectory, '__MACOSX');
    await fs.mkdir(archive);
    await fs.writeFile(path.join(archive, 'ghost.jpg'), 'archive metadata');
    await fs.writeFile(path.join(imageDirectory, '._ghost.jpg'), 'archive metadata');
    await fs.writeFile(path.join(memeDirectory, 'unsupported.gif'), 'GIF89a');
    await fs.writeFile(path.join(memeDirectory, 'broken.jpg'), 'not an image');
    await fs.copyFile(path.join(memeDirectory, 'Another_template.png'), path.join(memeDirectory, 'Duplicate.png'));
    await image(path.join(imageDirectory, 'duplicate'), 'dog.png', 11);
    await image(imageDirectory, 'uncaptioned.png', 12);
    const captionFile = path.join(root, 'Flickr8k text metadata', 'Flickr8k.token.txt');
    await fs.appendFile(captionFile, '\nmissing.jpg#0\tAn image absent from the download.');
    const result = await discoverDemoAssets(root, { photos: 8, gallery: 2, memes: 5 });
    expect(result.skipped).toMatchObject({
      archiveMetadata: 2,
      duplicateContent: 1,
      duplicateFilename: 2,
      unsupportedFormat: 1,
      invalidImage: 1,
      missingCaptions: 1,
      missingCaptionImage: 2,
    });
    expect(result.photos).toHaveLength(4);
    expect(result.photos.some((asset) => asset.filename === 'dog.png')).toBe(false);
    expect(result.photos.every((asset) => asset.captions.length > 0)).toBe(true);
    expect(result.gallery.map((asset) => asset.filename)).toEqual(['uncaptioned.png']);
    expect(result.memes).toHaveLength(2);
  });

  it('rejects truncated selected image data through the actual image decoder', async () => {
    const truncated = (await fs.readFile(path.join(memeDirectory, 'Another_template.png'))).subarray(0, 33);
    await fs.writeFile(path.join(memeDirectory, 'Truncated.png'), truncated);
    const result = await discoverDemoAssets(root, { photos: 0, gallery: 0, memes: 5 });
    expect(result.skipped['invalidImage']).toBe(1);
    expect(result.memes).toHaveLength(2);
  });

  it('enforces compressed source size limits and aggregate budgets', async () => {
    const result = await discoverDemoAssets(root, { photos: 4, gallery: 1, memes: 2, sourceBudgetBytes: 300 });
    expect(result.selectedSourceBytes).toBeLessThanOrEqual(300);
    expect(result.skipped['selectionBudget']).toBeGreaterThan(0);
    const excluded = await discoverDemoAssets(root, { photos: 4, gallery: 1, memes: 2, imageMaxBytes: 1 });
    expect(excluded.selectedSourceBytes).toBe(0);
    expect(excluded.skipped['fileSize']).toBe(7);
    const exactBudget =
      (await fs.stat(path.join(imageDirectory, 'dog.png'))).size +
      (await fs.stat(path.join(memeDirectory, 'Readable template name.jpg'))).size +
      (await fs.stat(path.join(memeDirectory, 'Another_template.png'))).size;
    const reused = await discoverDemoAssets(root, { photos: 1, gallery: 0, memes: 2, sourceBudgetBytes: exactBudget });
    expect(reused.photos).toHaveLength(1);
    expect(reused.memes).toHaveLength(2);
    expect(reused.selectedSourceBytes).toBe(exactBudget);
  });

  it('reports missing source folders and caption metadata clearly', async () => {
    await fs.rename(
      path.join(root, 'Flickr8k text metadata', 'Flickr8k.token.txt'),
      path.join(root, 'captions-backup.txt'),
    );
    await expect(discoverDemoAssets(root)).rejects.toThrow('Photo captions were not found');
    await expect(discoverDemoAssets(path.join(root, 'Flickr8k text metadata'))).rejects.toThrow(
      'Demo photographs were not found',
    );
    await fs.rename(path.join(root, 'Memes downloaded - arbitrary timestamp'), path.join(root, 'other-assets'));
    await expect(discoverDemoAssets(root, { photos: 0, gallery: 0 })).rejects.toThrow('Meme images were not found');
  });

  it('prefers curated photo, gallery and meme folders and loads only the retained JSON captions', async () => {
    const curated = path.join(root, 'examples/assets/images');
    const photos = path.join(curated, 'photos');
    const gallery = path.join(curated, 'gallery');
    const memes = path.join(curated, 'memes');
    await image(photos, 'dog.png', 25);
    await image(photos, 'lake.png', 50);
    await image(gallery, 'bicycle.png', 75);
    await image(memes, 'Template.png', 100);
    await fs.writeFile(
      path.join(photos, 'captions.json'),
      JSON.stringify({ 'dog.png': ['A dog running.', 'A dog in grass.'], 'lake.png': ['A mountain lake.'] }),
    );
    const result = await discoverDemoAssets(root, { photos: 2, gallery: 1, memes: 1 });
    expect(result.photos.map((asset) => asset.filename).sort()).toEqual(['dog.png', 'lake.png']);
    expect(result.photos.find((asset) => asset.filename === 'dog.png')?.captions).toEqual([
      'A dog running.',
      'A dog in grass.',
    ]);
    expect(result.gallery.map((asset) => asset.filename)).toEqual(['bicycle.png']);
    expect(result.gallery[0].captions).toEqual([]);
    expect(result.memes.map((asset) => asset.filename)).toEqual(['Template.png']);
    expect(result.inventory.captionImages).toBe(2);
    expect(result.inventory.captionLines).toBe(3);
    expect(result.discovery.captionFiles).toEqual([path.join(photos, 'captions.json')]);
    expect(await discoverDemoAssets(root, { photos: 2, gallery: 1, memes: 1 })).toEqual(result);
  });

  it('rejects malformed curated captions instead of falling back to unrelated dataset metadata', async () => {
    const curated = path.join(root, 'examples/assets/images');
    for (const group of ['photos', 'gallery', 'memes']) await fs.mkdir(path.join(curated, group), { recursive: true });
    await image(path.join(curated, 'photos'), 'dog.png', 25);
    const metadata = path.join(curated, 'photos', 'captions.json');
    for (const invalid of [null, ['caption'], { '../dog.png': ['A dog.'] }, { 'dog.png': [false] }]) {
      await fs.writeFile(metadata, JSON.stringify(invalid));
      await expect(discoverDemoAssets(root, { photos: 1, gallery: 0, memes: 0 })).rejects.toThrow(/captions/i);
    }
  });

  it('rejects invalid numeric settings without reading sources', async () => {
    await expect(discoverDemoAssets(root, { photos: -1 })).rejects.toThrow('Invalid demo asset setting: photos');
    await expect(discoverDemoAssets(root, { sourceBudgetBytes: Infinity })).rejects.toThrow(
      'Invalid demo asset setting: sourceBudgetBytes',
    );
  });
});
