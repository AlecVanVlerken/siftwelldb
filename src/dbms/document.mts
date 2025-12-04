export type FieldValue = string | number | boolean;
export type RawId = string | number;
export type IndexPredicate = (field: string) => boolean;

export const defaultIndexPredicate: IndexPredicate = (field) => field !== 'id' && !field.startsWith('_');

export function isFieldValue(value: unknown): value is FieldValue {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * Core Document class used by the DBMS.
 */
export class Document {
  private collection: string;
  private id: RawId;
  private iterableEntries: [string, FieldValue][];
  private nonIterableEntries: [string, FieldValue][];

  constructor(
    collection: string,
    id: RawId,
    iterableEntries: [string, FieldValue][],
    nonIterableEntries: [string, FieldValue][],
  ) {
    this.collection = collection;
    this.id = id;
    this.iterableEntries = iterableEntries;
    this.nonIterableEntries = nonIterableEntries;
  }

  getCollectionName() {
    return this.collection;
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

  asDocument() {
    return { id: this.id, ...this.getFields() };
  }
}

/**
 * Parse a raw object supplied by the client and split fields into iterable vs non-iterable.
 * Returns a Document instance.
 */
export function parseRawDocument(
  collection: string,
  raw: unknown,
  isIndexable: IndexPredicate = defaultIndexPredicate,
): Document {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Document must be an object');

  const rawId = (raw as Record<string, unknown>)['id'];
  if (rawId === undefined || rawId === null) throw new Error('Document must have an id');
  if (typeof rawId !== 'string' && typeof rawId !== 'number') throw new Error('Document id must be a string or number');

  const iterableEntries: [string, FieldValue][] = [];
  const nonIterableEntries: [string, FieldValue][] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'id') continue;
    if (!isFieldValue(value)) throw new Error(`Unsupported value type for field ${key}`);
    const entry: [string, FieldValue] = [key, value];
    if (isIndexable(key)) iterableEntries.push(entry);
    else nonIterableEntries.push(entry);
  }

  return new Document(collection, rawId, iterableEntries, nonIterableEntries);
}

/**
 * Parse a textual document literal of the form
 *   "{id: 'Leuven', population: 101032, _isProvinceCapital: true}"
 * into a Document instance.
 */
export function JSONtoDocument(input: string, collection: string): Document {
  const body = input.trim();
  if (!body.startsWith('{') || !body.endsWith('}')) throw new Error('Input must be of the form { ... }');

  // Quote keys and convert single quotes to double quotes so JSON.parse can handle it safely.
  const withQuotedKeys = body.replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');
  const normalizedStrings = withQuotedKeys.replace(/'([^']*)'/g, '"$1"');

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedStrings);
  } catch (err) {
    throw new Error(`Failed to parse document string: ${(err as Error).message}`);
  }

  return parseRawDocument(collection, parsed, defaultIndexPredicate);
}
