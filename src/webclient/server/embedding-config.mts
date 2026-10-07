// @author Alexandre-Gatien Bienfet
// @date 2026-05-12

import type { HnswConfig } from '../../database/simpledbms.mjs';

/**
 * Shared webclient HNSW config. The webclient uses two indexes per
 * collection:
 * - MiniLM for text fields (`Tekst`)
 * - CLIP for image fields (`Foto` and image upload)
 *
 * Why this exists: the daemon and any webclient-managed demo seeding
 * need to open `SimpleDbms` with the same HNSW configuration so that
 * every insert is embedded as it happens. Without this, documents
 * inserted before HNSW is turned on would be silently invisible to
 * semantic search.
 */

const CLIP_MODEL_ID = 'Xenova/clip-vit-base-patch32';
const CLIP_DIM = 512;
const MINILM_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const MINILM_DIM = 384;

type ClipModels = {
  tokenizer: (text: string, opts?: { padding: boolean; truncation: boolean }) => unknown;
  textModel: (inputs: unknown) => Promise<{ text_embeds: { data: ArrayLike<number> } }>;
  processor: (image: unknown) => Promise<unknown>;
  visionModel: (inputs: unknown) => Promise<{ image_embeds: { data: ArrayLike<number> } }>;
  rawImageFromBlob: (blob: Blob) => Promise<unknown>;
};

type MiniLmModels = {
  extractor: (text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: ArrayLike<number> }>;
};

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
const loadState: Record<'clip' | 'minilm', LoadState> = { clip: 'idle', minilm: 'idle' };
const loadError: Record<'clip' | 'minilm', string | null> = { clip: null, minilm: null };

// Module-level promise so the load happens at most once across the
// whole process, no matter how many databases are opened.
let modelsPromise: Promise<ClipModels> | null = null;
let miniLmPromise: Promise<MiniLmModels> | null = null;

/**
 * Status of the CLIP model load. `idle` means nothing has triggered
 * the load yet, `loading` means it's in progress, `ready` means
 * subsequent embeddings will be fast, and `error` means the last load
 * attempt failed.
 */
export function getEmbeddingStatus(): {
  state: LoadState;
  error: string | null;
  model: { id: 'dual'; label: string; dimension: number; supportsImages: true; description: string };
  indexes: {
    text: { state: LoadState; error: string | null; modelId: string; dimension: number };
    image: { state: LoadState; error: string | null; modelId: string; dimension: number };
  };
} {
  const state =
    loadState.clip === 'error' || loadState.minilm === 'error'
      ? 'error'
      : loadState.clip === 'loading' || loadState.minilm === 'loading'
        ? 'loading'
        : loadState.clip === 'ready' && loadState.minilm === 'ready'
          ? 'ready'
          : 'idle';
  return {
    state,
    error: loadError.clip || loadError.minilm,
    model: {
      id: 'dual',
      label: 'MiniLM text + CLIP images',
      dimension: CLIP_DIM,
      supportsImages: true,
      description:
        'Text search uses a MiniLM text index; photo search and image upload use a separate CLIP image index.',
    },
    indexes: {
      text: { state: loadState.minilm, error: loadError.minilm, modelId: MINILM_MODEL_ID, dimension: MINILM_DIM },
      image: { state: loadState.clip, error: loadError.clip, modelId: CLIP_MODEL_ID, dimension: CLIP_DIM },
    },
  };
}

export function preloadEmbeddingModels(kind: 'text' | 'image' | 'all' = 'all'): void {
  if ((kind === 'text' || kind === 'all') && loadState.minilm === 'idle') {
    void loadMiniLmModel().catch(() => undefined);
  }
  if ((kind === 'image' || kind === 'all') && loadState.clip === 'idle') {
    void loadClipModels().catch(() => undefined);
  }
}

function loadClipModels(): Promise<ClipModels> {
  if (!modelsPromise) {
    loadState.clip = 'loading';
    loadError.clip = null;
    modelsPromise = (async () => {
      const { AutoTokenizer, AutoProcessor, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, RawImage } =
        await import('@huggingface/transformers');

      const tokenizer = await AutoTokenizer.from_pretrained(CLIP_MODEL_ID);
      const textModel = await CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL_ID, { dtype: 'fp32' });

      const processor = await AutoProcessor.from_pretrained(CLIP_MODEL_ID);
      const visionModel = await CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL_ID, { dtype: 'fp32' });

      loadState.clip = 'ready';
      return {
        tokenizer: tokenizer as ClipModels['tokenizer'],
        textModel: textModel as unknown as ClipModels['textModel'],
        processor: processor as unknown as ClipModels['processor'],
        visionModel: visionModel as unknown as ClipModels['visionModel'],
        rawImageFromBlob: (blob: Blob) => RawImage.fromBlob(blob),
      };
    })().catch((err) => {
      loadState.clip = 'error';
      loadError.clip = err instanceof Error ? err.message : String(err);
      modelsPromise = null;
      throw err;
    });
  }
  return modelsPromise;
}

function loadMiniLmModel(): Promise<MiniLmModels> {
  if (!miniLmPromise) {
    loadState.minilm = 'loading';
    loadError.minilm = null;
    miniLmPromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const extractor = await pipeline('feature-extraction', MINILM_MODEL_ID, { dtype: 'fp32' });

      loadState.minilm = 'ready';
      return { extractor: extractor as MiniLmModels['extractor'] };
    })().catch((err) => {
      loadState.minilm = 'error';
      loadError.minilm = err instanceof Error ? err.message : String(err);
      miniLmPromise = null;
      throw err;
    });
  }
  return miniLmPromise;
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
 * Returns the shared HnswConfig. Safe to call at startup - CLIP only
 * loads on the first call to `embeddingFn` / `imageEmbeddingFn`.
 */
export function getClipHnswConfig(): HnswConfig {
  const clipIndex = {
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

  return {
    ...clipIndex,
    textIndex: {
      dimension: MINILM_DIM,
      M: 16,
      efConstruction: 100,
      efSearch: 50,
      async embeddingFn(text: string): Promise<Float32Array> {
        const m = await loadMiniLmModel();
        const out = await m.extractor(text, { pooling: 'mean', normalize: true });
        return l2Normalize(new Float32Array(out.data));
      },
    },
    imageIndex: clipIndex,
  };
}
