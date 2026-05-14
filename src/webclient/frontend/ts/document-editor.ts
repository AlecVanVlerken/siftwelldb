export type JsonObject = Record<string, unknown>;

export type JsonObjectParseResult = { ok: true; value: JsonObject } | { ok: false; error: string };

export type ImagePayloads = Record<string, string>;

function imageMimeMetadataField(key: string): string {
  return `_${key}_mime`;
}

function imageMimeFromDocument(key: string, document: JsonObject): string | null {
  const value = document[imageMimeMetadataField(key)];
  return typeof value === 'string' && value.toLowerCase().startsWith('image/') ? value : null;
}

function isImageField(key: string, document?: JsonObject): boolean {
  return (
    /^(image|photo|picture|cover|avatar|thumbnail|img).*\.(jpe?g|png|gif|webp)$/i.test(key) ||
    /\.(jpe?g|png|gif|webp)$/i.test(key) ||
    (document ? imageMimeFromDocument(key, document) !== null : false)
  );
}

function normalizeImageValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const dataUrl = value.match(/^data:image\/[a-z0-9.+-]+;base64,(.*)$/i);
  return dataUrl ? dataUrl[1] : value;
}

export function normalizeDocumentImages(document: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(document).map(([key, value]) => [
      key,
      isImageField(key, document) ? normalizeImageValue(value) : value,
    ]),
  );
}

function estimateBase64Bytes(value: string): number {
  const base64 = String(normalizeImageValue(value));
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function imagePlaceholder(fieldName: string, value: string): string {
  return `[image: ${fieldName}, ${formatBytes(estimateBase64Bytes(value))}]`;
}

export function compactDocumentImages(document: JsonObject): { document: JsonObject; imagePayloads: ImagePayloads } {
  const imagePayloads: ImagePayloads = {};
  const compacted = Object.fromEntries(
    Object.entries(document).map(([key, value]) => {
      if (!isImageField(key, document) || typeof value !== 'string' || value.length === 0) return [key, value];
      const payload = String(normalizeImageValue(value));
      imagePayloads[key] = payload;
      return [key, imagePlaceholder(key, payload)];
    }),
  );
  return { document: compacted, imagePayloads };
}

export function restoreCompactedDocumentImages(document: JsonObject, imagePayloads: ImagePayloads = {}): JsonObject {
  return Object.fromEntries(
    Object.entries(document).map(([key, value]) => {
      if (!isImageField(key, document)) return [key, value];
      const existingPayload = imagePayloads[key];
      if (typeof value === 'string' && existingPayload && value === imagePlaceholder(key, existingPayload)) {
        return [key, existingPayload];
      }
      return [key, normalizeImageValue(value)];
    }),
  );
}

export function parseJsonObjectInput(raw: string): JsonObjectParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Top-level value must be a JSON object.' };
  }

  return { ok: true, value: parsed as JsonObject };
}

function normalizeDocumentId(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

export function validateDocumentInput(
  raw: string,
  options: { existingId?: unknown; requireId?: boolean; imagePayloads?: ImagePayloads } = {},
): JsonObjectParseResult {
  const parsed = parseJsonObjectInput(raw);
  if (!parsed.ok) return parsed;

  const { value } = parsed;
  const hasId = Object.prototype.hasOwnProperty.call(value, 'id');
  const normalizedId = normalizeDocumentId(value['id']);
  if (options.requireId !== false && !hasId) {
    return { ok: false, error: 'Document must include an "id" field.' };
  }
  if (hasId && (normalizedId === null || normalizedId.trim() === '')) {
    return { ok: false, error: 'Document "id" must not be empty.' };
  }
  if (options.existingId !== undefined && normalizedId !== normalizeDocumentId(options.existingId)) {
    return { ok: false, error: `The "id" field is read-only and must remain ${JSON.stringify(options.existingId)}.` };
  }

  return { ok: true, value: restoreCompactedDocumentImages(value, options.imagePayloads) };
}

function placeholderFor(value: unknown): unknown {
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return false;
  if (Array.isArray(value)) return [];
  if (value && typeof value === 'object') return {};
  return '';
}

export function buildDocumentTemplate(collection: string, docs: JsonObject[] = []): JsonObject {
  const template: JsonObject = { id: `${collection || 'document'}-1` };
  const keys = Array.from(new Set(docs.flatMap((doc) => Object.keys(doc)))).filter(
    (key) => !key.startsWith('_') && key !== 'id',
  );

  for (const key of keys) {
    const sample = docs.find((doc) => doc[key] !== undefined && doc[key] !== null)?.[key];
    template[key] = placeholderFor(sample);
  }

  return template;
}
