declare module '@huggingface/transformers' {
  export type PipelineOptions = {
    dtype?: string;
  };

  export type FeatureExtractionOptions = {
    pooling?: string;
    normalize?: boolean;
  };

  export type FeatureExtractionOutput = {
    data: ArrayLike<number>;
  };

  export type FeatureExtractionPipeline = (
    text: string,
    options?: FeatureExtractionOptions,
  ) => Promise<FeatureExtractionOutput>;

  export function pipeline(
    task: 'feature-extraction',
    model: string,
    options?: PipelineOptions,
  ): Promise<FeatureExtractionPipeline>;

  export type Tokenizer = (
    text: string,
    options?: { padding?: boolean; truncation?: boolean },
  ) => Record<string, unknown>;

  export type Processor = (image: RawImage) => Promise<Record<string, unknown>>;

  export const AutoTokenizer: {
    from_pretrained(model: string): Promise<Tokenizer>;
  };

  export const AutoProcessor: {
    from_pretrained(model: string): Promise<Processor>;
  };

  export type CLIPTextModel = (
    inputs: Record<string, unknown>,
  ) => Promise<{ text_embeds: { data: ArrayLike<number> } }>;

  export type CLIPVisionModel = (
    inputs: Record<string, unknown>,
  ) => Promise<{ image_embeds: { data: ArrayLike<number> } }>;

  export const CLIPTextModelWithProjection: {
    from_pretrained(model: string, options?: PipelineOptions): Promise<CLIPTextModel>;
  };

  export const CLIPVisionModelWithProjection: {
    from_pretrained(model: string, options?: PipelineOptions): Promise<CLIPVisionModel>;
  };

  export class RawImage {
    static fromBlob(blob: Blob): Promise<RawImage>;
  }
}
