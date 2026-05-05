import type { CompressionAlgorithm } from './compression.mjs';

export type CompressionProfileKind = 'text' | 'image' | 'binary';

export type CompressionBenchmarkMetrics = {
  compressionPercent: number;
  compressMsPerMB: number;
  decompressMsPerMB: number;
};

export type CompressionProfile = {
  id: string;
  kind: CompressionProfileKind;
  displayName: string;
  description: string;
  algorithms: Record<CompressionAlgorithm, CompressionBenchmarkMetrics>;
};

export type CompressionProfileSummary = Pick<CompressionProfile, 'id' | 'kind' | 'displayName' | 'description'>;

// Metrics measured on this branch with the compression benchmark workload shapes.
// Compression percentages use RecordStore semantics: compressed bytes are only counted
// when they are smaller than the original payload.
export const COMPRESSION_PROFILES: CompressionProfile[] = [
  {
    id: 'text.short-text',
    kind: 'text',
    displayName: 'Short text',
    description: 'Average field size up to 256 bytes.',
    algorithms: {
      none: { compressionPercent: 0, compressMsPerMB: 0, decompressMsPerMB: 0 },
      gzip: { compressionPercent: 52.12, compressMsPerMB: 183.41, decompressMsPerMB: 72.61 },
      deflate: { compressionPercent: 56.81, compressMsPerMB: 158.97, decompressMsPerMB: 74.87 },
      brotli: { compressionPercent: 60.58, compressMsPerMB: 270.09, decompressMsPerMB: 90.64 },
      'zstd-fast': { compressionPercent: 55.98, compressMsPerMB: 147.53, decompressMsPerMB: 80.89 },
      zstd: { compressionPercent: 55.98, compressMsPerMB: 153.01, decompressMsPerMB: 63.24 },
    },
  },
  {
    id: 'text.medium-text',
    kind: 'text',
    displayName: 'Medium text',
    description: 'Average field size between 257 bytes and 2 KB.',
    algorithms: {
      none: { compressionPercent: 0, compressMsPerMB: 0, decompressMsPerMB: 0 },
      gzip: { compressionPercent: 81.14, compressMsPerMB: 22.01, decompressMsPerMB: 7.13 },
      deflate: { compressionPercent: 81.72, compressMsPerMB: 23.58, decompressMsPerMB: 6.4 },
      brotli: { compressionPercent: 83.08, compressMsPerMB: 32.27, decompressMsPerMB: 8.77 },
      'zstd-fast': { compressionPercent: 82.3, compressMsPerMB: 15.17, decompressMsPerMB: 6.98 },
      zstd: { compressionPercent: 82.29, compressMsPerMB: 22.78, decompressMsPerMB: 6.68 },
    },
  },
  {
    id: 'text.long-text',
    kind: 'text',
    displayName: 'Long text',
    description: 'Average field size above 2 KB.',
    algorithms: {
      none: { compressionPercent: 0, compressMsPerMB: 0, decompressMsPerMB: 0 },
      gzip: { compressionPercent: 84.08, compressMsPerMB: 13.05, decompressMsPerMB: 3.37 },
      deflate: { compressionPercent: 84.22, compressMsPerMB: 15.6, decompressMsPerMB: 3.38 },
      brotli: { compressionPercent: 86.26, compressMsPerMB: 14.85, decompressMsPerMB: 3.81 },
      'zstd-fast': { compressionPercent: 85.76, compressMsPerMB: 5.9, decompressMsPerMB: 2.48 },
      zstd: { compressionPercent: 85.78, compressMsPerMB: 11.99, decompressMsPerMB: 3.3 },
    },
  },
  {
    id: 'image.jpeg-photo',
    kind: 'image',
    displayName: 'JPEG photo',
    description: 'Already-compressed photographic images stored as JPEG.',
    algorithms: {
      none: { compressionPercent: 0, compressMsPerMB: 0, decompressMsPerMB: 0 },
      gzip: { compressionPercent: 0, compressMsPerMB: 23.2, decompressMsPerMB: 0.05 },
      deflate: { compressionPercent: 0, compressMsPerMB: 22.17, decompressMsPerMB: 0.05 },
      brotli: { compressionPercent: 0, compressMsPerMB: 25.13, decompressMsPerMB: 0.05 },
      'zstd-fast': { compressionPercent: 0, compressMsPerMB: 4.5, decompressMsPerMB: 0.05 },
      zstd: { compressionPercent: 0, compressMsPerMB: 9.53, decompressMsPerMB: 0.05 },
    },
  },
  {
    id: 'image.png-graphic',
    kind: 'image',
    displayName: 'PNG graphic',
    description: 'Graphics or diagrams stored as PNG.',
    algorithms: {
      none: { compressionPercent: 0, compressMsPerMB: 0, decompressMsPerMB: 0 },
      gzip: { compressionPercent: 99.06, compressMsPerMB: 6.8, decompressMsPerMB: 2.63 },
      deflate: { compressionPercent: 99.21, compressMsPerMB: 6.43, decompressMsPerMB: 1.85 },
      brotli: { compressionPercent: 99.6, compressMsPerMB: 7.69, decompressMsPerMB: 4.31 },
      'zstd-fast': { compressionPercent: 99.54, compressMsPerMB: 5.65, decompressMsPerMB: 1.66 },
      zstd: { compressionPercent: 99.54, compressMsPerMB: 3.29, decompressMsPerMB: 1.5 },
    },
  },
  {
    id: 'image.webp-image',
    kind: 'image',
    displayName: 'WebP image',
    description: 'WebP images that are usually already compressed.',
    algorithms: {
      none: { compressionPercent: 0, compressMsPerMB: 0, decompressMsPerMB: 0 },
      gzip: { compressionPercent: 0, compressMsPerMB: 22.38, decompressMsPerMB: 0.05 },
      deflate: { compressionPercent: 0, compressMsPerMB: 22.7, decompressMsPerMB: 0.02 },
      brotli: { compressionPercent: 0, compressMsPerMB: 45.55, decompressMsPerMB: 0.02 },
      'zstd-fast': { compressionPercent: 0, compressMsPerMB: 3.97, decompressMsPerMB: 0.02 },
      zstd: { compressionPercent: 0, compressMsPerMB: 11.84, decompressMsPerMB: 0.02 },
    },
  },
  {
    id: 'binary.generic-binary',
    kind: 'binary',
    displayName: 'Generic binary',
    description: 'Binary values without a more specific profile.',
    algorithms: {
      none: { compressionPercent: 0, compressMsPerMB: 0, decompressMsPerMB: 0 },
      gzip: { compressionPercent: 0, compressMsPerMB: 35.48, decompressMsPerMB: 0.18 },
      deflate: { compressionPercent: 0, compressMsPerMB: 37.22, decompressMsPerMB: 0.04 },
      brotli: { compressionPercent: 0, compressMsPerMB: 42.58, decompressMsPerMB: 0.02 },
      'zstd-fast': { compressionPercent: 0, compressMsPerMB: 7.12, decompressMsPerMB: 0.03 },
      zstd: { compressionPercent: 0, compressMsPerMB: 15.55, decompressMsPerMB: 0.02 },
    },
  },
];

export function listCompressionProfileSummaries(): CompressionProfileSummary[] {
  return COMPRESSION_PROFILES.map(({ id, kind, displayName, description }) => ({
    id,
    kind,
    displayName,
    description,
  }));
}

export function getCompressionProfile(profileId: string): CompressionProfile | undefined {
  return COMPRESSION_PROFILES.find((profile) => profile.id === profileId);
}
