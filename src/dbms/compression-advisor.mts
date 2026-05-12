import { isImageField } from './document.mjs';
import { COMPRESSION_ALGORITHMS, CompressionRegistry, type CompressionAlgorithm } from './compression.mjs';
import {
  getCompressionProfile,
  listCompressionProfileSummaries,
  type CompressionProfile,
  type CompressionProfileKind,
  type CompressionProfileSummary,
} from './compression-benchmarks.mjs';

export type CompressionSample = {
  raw: Buffer;
  kind: CompressionProfileKind;
};

export type CompressionRecommendationRequest = {
  collection: string;
  field: string;
  workload?: number;
  profileOverride?: string;
  sampleSize?: number;
  draftValue?: string;
};

export type CompressionRecommendationWeights = {
  storage: number;
  decompressSpeed: number;
  compressSpeed: number;
};

export type CompressionStorageEstimate = {
  samples: number;
  rawSerializedBytes: number;
  compressedSerializedBytes: number;
  rawBlocks: number;
  compressedBlocks: number;
  blocksSaved: number;
  allocatedBytesSaved: number;
  readAmplification: number;
  writeCost: number;
};

export type CompressionRecommendationItem = {
  algorithm: CompressionAlgorithm;
  score: number;
  rationale: string;
  benchmark: {
    compressionPercent: number;
    compressMsPerMB: number;
    decompressMsPerMB: number;
  };
  observedCompressionPercent: number | null;
  effectiveCompressionPercent: number;
  beneficialSampleShare: number | null;
  estimatedStoredBytes: number | null;
  storageEstimate: CompressionStorageEstimate | null;
};

export type CompressionRecommendation = {
  recommended: CompressionAlgorithm;
  summary: string;
  detectedProfile: CompressionProfileSummary;
  activeProfile: CompressionProfileSummary;
  availableProfiles: CompressionProfileSummary[];
  workload: number;
  weights: CompressionRecommendationWeights;
  analysis: {
    collection: string;
    field: string;
    detectedKind: CompressionProfileKind;
    documentsScanned: number;
    fieldPresenceRate: number;
    avgBytes: number | null;
    draftValueUsed: boolean;
    blockSize: number | null;
    dataBytesPerBlock: number | null;
    storageSamples: number;
  };
  ranking: CompressionRecommendationItem[];
};

export type CompressionRecommendationContext = {
  request: CompressionRecommendationRequest;
  samples: CompressionSample[];
  documentsScanned: number;
  fieldPresenceCount: number;
  draftValueUsed: boolean;
  storageEstimates?: Partial<Record<CompressionAlgorithm, CompressionStorageEstimate>>;
  blockSize?: number;
  dataBytesPerBlock?: number;
};

type AlgorithmObservation = {
  observedCompressionPercent: number | null;
  effectiveCompressionPercent: number;
  beneficialSampleShare: number | null;
  estimatedStoredBytes: number | null;
  storageEstimate: CompressionStorageEstimate | null;
};

const ALGORITHMS = COMPRESSION_ALGORITHMS;
const registry = new CompressionRegistry();
const OBSERVED_COMPRESSION_WEIGHT = 0.6;
const BENCHMARK_COMPRESSION_WEIGHT = 0.4;
const BLOCK_STORAGE_SCORE_WEIGHT = 0.7;
const PAYLOAD_STORAGE_SCORE_WEIGHT = 0.3;
const NO_BLOCK_SAVINGS_PAYLOAD_WEIGHT = 0.4;
const NO_BLOCK_SAVINGS_ALGORITHM_PENALTY = 0.85;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function normalizeHigherIsBetter(value: number, min: number, max: number): number {
  if (max === min) return 1;
  return (value - min) / (max - min);
}

function normalizeLowerIsBetter(value: number, min: number, max: number): number {
  if (max === min) return 1;
  return (max - value) / (max - min);
}

function normalizePositiveHigherIsBetter(value: number, min: number, max: number): number {
  if (max === min) return max > 0 ? 1 : 0;
  return normalizeHigherIsBetter(value, min, max);
}

function workloadLabel(workload: number): string {
  if (workload <= 0.33) return 'cold';
  if (workload >= 0.66) return 'hot';
  return 'balanced';
}

function compressionWeights(workload: number): CompressionRecommendationWeights {
  const hotness = clamp(workload, 0, 1);
  return {
    storage: 0.65 - hotness * 0.45,
    decompressSpeed: 0.25 + hotness * 0.3,
    compressSpeed: 0.1 + hotness * 0.15,
  };
}

function profileFromImageField(field: string): string {
  const lower = field.toLowerCase();
  if (lower.endsWith('.png')) return 'image.png-graphic';
  if (lower.endsWith('.webp')) return 'image.webp-image';
  return 'image.jpeg-photo';
}

function detectKind(field: string, samples: CompressionSample[]): CompressionProfileKind {
  if (isImageField(field)) return 'image';
  if (samples.some((sample) => sample.kind === 'image')) return 'image';
  if (samples.some((sample) => sample.kind === 'binary')) return 'binary';
  return 'text';
}

function detectProfile(field: string, samples: CompressionSample[]): CompressionProfile {
  const kind = detectKind(field, samples);

  if (kind === 'image') {
    return getCompressionProfile(profileFromImageField(field)) ?? getCompressionProfile('image.jpeg-photo')!;
  }

  if (kind === 'binary') {
    return getCompressionProfile('binary.generic-binary')!;
  }

  const avgBytes = average(samples.filter((sample) => sample.kind === 'text').map((sample) => sample.raw.length)) ?? 0;
  if (avgBytes <= 256) return getCompressionProfile('text.short-text')!;
  if (avgBytes <= 2048) return getCompressionProfile('text.medium-text')!;
  return getCompressionProfile('text.long-text')!;
}

function summarizeProfile(profile: CompressionProfile): CompressionProfileSummary {
  const { id, kind, displayName, description } = profile;
  return { id, kind, displayName, description };
}

function measureAlgorithm(
  algorithm: CompressionAlgorithm,
  profile: CompressionProfile,
  samples: CompressionSample[],
): AlgorithmObservation {
  const benchmark = profile.algorithms[algorithm];

  if (algorithm === 'none') {
    const avgBytes = average(samples.map((sample) => sample.raw.length));
    return {
      observedCompressionPercent: samples.length > 0 ? 0 : null,
      effectiveCompressionPercent: benchmark.compressionPercent,
      beneficialSampleShare: samples.length > 0 ? 1 : null,
      estimatedStoredBytes: avgBytes,
      storageEstimate: null,
    };
  }

  if (samples.length === 0) {
    return {
      observedCompressionPercent: null,
      effectiveCompressionPercent: benchmark.compressionPercent,
      beneficialSampleShare: null,
      estimatedStoredBytes: null,
      storageEstimate: null,
    };
  }

  let rawBytesTotal = 0;
  let storedBytesTotal = 0;
  let beneficialCount = 0;

  for (const sample of samples) {
    const rawBytes = sample.raw.length;
    rawBytesTotal += rawBytes;
    const compressed = registry.get(algorithm).compress(sample.raw);
    const storedBytes = compressed.length < rawBytes ? compressed.length : rawBytes;
    storedBytesTotal += storedBytes;
    if (compressed.length < rawBytes) beneficialCount++;
  }

  const observedCompressionPercent =
    rawBytesTotal === 0 ? 0 : ((rawBytesTotal - storedBytesTotal) / rawBytesTotal) * 100;
  const effectiveCompressionPercent =
    observedCompressionPercent * OBSERVED_COMPRESSION_WEIGHT +
    benchmark.compressionPercent * BENCHMARK_COMPRESSION_WEIGHT;

  return {
    observedCompressionPercent,
    effectiveCompressionPercent,
    beneficialSampleShare: beneficialCount / samples.length,
    estimatedStoredBytes: storedBytesTotal / samples.length,
    storageEstimate: null,
  };
}

function sampleRationale(
  item: CompressionRecommendationItem,
  recommended: CompressionAlgorithm,
  workload: number,
  detectedProfile: CompressionProfileSummary,
  activeProfile: CompressionProfileSummary,
): string {
  const parts: string[] = [];
  if (item.algorithm === recommended) {
    parts.push('Best overall fit for this field.');
  }

  const mode = workloadLabel(workload);
  if (mode === 'cold') {
    parts.push('This workload prioritizes storage efficiency.');
  } else if (mode === 'hot') {
    parts.push('This workload prioritizes fast reads and writes.');
  } else {
    parts.push('This workload balances storage and latency.');
  }

  parts.push(
    `Benchmark: ${item.benchmark.compressionPercent.toFixed(0)}% compression, ${item.benchmark.compressMsPerMB.toFixed(1)} ms/MB compress, ${item.benchmark.decompressMsPerMB.toFixed(1)} ms/MB decompress.`,
  );

  if (item.observedCompressionPercent !== null) {
    parts.push(`Observed on sampled values: ${item.observedCompressionPercent.toFixed(0)}% effective compression.`);
  }

  if (item.beneficialSampleShare !== null && item.algorithm !== 'none') {
    parts.push(`Compression helped on ${(item.beneficialSampleShare * 100).toFixed(0)}% of sampled values.`);
  }

  if (item.storageEstimate) {
    const estimate = item.storageEstimate;
    parts.push(
      `Block estimate: ${estimate.compressedBlocks} block(s) instead of ${estimate.rawBlocks}, saving ${estimate.blocksSaved} block(s) and ${estimate.allocatedBytesSaved} allocated bytes in the scanned sample.`,
    );
  }

  if (detectedProfile.id !== activeProfile.id) {
    parts.push(
      `Using override profile ${activeProfile.displayName} instead of detected ${detectedProfile.displayName}.`,
    );
  }

  return parts.join(' ');
}

export function compressionSampleFromValue(field: string, value: unknown): CompressionSample | null {
  if (Buffer.isBuffer(value)) {
    return {
      raw: value,
      kind: isImageField(field) ? 'image' : 'binary',
    };
  }

  if (typeof value === 'string') {
    if (isImageField(field)) {
      try {
        return {
          raw: Buffer.from(value, 'base64'),
          kind: 'image',
        };
      } catch {
        return null;
      }
    }
    return {
      raw: Buffer.from(value, 'utf-8'),
      kind: 'text',
    };
  }

  return null;
}

function storageScoreFromSignals(
  compressionScore: number,
  blockScore: number | null,
  hasAnyBlockSavings: boolean,
): number {
  if (blockScore === null) return compressionScore;
  if (!hasAnyBlockSavings) return compressionScore * NO_BLOCK_SAVINGS_PAYLOAD_WEIGHT;
  return blockScore * BLOCK_STORAGE_SCORE_WEIGHT + compressionScore * PAYLOAD_STORAGE_SCORE_WEIGHT;
}

export function listAvailableCompressionProfiles(): CompressionProfileSummary[] {
  return listCompressionProfileSummaries();
}

export function recommendCompression(context: CompressionRecommendationContext): CompressionRecommendation {
  const workload = clamp(context.request.workload ?? 0.5, 0, 1);
  const detectedProfile = detectProfile(context.request.field, context.samples);
  const activeProfile = getCompressionProfile(context.request.profileOverride ?? '') ?? detectedProfile;
  const weights = compressionWeights(workload);
  const availableProfiles = listAvailableCompressionProfiles();
  const observations = new Map<CompressionAlgorithm, AlgorithmObservation>();

  for (const algorithm of ALGORITHMS) {
    const observation = measureAlgorithm(algorithm, activeProfile, context.samples);
    const storageEstimate = context.storageEstimates?.[algorithm] ?? null;
    if (storageEstimate) {
      observation.storageEstimate = {
        ...storageEstimate,
        writeCost:
          activeProfile.algorithms[algorithm].compressMsPerMB * (storageEstimate.rawSerializedBytes / 1_048_576),
      };
    }
    observations.set(algorithm, observation);
  }

  const effectiveValues = ALGORITHMS.map((algorithm) => observations.get(algorithm)!.effectiveCompressionPercent);
  const encodeValues = ALGORITHMS.map((algorithm) => activeProfile.algorithms[algorithm].compressMsPerMB);
  const decodeValues = ALGORITHMS.map((algorithm) => activeProfile.algorithms[algorithm].decompressMsPerMB);
  const blockSavingsValues = ALGORITHMS.map(
    (algorithm) => observations.get(algorithm)!.storageEstimate?.blocksSaved ?? 0,
  );

  const compressionMin = Math.min(...effectiveValues);
  const compressionMax = Math.max(...effectiveValues);
  const encodeMin = Math.min(...encodeValues);
  const encodeMax = Math.max(...encodeValues);
  const decodeMin = Math.min(...decodeValues);
  const decodeMax = Math.max(...decodeValues);
  const blockSavingsMin = Math.min(...blockSavingsValues);
  const blockSavingsMax = Math.max(...blockSavingsValues);

  const ranking = ALGORITHMS.map((algorithm) => {
    const benchmark = activeProfile.algorithms[algorithm];
    const observation = observations.get(algorithm)!;
    const compressionScore = normalizeHigherIsBetter(
      observation.effectiveCompressionPercent,
      compressionMin,
      compressionMax,
    );
    const blockScore = observation.storageEstimate
      ? normalizePositiveHigherIsBetter(observation.storageEstimate.blocksSaved, blockSavingsMin, blockSavingsMax)
      : null;
    const storageScore = storageScoreFromSignals(compressionScore, blockScore, blockSavingsMax > 0);
    const encodeScore = normalizeLowerIsBetter(benchmark.compressMsPerMB, encodeMin, encodeMax);
    const decodeScore = normalizeLowerIsBetter(benchmark.decompressMsPerMB, decodeMin, decodeMax);

    let score =
      storageScore * weights.storage + decodeScore * weights.decompressSpeed + encodeScore * weights.compressSpeed;

    if (algorithm !== 'none' && observation.beneficialSampleShare !== null) {
      score *= 0.5 + observation.beneficialSampleShare * 0.5;
    }
    if (algorithm !== 'none' && observation.storageEstimate && observation.storageEstimate.blocksSaved <= 0) {
      score *= NO_BLOCK_SAVINGS_ALGORITHM_PENALTY;
    }

    return {
      algorithm,
      score,
      rationale: '',
      benchmark,
      observedCompressionPercent: observation.observedCompressionPercent,
      effectiveCompressionPercent: observation.effectiveCompressionPercent,
      beneficialSampleShare: observation.beneficialSampleShare,
      estimatedStoredBytes: observation.estimatedStoredBytes,
      storageEstimate: observation.storageEstimate,
    } satisfies CompressionRecommendationItem;
  }).sort((left, right) => right.score - left.score);

  const recommended = ranking[0]?.algorithm ?? 'none';
  for (const item of ranking) {
    item.rationale = sampleRationale(
      item,
      recommended,
      workload,
      summarizeProfile(detectedProfile),
      summarizeProfile(activeProfile),
    );
  }

  const summary =
    recommended === 'none'
      ? `Recommend no compression for ${context.request.collection}.${context.request.field} because the hotness/latency tradeoff outweighs storage savings.`
      : `Recommend ${recommended} for ${context.request.collection}.${context.request.field} using the ${activeProfile.displayName.toLowerCase()} profile.`;

  return {
    recommended,
    summary,
    detectedProfile: summarizeProfile(detectedProfile),
    activeProfile: summarizeProfile(activeProfile),
    availableProfiles,
    workload,
    weights,
    analysis: {
      collection: context.request.collection,
      field: context.request.field,
      detectedKind: detectedProfile.kind,
      documentsScanned: context.documentsScanned,
      fieldPresenceRate: context.documentsScanned === 0 ? 0 : context.fieldPresenceCount / context.documentsScanned,
      avgBytes: average(context.samples.map((sample) => sample.raw.length)),
      draftValueUsed: context.draftValueUsed,
      blockSize: context.blockSize ?? null,
      dataBytesPerBlock: context.dataBytesPerBlock ?? null,
      storageSamples: context.storageEstimates?.none?.samples ?? 0,
    },
    ranking,
  };
}
