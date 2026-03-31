export type DocumentPreviewOptions = {
  maxInlineStringBytes?: number;
  stringPreviewChars?: number;
  maxInlineTextBytes?: number;
  textPreviewChars?: number;
  maxInlineImageBytes?: number;
  hexPreviewBytes?: number;
};

export type NormalizedPreviewOptions = Required<DocumentPreviewOptions>;

const DEFAULT_OPTIONS: NormalizedPreviewOptions = {
  maxInlineImageBytes: 256 * 1024,
  maxInlineStringBytes: 4 * 1024,
  maxInlineTextBytes: 16 * 1024,
  hexPreviewBytes: 24,
  stringPreviewChars: 512,
  textPreviewChars: 512,
};

export function normalizePreviewOptions(options: DocumentPreviewOptions = {}): NormalizedPreviewOptions {
  return {
    maxInlineImageBytes: options.maxInlineImageBytes ?? DEFAULT_OPTIONS.maxInlineImageBytes,
    maxInlineStringBytes: options.maxInlineStringBytes ?? DEFAULT_OPTIONS.maxInlineStringBytes,
    maxInlineTextBytes: options.maxInlineTextBytes ?? DEFAULT_OPTIONS.maxInlineTextBytes,
    hexPreviewBytes: options.hexPreviewBytes ?? DEFAULT_OPTIONS.hexPreviewBytes,
    stringPreviewChars: options.stringPreviewChars ?? DEFAULT_OPTIONS.stringPreviewChars,
    textPreviewChars: options.textPreviewChars ?? DEFAULT_OPTIONS.textPreviewChars,
  };
}

export function truncatePreviewText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}
