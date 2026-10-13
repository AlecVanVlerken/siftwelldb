import { fmtSize, isImageField } from './format.js';
import { createDictionary } from './state.js';

export type JsonObject = Record<string, unknown>;

export type JsonObjectParseResult = { ok: true; value: JsonObject } | { ok: false; error: string };

type BinaryValue = { $binary: string };
export type ImagePayloads = Record<string, string | BinaryValue>;

export function isBinaryValue(value: unknown): value is BinaryValue {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, '$binary') &&
    typeof (value as BinaryValue).$binary === 'string'
  );
}

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

export function compactDocumentImages(
  document: JsonObject,
  editor = false,
): { document: JsonObject; imagePayloads: ImagePayloads } {
  const imagePayloads: ImagePayloads = createDictionary();
  const compacted = Object.fromEntries(
    Object.entries(document).map(([key, value]) => {
      if (!isImageField(key, document) || (typeof value !== 'string' && !isBinaryValue(value))) return [key, value];
      if (editor && !isBinaryValue(value)) return [key, value];
      const payload = isBinaryValue(value) ? value.$binary : String(normalizeImageValue(value));
      if (!payload) return [key, value];
      imagePayloads[key] = isBinaryValue(value) ? value : payload;
      return [key, imagePlaceholder(key, payload)];
    }),
  );
  return { document: compacted, imagePayloads };
}

function restoreCompactedDocumentImages(
  document: JsonObject,
  imagePayloads: ImagePayloads = createDictionary(),
  editor = false,
): JsonObject {
  return Object.fromEntries(
    Object.entries(document).map(([key, value]) => {
      const existingPayload = imagePayloads[key];
      const base64 = typeof existingPayload === 'string' ? existingPayload : existingPayload?.$binary;
      if (typeof value === 'string' && base64 && value === imagePlaceholder(key, base64)) {
        return [key, existingPayload];
      }
      if (editor || !isImageField(key, document)) return [key, value];
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

  return { ok: true, value: createDictionary(parsed as JsonObject) };
}

export function validateDocumentInput(
  raw: string,
  options: { existingId?: unknown; requireId?: boolean; imagePayloads?: ImagePayloads; editor?: boolean } = {},
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
  if (typeof id === 'string' && !id.isWellFormed()) {
    return { ok: false, error: 'Document "id" must not contain unpaired UTF-16 surrogates.' };
  }
  if (options.existingId !== undefined && id !== options.existingId) {
    return { ok: false, error: `The "id" field is read-only and must remain ${JSON.stringify(options.existingId)}.` };
  }

  for (const [field, fieldValue] of Object.entries(value)) {
    if (field === 'id') continue;
    if (typeof fieldValue === 'string' && !fieldValue.isWellFormed())
      return { ok: false, error: `Field ${JSON.stringify(field)} must not contain an unpaired UTF-16 surrogate.` };
    if (options.editor && isBinaryValue(fieldValue)) continue;
    if (
      !['string', 'number', 'boolean'].includes(typeof fieldValue) ||
      (typeof fieldValue === 'number' && !Number.isFinite(fieldValue))
    ) {
      return { ok: false, error: `Field ${JSON.stringify(field)} must be a string, a finite number, or a boolean.` };
    }
  }

  return { ok: true, value: restoreCompactedDocumentImages(value, options.imagePayloads, options.editor) };
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
  const template: JsonObject = createDictionary({ id: `${prefix}-${sequence}` });
  const keys = Array.from(new Set(docs.flatMap((doc) => Object.keys(doc)))).filter((key) => key !== 'id');

  for (const key of keys) {
    const sample = docs.find((doc) => doc[key] !== undefined && doc[key] !== null)?.[key];
    if (!['string', 'number', 'boolean'].includes(typeof sample)) continue;
    template[key] = placeholderFor(sample);
  }

  return template;
}
