export type Vector = number[];

/**
 * Splits a text string into lowercase word tokens, removing punctuation.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Flattens all field values of a document into a single text string.
 * Field names are included so that e.g. "continent Europe" differs from "language Europe".
 */
function documentToText(doc: Record<string, unknown>): string {
  return Object.entries(doc)
    .filter(([key]) => key !== 'id')
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(' ');
}

/**
 * Converts an array of raw documents into TF-IDF vectors.
 *
 * Each vector has one dimension per unique token across the whole corpus.
 * The value at each position is: (term frequency in doc) × (smoothed IDF).
 *
 * Documents with similar field values will produce similar vectors,
 * which makes PCA cluster them together on the map.
 */
export function computeTfIdf(documents: Record<string, unknown>[]): Vector[] {
  if (documents.length === 0) return [];

  const tokenized = documents.map((doc) => tokenize(documentToText(doc)));

  // Build a vocabulary: token → column index
  const vocab = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const token of new Set(tokens)) {
      if (!vocab.has(token)) vocab.set(token, vocab.size);
    }
  }

  const V = vocab.size;
  const N = documents.length;

  // Document frequency: how many documents contain each token
  const df = new Float64Array(V);
  for (const tokens of tokenized) {
    for (const token of new Set(tokens)) {
      const idx = vocab.get(token);
      if (idx !== undefined) df[idx]++;
    }
  }

  // Smoothed IDF: log((N+1) / (df+1)) + 1  (avoids log(0), rewards rare terms)
  const idf = new Float64Array(V);
  for (let i = 0; i < V; i++) {
    idf[i] = Math.log((N + 1) / (df[i] + 1)) + 1;
  }

  // Build TF-IDF matrix
  return tokenized.map((tokens) => {
    const tf = new Float64Array(V);
    for (const token of tokens) {
      const idx = vocab.get(token);
      if (idx !== undefined) tf[idx]++;
    }
    const len = tokens.length || 1;
    const vector = new Array<number>(V);
    for (let i = 0; i < V; i++) {
      vector[i] = (tf[i] / len) * idf[i];
    }
    return vector;
  });
}
