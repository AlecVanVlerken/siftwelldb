# Compression Advisor

The compression advisor is a recommendation layer on top of the existing field-compression support.

It combines three inputs:

- benchmark profile data from `src/dbms/compression-benchmarks.mts`
- automatic field analysis from stored documents and the current draft value
- user intent from a continuous cold-to-hot workload slider

## Benchmark Catalog

The benchmark catalog lives in `src/dbms/compression-benchmarks.mts`.

Each profile represents a reusable data shape, not a specific business field. Current profiles include:

- `text.short-text`
- `text.medium-text`
- `text.long-text`
- `image.jpeg-photo`
- `image.png-graphic`
- `image.webp-image`
- `binary.generic-binary`

Each profile stores measured values:

- `compressionPercent`
- `compressMsPerMB`
- `decompressMsPerMB`

The text `gzip` percentages were checked against `npm run benchmark:compression` at 256 B, 2 KB, and 8 KB
field sizes. The catalog also includes direct codec measurements for `deflate`, `brotli`, `zstd-fast`,
`zstd`, image-like payloads, and generic binary payloads so every advisor profile has complete data.

Current algorithms:

- `none`
- `gzip`
- `deflate`
- `brotli`
- `zstd-fast`
- `zstd`

`zstd-fast` uses a low Zstandard level for hot-ish data where write latency matters. `brotli` is included as
a cold-storage candidate because it can win on ratio for text-like values, but it is usually slower.

## Profile Detection

The advisor detects profiles automatically:

- text fields up to 256 bytes use `text.short-text`
- text fields from 257 bytes to 2048 bytes use `text.medium-text`
- text fields above 2048 bytes use `text.long-text`
- image fields are inferred from `.jpeg`, `.jpg`, `.png`, and `.webp`
- binary values fall back to `binary.generic-binary`

The UI exposes a profile dropdown with automatic detection as the default. A profile is sent as
`profileOverride` only after the user explicitly selects one, so inferred frontend guesses do not override the
backend's sample-based detection.

## Slider Semantics

The workload slider maps from `0` to `1`.

- `0`: cold data, favor storage savings
- `0.5`: balanced workload
- `1`: hot data, favor low read/write latency

Internal weights move linearly:

- storage: `0.65` to `0.20`
- decompress speed: `0.25` to `0.55`
- compress speed: `0.10` to `0.25`

Moving right lowers the importance of compression ratio and raises the importance of latency.

## Block-Aware Estimates

The advisor does not only look at compressed payload bytes. While scanning sample documents, `DbmsBack`
asks `RecordStore` to estimate the real serialized record size for every candidate algorithm. If no stored
document is available yet, the current draft value is wrapped in a synthetic draft document so the UI can
still show an estimated block impact.

Each ranking item includes:

- `rawSerializedBytes`
- `compressedSerializedBytes`
- `rawBlocks`
- `compressedBlocks`
- `blocksSaved`
- `allocatedBytesSaved`
- `readAmplification`
- `writeCost`

The key storage signal is:

```ts
blocksSaved = rawBlocks - compressedBlocks;
```

This matters because `FreeBlockFile` allocates fixed-size blocks. A payload can shrink substantially while
still occupying the same number of physical blocks, so the advisor treats block savings as a stronger storage
signal than raw compression percentage.

## Library API

The DBMS library exposes:

- `SimpleDbms.listCompressionProfiles()`
- `SimpleDbms.recommendCompression(request)`

Request shape:

```ts
{
  collection: string;
  field: string;
  workload?: number;
  profileOverride?: string;
  sampleSize?: number;
  draftValue?: string;
}
```

Response shape:

```ts
{
  recommended: 'none' | 'gzip' | 'deflate' | 'brotli' | 'zstd-fast' | 'zstd';
  summary: string;
  detectedProfile: { id, kind, displayName, description };
  activeProfile: { id, kind, displayName, description };
  availableProfiles: CompressionProfileSummary[];
  workload: number;
  weights: { storage, decompressSpeed, compressSpeed };
  analysis: {
    collection: string;
    field: string;
    detectedKind: 'text' | 'image' | 'binary';
    documentsScanned: number;
    fieldPresenceRate: number;
    avgBytes: number | null;
    draftValueUsed: boolean;
    blockSize: number | null;
    dataBytesPerBlock: number | null;
    storageSamples: number;
  };
  ranking: Array<{
    algorithm: 'none' | 'gzip' | 'deflate' | 'brotli' | 'zstd-fast' | 'zstd';
    score: number;
    rationale: string;
    storageEstimate: {
      rawSerializedBytes: number;
      compressedSerializedBytes: number;
      rawBlocks: number;
      compressedBlocks: number;
      blocksSaved: number;
      allocatedBytesSaved: number;
      readAmplification: number;
      writeCost: number;
    } | null;
  }>;
}
```

## Daemon API

Endpoints:

- `GET /api/compression/profiles`
- `POST /api/compression/recommendation`

The recommendation endpoint returns the same structured recommendation object used by the frontend.

## Frontend Workflow

In the document editor, editable fields show:

- compression select
- automatic profile dropdown, with manual override when selected
- cold/hot slider
- `Adviseer`
- `Gebruik advies`
- `Leg uit waarom`

The explanation panel shows the ranking for all algorithms, including benchmark numbers and the rationale
for each choice.
