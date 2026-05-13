// @author Alexandre-Gatien Bienfet
// @date 2026-05-12

import type { HnswConfig } from '../dbms/simpledbms.mjs';

/**
 * A single shared `HnswConfig` for the entire process, backed by
 * Xenova's CLIP ViT-B/32 model. The CLIP weights are loaded lazily on
 * the **first** call to `embeddingFn` or `imageEmbeddingFn` — opening
 * a database with this config is therefore free, the cost is only
 * paid when the daemon actually needs to embed something.
 *
 * Why this exists: both the daemon (`service.mts`) and the seed
 * script (`seed-main-db.mts`) need to open `SimpleDbms` with the same
 * HNSW configuration so that every insert is embedded as it happens.
 * Without this, documents inserted before HNSW is turned on would be
 * silently invisible to semantic search.
 */

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const CLIP_DIM = 512;

type ClipModels = {
  tokenizer: (text: string, opts?: { padding: boolean; truncation: boolean }) => unknown;
  textModel: (inputs: unknown) => Promise<{ text_embeds: { data: ArrayLike<number> } }>;
  processor: (image: unknown) => Promise<unknown>;
  visionModel: (inputs: unknown) => Promise<{ image_embeds: { data: ArrayLike<number> } }>;
  rawImageFromBlob: (blob: Blob) => Promise<unknown>;
};

// Module-level promise so the load happens at most once across the
// whole process, no matter how many times getClipHnswConfig is called.
let modelsPromise: Promise<ClipModels> | null = null;
type LoadState = 'idle' | 'loading' | 'ready' | 'error';
let loadState: LoadState = 'idle';
let loadError: string | null = null;

/**
 * Status of the CLIP model load. `idle` means nothing has triggered
 * the load yet, `loading` means it's in progress, `ready` means
 * subsequent embeddings will be fast, and `error` means the last load
 * attempt failed.
 */
export function getEmbeddingStatus(): { state: LoadState; error: string | null } {
  return { state: loadState, error: loadError };
}

/**
 * Eagerly start loading the CLIP model in the background. Subsequent
 * calls are no-ops. Errors are caught and reflected via
 * `getEmbeddingStatus`.
 */
export function preloadClipModels(): void {
  if (loadState === 'idle') {
    void loadClipModels().catch(() => undefined);
  }
}

function loadClipModels(): Promise<ClipModels> {
  if (!modelsPromise) {
    loadState = 'loading';
    loadError = null;
    modelsPromise = (async () => {
      console.log('Lazy loading huggingface transformers for semantic search…');
      const {
        AutoTokenizer,
        AutoProcessor,
        CLIPTextModelWithProjection,
        CLIPVisionModelWithProjection,
        RawImage,
      } = await import('@huggingface/transformers');

      console.log('Loading CLIP tokenizer & text model…');
      const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
      const textModel = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'fp32' });

      console.log('Loading CLIP processor & vision model…');
      const processor = await AutoProcessor.from_pretrained(MODEL_ID);
      const visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'fp32' });

      console.log('CLIP models loaded successfully.');
      loadState = 'ready';
      return {
        tokenizer: tokenizer as ClipModels['tokenizer'],
        textModel: textModel as unknown as ClipModels['textModel'],
        processor: processor as unknown as ClipModels['processor'],
        visionModel: visionModel as unknown as ClipModels['visionModel'],
        rawImageFromBlob: (blob: Blob) => RawImage.fromBlob(blob),
      };
    })().catch((err) => {
      loadState = 'error';
      loadError = err instanceof Error ? err.message : String(err);
      modelsPromise = null;
      throw err;
    });
  }
  return modelsPromise;
}

function l2Normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (const val of v) norm += val * val;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/**
 * Returns the shared HnswConfig. Safe to call at startup — CLIP only
 * loads on the first call to `embeddingFn` / `imageEmbeddingFn`.
 */
export function getClipHnswConfig(): HnswConfig {
  return {
    dimension: CLIP_DIM,
    M: 16,
    efConstruction: 100,
    efSearch: 50,
    async embeddingFn(text: string): Promise<Float32Array> {
      const m = await loadClipModels();
      const inputs = m.tokenizer(text, { padding: true, truncation: true });
      const { text_embeds } = await m.textModel(inputs);
      return l2Normalize(new Float32Array(text_embeds.data));
    },
    async imageEmbeddingFn(imageData: Buffer): Promise<Float32Array> {
      const m = await loadClipModels();
      const blob = new Blob([new Uint8Array(imageData)]);
      const image = await m.rawImageFromBlob(blob);
      const inputs = await m.processor(image);
      const { image_embeds } = await m.visionModel(inputs);
      return l2Normalize(new Float32Array(image_embeds.data));
    },
  };
}
