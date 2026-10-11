// author: Frederik Caeyman
// date: 2025-12-08

import { readQuotedString } from './string-literal.mjs';

export type FieldValue = string | number | boolean | Buffer;
export type RawId = string | number;

/** File extensions that denote binary image fields. */
export const IMAGE_EXTENSIONS = ['.jpeg', '.jpg', '.png', '.webp', '.gif'] as const;
export const IMAGE_MIME_SUFFIX = '_mime';

export function imageMimeMetadataField(fieldName: string): string {
  return `_${fieldName}${IMAGE_MIME_SUFFIX}`;
}

export function imageMimeForField(fieldName: string, fields: Record<string, unknown>): string | null {
  const value = fields[imageMimeMetadataField(fieldName)];
  return typeof value === 'string' && value.toLowerCase().startsWith('image/') ? value : null;
}

/** Returns `true` when a field is image-like by extension or MIME sidecar. */
export function isImageField(fieldName: string, fields?: Record<string, unknown>): boolean {
  const lower = fieldName.toLowerCase();
  return (
    IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext)) ||
    (fields ? imageMimeForField(fieldName, fields) !== null : false)
  );
}

/** Ordinary key types supported by secondary B+ trees. Field names have no indexing meaning. */
export function supportsFieldIndex(field: string, value: FieldValue, fields: Record<string, unknown>): boolean {
  return field !== 'id' && !Buffer.isBuffer(value) && !isImageField(field, fields);
}

export function isFieldValue(value: unknown): value is FieldValue {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    Buffer.isBuffer(value)
  );
}

/** Validate exact identities before UTF-8 primary or composite key encoding. */
export function validateDocumentId(id: unknown): asserts id is RawId {
  if (id === undefined || id === null) throw new Error('Document must have an id');
  if (typeof id !== 'string' && typeof id !== 'number') throw new Error('Document id must be a string or number');
  if (typeof id === 'number' && !Number.isFinite(id)) throw new Error('Document id must be finite');
  if (typeof id === 'string') {
    for (let index = 0; index < id.length; index++) {
      const unit = id.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = id.charCodeAt(++index);
        if (next >= 0xdc00 && next <= 0xdfff) continue;
      } else if (unit < 0xdc00 || unit > 0xdfff) {
        continue;
      }
      throw new Error('Document id must not contain an unpaired UTF-16 surrogate');
    }
  }
}

function validateFieldValue(field: string, value: unknown): asserts value is FieldValue {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Field ${field} must be finite`);
  if (!isFieldValue(value)) throw new Error(`Unsupported value type for field ${field}`);
}

/** Shared value preflight, including programmatically constructed Documents. */
export function validateDocumentValues(document: Document): void {
  validateDocumentId(document.getId());
  for (const [field, value] of Object.entries(document.getFields())) validateFieldValue(field, value);
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
 * Parse a raw object supplied by the client. The two entry groups are retained
 * for RecordStore compatibility; collection metadata controls actual indexing.
 * Returns a Document instance.
 */
export function parseRawDocument(collection: string, raw: unknown): Document {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Document must be an object');

  const rawId = (raw as Record<string, unknown>)['id'];
  validateDocumentId(rawId);

  const iterableEntries: [string, FieldValue][] = [];
  const nonIterableEntries: [string, FieldValue][] = [];
  const rawRecord = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(rawRecord)) {
    if (key === 'id') continue;
    validateFieldValue(key, value);

    let fieldValue: FieldValue;
    if (isImageField(key, rawRecord) && typeof value === 'string') {
      // Image field supplied as base64 string → decode to Buffer.
      fieldValue = Buffer.from(value, 'base64');
    } else {
      fieldValue = value;
    }

    const entry: [string, FieldValue] = [key, fieldValue];
    if (supportsFieldIndex(key, fieldValue, rawRecord)) iterableEntries.push(entry);
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

  let parsed: unknown;
  try {
    // Preserve ordinary JSON exactly; the compatibility literal form only
    // normalizes actual keys and quoted tokens, never string contents.
    try {
      parsed = JSON.parse(body);
    } catch {
      let normalized = '';
      for (let i = 0; i < body.length; ) {
        if (body[i] === "'" || body[i] === '"') {
          const token = readQuotedString(body, i);
          normalized += JSON.stringify(token.value);
          i = token.end;
        } else {
          const key = body.slice(i).match(/^[A-Za-z0-9_.]+(?=\s*:)/);
          if (key) {
            normalized += JSON.stringify(key[0]);
            i += key[0].length;
          } else normalized += body[i++];
        }
      }
      parsed = JSON.parse(normalized);
    }
  } catch (err) {
    throw new Error(`Failed to parse document string: ${(err as Error).message}`);
  }

  return parseRawDocument(collection, parsed);
}

/**
 *
 * @param document
 * @author: thomas Dumon
 */
export function documentToJSON(document: Document): string {
  const raw = document.asDocument();
  const serialisable = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, Buffer.isBuffer(value) ? value.toString('base64') : value]),
  );
  return JSON.stringify(serialisable);
}
