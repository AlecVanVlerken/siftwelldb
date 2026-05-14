export const MOCK_HNSW_DIMENSION = 384;
export const MOCK_HNSW_ENCODER_LABEL = `mock-random-${MOCK_HNSW_DIMENSION}d`;

export function mockEmbed(text: string, dimension: number = MOCK_HNSW_DIMENSION): Float32Array {
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  }

  const vector = new Float32Array(dimension);
  let state = seed;
  let norm = 0;
  for (let i = 0; i < dimension; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    vector[i] = (state / 0x100000000) * 2 - 1;
    norm += vector[i] * vector[i];
  }

  norm = Math.sqrt(norm);
  for (let i = 0; i < dimension; i++) {
    vector[i] /= norm;
  }
  return vector;
}
