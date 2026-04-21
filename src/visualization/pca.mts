export type Point2D = { x: number; y: number };

/**
 * Reduces a list of high-dimensional vectors down to 2D using PCA.
 *
 * Algorithm:
 *   1. Center the data (subtract the mean vector).
 *   2. Find PC1: the direction of maximum variance, via power iteration.
 *   3. Find PC2: the direction of second-most variance, orthogonal to PC1.
 *   4. Project every point onto (PC1, PC2) to get (x, y).
 *
 * Result: documents with similar content land close together on the map.
 */
export function reduceTo2D(vectors: number[][]): Point2D[] {
  if (vectors.length === 0) return [];
  if (vectors.length === 1) return [{ x: 0, y: 0 }];

  const N = vectors.length;
  const D = vectors[0].length;

  // Step 1: center the data by subtracting the mean of each dimension
  const mean = new Array<number>(D).fill(0);
  for (const v of vectors) {
    for (let j = 0; j < D; j++) mean[j] += v[j] / N;
  }
  const centered = vectors.map((v) => v.map((x, j) => x - mean[j]));

  /**
   * Power iteration: find the dominant eigenvector of the covariance matrix.
   * If `exclude` is provided, deflate that direction first (gives orthogonal component).
   */
  function findPC(data: number[][], exclude?: number[]): number[] {
    // Start with a random unit vector
    let vec = Array.from({ length: D }, () => Math.random() - 0.5);

    if (exclude) {
      const dot = vec.reduce((s, v, i) => s + v * exclude[i], 0);
      vec = vec.map((v, i) => v - dot * exclude[i]);
    }

    let norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm < 1e-10) return new Array<number>(D).fill(0);
    vec = vec.map((v) => v / norm);

    for (let iter = 0; iter < 200; iter++) {
      // Multiply by covariance matrix: C·v = (1/N) · Xᵀ·(X·v)
      const Xv = data.map((row) => row.reduce((s, x, j) => s + x * vec[j], 0));
      const newVec = new Array<number>(D).fill(0);
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < D; j++) {
          newVec[j] += (data[i][j] * Xv[i]) / N;
        }
      }

      // Deflate again to keep orthogonality
      if (exclude) {
        const d = newVec.reduce((s, v, i) => s + v * exclude[i], 0);
        for (let i = 0; i < D; i++) newVec[i] -= d * exclude[i];
      }

      norm = Math.sqrt(newVec.reduce((s, v) => s + v * v, 0));
      if (norm < 1e-10) break;

      const normalized = newVec.map((v) => v / norm);
      const diff = normalized.reduce((s, v, i) => s + (v - vec[i]) ** 2, 0);
      vec = normalized;
      if (diff < 1e-12) break;
    }

    return vec;
  }

  const pc1 = findPC(centered);
  const pc2 = findPC(centered, pc1);

  // Step 4: project each centered vector onto PC1 and PC2
  return centered.map((v) => ({
    x: v.reduce((s, x, j) => s + x * pc1[j], 0),
    y: v.reduce((s, x, j) => s + x * pc2[j], 0),
  }));
}
