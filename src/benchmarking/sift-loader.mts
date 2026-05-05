// SIFT-1M dataset loader (Texmex .fvecs / .ivecs format)
//
// Download the dataset (~160 MB compressed):
//   cd src/benchmarking/datasets
//   curl -O ftp://ftp.irisa.fr/local/texmex/corpus/sift.tar.gz
//   tar xzf sift.tar.gz
//   rm sift.tar.gz
//
// This creates:
//   datasets/sift/sift_base.fvecs         1 M × 128D base vectors (~512 MB)
//   datasets/sift/sift_query.fvecs        10 K × 128D query vectors
//   datasets/sift/sift_groundtruth.ivecs  10 K × 100 nearest neighbors
//   datasets/sift/sift_learn.fvecs        100 K × 128D (not needed)

import { readFileSync } from 'fs';

/**
 * Load vectors from a .fvecs file (Texmex binary format).
 * Each record: [dim:int32_LE] [v0:float32_LE … v_{dim-1}:float32_LE]
 *
 * Returns a flat row-major Float32Array so the caller can slice by index:
 *   vector i = data.subarray(i * dim, (i + 1) * dim)
 */
export function loadFvecs(filePath: string): { dim: number; count: number; data: Float32Array } {
  const buf = readFileSync(filePath);
  const dim = buf.readInt32LE(0);
  const recordBytes = 4 + dim * 4;
  const count = Math.floor(buf.byteLength / recordBytes);
  const data = new Float32Array(count * dim);

  for (let i = 0; i < count; i++) {
    const offset = i * recordBytes + 4;
    for (let j = 0; j < dim; j++) {
      data[i * dim + j] = buf.readFloatLE(offset + j * 4);
    }
  }

  return { dim, count, data };
}

/**
 * Load integer vectors from a .ivecs file (Texmex binary format).
 * Each record: [k:int32_LE] [id0:int32_LE … id_{k-1}:int32_LE]
 *
 * For ground-truth files: row q contains the k nearest neighbor indices
 * for query q, sorted by ascending distance.
 */
export function loadIvecs(filePath: string): { k: number; count: number; data: Int32Array } {
  const buf = readFileSync(filePath);
  const k = buf.readInt32LE(0);
  const recordBytes = 4 + k * 4;
  const count = Math.floor(buf.byteLength / recordBytes);
  const data = new Int32Array(count * k);

  for (let i = 0; i < count; i++) {
    const offset = i * recordBytes + 4;
    for (let j = 0; j < k; j++) {
      data[i * k + j] = buf.readInt32LE(offset + j * 4);
    }
  }

  return { k, count, data };
}
