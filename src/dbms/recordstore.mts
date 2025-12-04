import {
  type Document,
  type FieldValue,
  type IndexPredicate,
  defaultIndexPredicate,
  validateDocument,
} from './document.mjs';

export type RecordStoreOptions = {
  indexPredicate?: IndexPredicate;
  /**
   * Optional guard to skip indexing huge string values (keeps indexes small).
   * Defaults to Infinity (no limit).
   */
  maxIndexValueLength?: number;
};

type IndexEntry = {
  value: FieldValue;
  id: string;
};

const typeOrder: Record<string, number> = { number: 0, string: 1, boolean: 2 };

function compareFieldValues(a: FieldValue, b: FieldValue): number {
  const aRank = typeOrder[typeof a];
  const bRank = typeOrder[typeof b];
  if (aRank !== bRank) return aRank - bRank;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  if (a === b) return 0;
  return a ? 1 : -1;
}

function compareEntries(a: IndexEntry, b: IndexEntry): number {
  const cmp = compareFieldValues(a.value, b.value);
  if (cmp !== 0) return cmp;
  return a.id.localeCompare(b.id);
}

function lowerBound<T>(items: T[], key: T, compare: (a: T, b: T) => number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compare(items[mid]!, key) < 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

function cloneDocument(document: Document): Document {
  return { ...document };
}

export class RecordStore {
  private readonly isIndexable: IndexPredicate;
  private readonly maxIndexValueLength: number;
  private readonly byId = new Map<string, Document>();
  private readonly indexes: Map<string, IndexEntry[]> = new Map();

  constructor(options: RecordStoreOptions = {}) {
    this.isIndexable = options.indexPredicate ?? defaultIndexPredicate;
    this.maxIndexValueLength = options.maxIndexValueLength ?? Number.POSITIVE_INFINITY;
  }

  get size() {
    return this.byId.size;
  }

  insert(document: Document) {
    validateDocument(document);
    if (this.byId.has(document.id)) throw new Error(`Document with id ${document.id} already exists`);

    const stored = cloneDocument(document);
    this.byId.set(stored.id, stored);
    this.indexDocument(stored);
  }

  get(id: string): Document | null {
    const doc = this.byId.get(id);
    return doc ? cloneDocument(doc) : null;
  }

  delete(id: string): boolean {
    const doc = this.byId.get(id);
    if (!doc) return false;
    this.removeFromIndexes(doc);
    this.byId.delete(id);
    return true;
  }

  list(): Document[] {
    return Array.from(this.byId.values()).map(cloneDocument);
  }

  iterate(field: string, startValue?: FieldValue): IterableIterator<Document> {
    if (!this.byId.size) return [][Symbol.iterator]();
    if (!this.isIndexable(field)) return this.iterateWithoutIndex(field, startValue);

    const entries = this.indexes.get(field) ?? this.buildIndex(field);
    const start = startValue !== undefined ? lowerBound(entries, { value: startValue, id: '' }, compareEntries) : 0;

    const self = this;
    function* generator(): IterableIterator<Document> {
      for (let i = start; i < entries.length; i++) {
        const { id } = entries[i]!;
        const doc = self.byId.get(id);
        if (doc) yield cloneDocument(doc);
      }
    }
    return generator();
  }

  private iterateWithoutIndex(field: string, startValue?: FieldValue): IterableIterator<Document> {
    const candidates: Document[] = [];
    for (const doc of this.byId.values()) {
      if (!(field in doc)) continue;
      if (startValue !== undefined) {
        const cmp = compareFieldValues(doc[field] as FieldValue, startValue);
        if (cmp < 0) continue;
      }
      candidates.push(doc);
    }

    candidates.sort((a, b) => {
      const cmp = compareFieldValues(a[field] as FieldValue, b[field] as FieldValue);
      if (cmp !== 0) return cmp;
      return a.id.localeCompare(b.id);
    });

    function* generator(): IterableIterator<Document> {
      for (const doc of candidates) yield cloneDocument(doc);
    }
    return generator();
  }

  private indexDocument(document: Document) {
    for (const [key, value] of Object.entries(document)) {
      if (key === 'id') continue;
      if (!this.shouldIndexField(key, value as FieldValue)) continue;
      const entries = this.indexes.get(key) ?? this.buildIndex(key);
      const insertPos = lowerBound(entries, { value, id: document.id }, compareEntries);
      entries.splice(insertPos, 0, { value, id: document.id });
    }
  }

  private removeFromIndexes(document: Document) {
    for (const [key, value] of Object.entries(document)) {
      if (key === 'id') continue;
      if (!this.indexes.has(key)) continue;
      const entries = this.indexes.get(key)!;
      const index = lowerBound(entries, { value, id: document.id }, compareEntries);
      if (index < entries.length && entries[index]?.id === document.id) entries.splice(index, 1);
      if (entries.length === 0) this.indexes.delete(key);
    }
  }

  private buildIndex(field: string): IndexEntry[] {
    const entries: IndexEntry[] = [];
    for (const doc of this.byId.values()) {
      if (field in doc && this.shouldIndexField(field, doc[field] as FieldValue))
        entries.push({ value: doc[field] as FieldValue, id: doc.id });
    }
    entries.sort(compareEntries);
    this.indexes.set(field, entries);
    return entries;
  }

  private shouldIndexField(field: string, value: FieldValue): boolean {
    if (!this.isIndexable(field)) return false;
    if (typeof value === 'string' && value.length > this.maxIndexValueLength) return false;
    return true;
  }

  static fromDocuments(documents: Document[], options: RecordStoreOptions = {}) {
    const store = new RecordStore(options);
    for (const doc of documents) store.insert(doc);
    return store;
  }
}
