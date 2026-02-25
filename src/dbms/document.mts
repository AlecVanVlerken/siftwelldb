// author: Frederik Caeyman
// date: 2025-12-08

export type FieldValue = string | number | boolean | Buffer;
export type RawId = string | number;
export type IndexPredicate = (field: string) => boolean;

/** File extensions that denote binary image fields. */
export const IMAGE_EXTENSIONS = ['.jpeg', '.jpg', '.png', '.webp'] as const;

/** Returns `true` when `fieldName` ends with a recognised image extension. */
export function isImageField(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export const defaultIndexPredicate: IndexPredicate = (field) =>
  field !== 'id' && !field.startsWith('_') && !isImageField(field);

export function isFieldValue(value: unknown): value is FieldValue {
  return ['string', 'number', 'boolean'].includes(typeof value) || Buffer.isBuffer(value);
}

/**
 * Represents a document in the database.
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

  /**
   * Creates a clone of the document with an updated field value.
   * @param field - The field to update.
   * @param newValue - The new value for the field.
   * @returns A new Document instance with the updated field.
   * @throws {Error} If the field does not exist in the document.
   *
   * @author: Matisse De Gauquier
   */
  cloneWithUpdatedField(field: string, newValue: FieldValue): Document {
    // if field exists in iterableEntries, update it there
    // else if it exists in nonIterableEntries, update it there
    // else give error
    const iterableIndex = this.iterableEntries.findIndex(([k]) => k === field);
    const updatedIterableEntries = [...this.iterableEntries];
    const updatedNonIterableEntries = [...this.nonIterableEntries];

    if (iterableIndex !== -1) {
      updatedIterableEntries[iterableIndex] = [field, newValue];
    } else {
      const nonIterableIndex = this.nonIterableEntries.findIndex(([k]) => k === field);
      if (nonIterableIndex !== -1) {
        updatedNonIterableEntries[nonIterableIndex] = [field, newValue];
      } else {
        throw new Error(`Field ${field} does not exist in document`);
      }
    }

    return new Document(this.collection, this.id, updatedIterableEntries, updatedNonIterableEntries);
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

    let fieldValue: FieldValue;
    if (isImageField(key) && typeof value === 'string') {
      // Image field supplied as base64 string → decode to Buffer.
      fieldValue = Buffer.from(value, 'base64');
    } else if (!isFieldValue(value)) {
      throw new Error(`Unsupported value type for field ${key}`);
    } else {
      fieldValue = value;
    }

    const entry: [string, FieldValue] = [key, fieldValue];
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
  const withQuotedKeys = body.replace(/([{,]\s*)([A-Za-z0-9_.]+)\s*:/g, '$1"$2":');
  const normalizedStrings = withQuotedKeys.replace(/'([^']*)'/g, '"$1"');

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedStrings);
  } catch (err) {
    throw new Error(`Failed to parse document string: ${(err as Error).message}`);
  }

  return parseRawDocument(collection, parsed, defaultIndexPredicate);
}

/**
 *
 * @param document
 * @author: thomas Dumon
 */
export function documentToJSON(document: Document): string {
  const raw = document.asDocument();
  const serialisable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    serialisable[key] = Buffer.isBuffer(value) ? value.toString('base64') : value;
  }
  return JSON.stringify(serialisable);
}
