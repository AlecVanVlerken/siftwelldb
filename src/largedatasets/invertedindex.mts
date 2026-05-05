/**
 * Inverted Index module for SimpleDbms.
 *
 * Builds a word-level inverted index on top of SimpleDbms so you can do
 * full-text keyword searches across document fields. Each word maps to
 * the set of document IDs that contain it.
 *
 * Usage:
 *   const idx = new InvertedIndex(db, 'articles');
 *   await idx.addDocument({ id: 'a1', title: 'Hello world', body: 'Some text' });
 *   const results = await idx.search('hello');       // ['a1']
 *   const results = await idx.searchAll(['hello', 'world']); // AND search
 *
 * @module largedatasets/invertedindex
 */

import { SimpleDbms } from '../dbms/simpledbms.mjs';

/**
 * Tokenise a string into lowercase words.
 * Strips punctuation and splits on whitespace.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * An in-memory inverted index that works alongside SimpleDbms.
 *
 * The index is built by calling `addDocument` for each document.
 * Searches return document IDs which can then be fetched from the DB.
 */
export class InvertedIndex {
  private db: SimpleDbms;
  private collection: string;

  /** word -> Set of document IDs */
  private index: Map<string, Set<string>> = new Map();

  /** Which fields to index (if empty, index all string fields). */
  private fields: string[];

  constructor(db: SimpleDbms, collection: string, fields: string[] = []) {
    this.db = db;
    this.collection = collection;
    this.fields = fields;
  }

  /**
   * Index a document. The document is also inserted into the DB.
   *
   * @param doc - Plain object with at least an `id` field.
   */
  async addDocument(doc: Record<string, unknown>): Promise<void> {
    // Insert into the database
    await this.db.insertDocument(this.collection, JSON.stringify(doc));

    // Build the inverted index entries
    this.indexObject(doc);
  }

  /**
   * Index an already-inserted document (build index without re-inserting).
   */
  indexObject(doc: Record<string, unknown>): void {
    const id = doc['id'] as string;

    for (const [key, value] of Object.entries(doc)) {
      if (key === 'id') continue;
      if (this.fields.length > 0 && !this.fields.includes(key)) continue;
      if (key.startsWith('_') && !this.fields.includes(key)) continue;
      if (typeof value !== 'string') continue;

      const words = tokenize(value);
      for (const word of words) {
        if (!this.index.has(word)) {
          this.index.set(word, new Set());
        }
        this.index.get(word)!.add(id);
      }
    }
  }

  /**
   * Build the index from all existing documents in the collection.
   * Iterates through the collection using the given key.
   *
   * @param iterableKey - The key to iterate over (e.g. 'id').
   */
  async buildFromExisting(iterableKey: string): Promise<void> {
    for await (const jsonStr of this.db.cursor(this.collection, iterableKey)) {
      const doc = JSON.parse(jsonStr) as Record<string, unknown>;
      this.indexObject(doc);
    }
  }

  /**
   * Search for documents containing a single word.
   * Returns an array of document IDs.
   */
  search(word: string): string[] {
    const normalized = word.toLowerCase().replace(/[^a-z0-9]/g, '');
    const ids = this.index.get(normalized);
    return ids ? [...ids] : [];
  }

  /**
   * Search for documents containing ALL of the given words (AND search).
   * Returns an array of document IDs.
   */
  searchAll(words: string[]): string[] {
    const normalized = words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''));

    const sets = normalized.map((w) => this.index.get(w)).filter((s): s is Set<string> => s !== undefined);

    if (sets.length === 0) return [];
    if (sets.length !== normalized.length) return []; // a word had no matches

    // Intersect all sets
    const smallest = sets.reduce((a, b) => (a.size < b.size ? a : b));
    return [...smallest].filter((id) => sets.every((s) => s.has(id)));
  }

  /**
   * Search for documents containing ANY of the given words (OR search).
   * Returns an array of document IDs.
   */
  searchAny(words: string[]): string[] {
    const normalized = words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''));

    const union = new Set<string>();
    for (const word of normalized) {
      const ids = this.index.get(word);
      if (ids) {
        for (const id of ids) union.add(id);
      }
    }
    return [...union];
  }

  /**
   * Remove a document from the index.
   * Does NOT delete it from the database — call db.deleteDocumentById separately.
   */
  removeDocument(id: string): void {
    for (const [, ids] of this.index) {
      ids.delete(id);
    }
  }

  /** Returns the total number of unique words in the index. */
  get wordCount(): number {
    return this.index.size;
  }

  /** Returns all indexed words (useful for debugging). */
  get words(): string[] {
    return [...this.index.keys()];
  }

  /** Clears all entries from the in-memory index, freeing RAM. */
  clear(): void {
    this.index = new Map();
  }
}
