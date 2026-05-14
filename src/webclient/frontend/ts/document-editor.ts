export type JsonObject = Record<string, unknown>;

export type JsonObjectParseResult =
  | { ok: true; value: JsonObject }
  | { ok: false; error: string };

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
  options: { existingId?: unknown; requireId?: boolean } = {},
): JsonObjectParseResult {
  const parsed = parseJsonObjectInput(raw);
  if (!parsed.ok) return parsed;

  const { value } = parsed;
  const hasId = Object.prototype.hasOwnProperty.call(value, 'id');
  if (options.requireId !== false && !hasId) {
    return { ok: false, error: 'Document must include an "id" field.' };
  }
  if (hasId && (value['id'] === null || value['id'] === undefined || String(value['id']).trim() === '')) {
    return { ok: false, error: 'Document "id" must not be empty.' };
  }
  if (options.existingId !== undefined && String(value['id']) !== String(options.existingId)) {
    return { ok: false, error: `The "id" field is read-only and must remain ${JSON.stringify(options.existingId)}.` };
  }

  return parsed;
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
  const keys = Array.from(new Set(docs.flatMap((doc) => Object.keys(doc))))
    .filter((key) => !key.startsWith('_') && key !== 'id');

  for (const key of keys) {
    const sample = docs.find((doc) => doc[key] !== undefined && doc[key] !== null)?.[key];
    template[key] = placeholderFor(sample);
  }

  return template;
}
