import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type ImageSource = {
  file: string;
  identicalCopies?: string[];
  author: string;
  authorUrl: string;
  sourceUrl: string;
  downloadUrl: string;
  license: string;
  licenseUrl: string;
  bytes: number;
  sha256: string;
};

const imageDirectory = new URL('../assets/images/', import.meta.url);
const sources = JSON.parse(readFileSync(new URL('sources.json', imageDirectory), 'utf8')) as { images: ImageSource[] };

describe('bundled image provenance', () => {
  it('records every bundled image and the rabbit compatibility copy', () => {
    const imageFiles = readdirSync(imageDirectory).filter((name) => /\.(jpe?g|png|webp)$/i.test(name));
    expect(sources.images.map((source) => source.file).sort()).toEqual(imageFiles.sort());
    expect(sources.images.find((source) => source.file === 'rabbit.jpg')?.identicalCopies).toContain('../rabbit.jpg');
  });

  it('identifies licensed source photographs and matches the exact distributed bytes', () => {
    for (const source of sources.images) {
      expect(source.author.length).toBeGreaterThan(0);
      expect(source.authorUrl).toMatch(/^https:\/\/wordpress\.org\/photos\/author\//);
      expect(source.sourceUrl).toMatch(/^https:\/\/wordpress\.org\/photos\/photo\//);
      expect(source.downloadUrl).toMatch(/^https:\/\/pd\.w\.org\//);
      expect(source.license).toBe('CC0-1.0');
      expect(source.licenseUrl).toBe('https://creativecommons.org/publicdomain/zero/1.0/');

      for (const filename of [source.file, ...(source.identicalCopies ?? [])]) {
        const location = new URL(filename, imageDirectory);
        const bytes = readFileSync(location);
        expect(bytes.length, fileURLToPath(location)).toBe(source.bytes);
        expect(createHash('sha256').update(bytes).digest('hex'), fileURLToPath(location)).toBe(source.sha256);
        expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
        expect(bytes.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
      }
    }
  });
});
