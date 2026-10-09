import { fmtSize, isImageField } from './format.js';

export type JsonObject = Record<string, unknown>;

export type JsonObjectParseResult = { ok: true; value: JsonObject } | { ok: false; error: string };

export type ImagePayloads = Record<string, string>;

function normalizeImageValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const dataUrl = value.match(/^data:image\/[a-z0-9.+-]+;base64,(.*)$/i);
  return dataUrl ? dataUrl[1] : value;
}

function estimateBase64Bytes(value: string): number {
  const base64 = String(normalizeImageValue(value));
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function imagePlaceholder(fieldName: string, value: string): string {
  return `[image: ${fieldName}, ${fmtSize(estimateBase64Bytes(value))}]`;
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

function restoreCompactedDocumentImages(document: JsonObject, imagePayloads: ImagePayloads = {}): JsonObject {
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

export function validateDocumentInput(
  raw: string,
  options: { existingId?: unknown; requireId?: boolean; imagePayloads?: ImagePayloads } = {},
): JsonObjectParseResult {
  const parsed = parseJsonObjectInput(raw);
  if (!parsed.ok) return parsed;

  const { value } = parsed;
  const hasId = Object.prototype.hasOwnProperty.call(value, 'id');
  const id = value['id'];
  if (options.requireId !== false && !hasId) {
    return { ok: false, error: 'Document must include an "id" field.' };
  }
  if (hasId && typeof id !== 'string' && (typeof id !== 'number' || !Number.isFinite(id))) {
    return { ok: false, error: 'Document "id" must be a string or a finite number.' };
  }
  if (typeof id === 'string' && id.trim() === '') {
    return { ok: false, error: 'Document "id" must not be empty.' };
  }
  if (options.existingId !== undefined && id !== options.existingId) {
    return { ok: false, error: `The "id" field is read-only and must remain ${JSON.stringify(options.existingId)}.` };
  }

  for (const [field, fieldValue] of Object.entries(value)) {
    if (field === 'id') continue;
    if (
      !['string', 'number', 'boolean'].includes(typeof fieldValue) ||
      (typeof fieldValue === 'number' && !Number.isFinite(fieldValue))
    ) {
      return { ok: false, error: `Field ${JSON.stringify(field)} must be a string, a finite number, or a boolean.` };
    }
  }

  return { ok: true, value: restoreCompactedDocumentImages(value, options.imagePayloads) };
}

function placeholderFor(value: unknown): unknown {
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return false;
  return '';
}

export function buildDocumentTemplate(collection: string, docs: JsonObject[] = []): JsonObject {
  const prefix = collection || 'document';
  const existingIds = new Set(docs.map((doc) => String(doc['id'])));
  let sequence = 1;
  while (existingIds.has(`${prefix}-${sequence}`)) sequence++;
  const template: JsonObject = { id: `${prefix}-${sequence}` };
  const keys = Array.from(new Set(docs.flatMap((doc) => Object.keys(doc)))).filter((key) => key !== 'id');

  for (const key of keys) {
    const sample = docs.find((doc) => doc[key] !== undefined && doc[key] !== null)?.[key];
    if (!['string', 'number', 'boolean'].includes(typeof sample)) continue;
    template[key] = placeholderFor(sample);
  }

  return template;
}
