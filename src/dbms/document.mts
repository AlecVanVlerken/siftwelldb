export type FieldValue = string | number | boolean;
export type RawId = string | number;

export type RawDocument = {
  id: RawId;
  [key: string]: FieldValue;
};

/**
 * Plain data shape used by the rest of the DBMS.
 */
export type Document = {
  id: string;
  [key: string]: FieldValue;
};

/**
 * Predicate to decide which fields are indexable / iterable.
 */
export type IndexPredicate = (field: string) => boolean;

/**
 * Default traversal rule: allow everything except `id` and fields starting with "_".
 */
export const defaultIndexPredicate: IndexPredicate = (field) => field !== 'id' && !field.startsWith('_');

/**
 * Result of parsing a raw JSON-ish object into a normalized document,
 * split into indexable vs non-indexable fields.
 */
export type ParsedDocument = {
  id: string;
  collection: string;
  iterableEntries: [string, FieldValue][];
  nonIterableEntries: [string, FieldValue][];
  asDocument(): Document;
};

export function isFieldValue(value: unknown): value is FieldValue {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

export function validateDocument(document: Document) {
  if (typeof document.id !== 'string' || document.id.length === 0)
    throw new Error('Document must have a non-empty string id');
  for (const [key, value] of Object.entries(document)) {
    if (key === 'id') continue;
    if (!isFieldValue(value)) throw new Error(`Unsupported value type for field ${key}`);
  }
}

function normalizeId(id: RawId): string {
  const str = typeof id === 'number' ? String(id) : id;
  if (str.length === 0) throw new Error('Document must have a non-empty string id');
  return str;
}

/**
 * Parse a client-supplied object (e.g. `{ id: 'Leuven', population: 101032 }`)
 * and split its fields based on the supplied index predicate.
 */
export function parseRawDocument(
  collection: string,
  raw: unknown,
  isIndexable: IndexPredicate,
): ParsedDocument {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Document must be an object');

  const rawId = (raw as Record<string, unknown>)['id'];
  if (rawId === undefined || rawId === null) throw new Error('Document must have an id');
  if (typeof rawId !== 'string' && typeof rawId !== 'number')
    throw new Error('Document id must be a string or number');
  const id = normalizeId(rawId);

  const iterableEntries: [string, FieldValue][] = [];
  const nonIterableEntries: [string, FieldValue][] = [];

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'id') continue;
    if (!isFieldValue(value)) throw new Error(`Unsupported value type for field ${key}`);
    const entry: [string, FieldValue] = [key, value];
    if (isIndexable(key)) iterableEntries.push(entry);
    else nonIterableEntries.push(entry);
  }

  const asDocument = (): Document => ({
    id,
    ...Object.fromEntries([...iterableEntries, ...nonIterableEntries]),
  });

  return { id, collection, iterableEntries, nonIterableEntries, asDocument };
}

/**
 * Thin OO wrapper if you prefer a class with helpers.
 */
export class DocumentRecord {
  readonly collection: string;
  readonly id: string;
  readonly iterableEntries: [string, FieldValue][];
  readonly nonIterableEntries: [string, FieldValue][];

  constructor(collection: string, raw: unknown, isIndexable: IndexPredicate) {
    const parsed = parseRawDocument(collection, raw, isIndexable);
    this.collection = parsed.collection;
    this.id = parsed.id;
    this.iterableEntries = parsed.iterableEntries;
    this.nonIterableEntries = parsed.nonIterableEntries;
  }

  getId() {
    return this.id;
  }

  getIterableKeys() {
    return this.iterableEntries.map(([k]) => k);
  }

  getNonIterableKeys() {
    return this.nonIterableEntries.map(([k]) => k);
  }

  getFields() {
    return Object.fromEntries([...this.iterableEntries, ...this.nonIterableEntries]);
  }

  asDocument(): Document {
    return { id: this.id, ...this.getFields() };
  }
}
