import { type File } from '../core/file.mjs';
import { CURRENT_VERSION, DbmsBackend, type SerializedDatabase } from './dbmsback.mjs';
import { defaultIndexPredicate, type Document, type FieldValue, type IndexPredicate } from './document.mjs';
import { RecordStore, type RecordStoreOptions } from './recordstore.mjs';

type SimpleDbmsOptions = {
  indexPredicate?: IndexPredicate;
  maxIndexValueLength?: number;
};

export class SimpleDbms {
  private readonly backend: DbmsBackend;
  private readonly recordStoreOptions: RecordStoreOptions;
  private readonly collections: Map<string, RecordStore> = new Map();

  private constructor(backend: DbmsBackend, recordStoreOptions: RecordStoreOptions) {
    this.backend = backend;
    this.recordStoreOptions = recordStoreOptions;
  }

  static async create(file: File, options?: SimpleDbmsOptions) {
    const predicate = options?.indexPredicate ?? defaultIndexPredicate;
    const recordStoreOptions: RecordStoreOptions = {
      indexPredicate: predicate,
      maxIndexValueLength: options?.maxIndexValueLength,
    };
    const backend = new DbmsBackend(file);
    const dbms = new SimpleDbms(backend, recordStoreOptions);
    await backend.create({ version: CURRENT_VERSION, collections: {} });
    return dbms;
  }

  static async open(file: File, options?: SimpleDbmsOptions) {
    const predicate = options?.indexPredicate ?? defaultIndexPredicate;
    const recordStoreOptions: RecordStoreOptions = {
      indexPredicate: predicate,
      maxIndexValueLength: options?.maxIndexValueLength,
    };
    const backend = new DbmsBackend(file);
    const dbms = new SimpleDbms(backend, recordStoreOptions);

    const snapshot = await backend.open();
    for (const [name, documents] of Object.entries(snapshot.collections)) {
      const store = RecordStore.fromDocuments(documents, recordStoreOptions);
      dbms.collections.set(name, store);
    }

    return dbms;
  }

  insert(collection: string, document: Document) {
    this.getOrCreateStore(collection).insert(document);
  }

  delete(collection: string, id: string): boolean {
    const store = this.collections.get(collection);
    if (!store) return false;
    return store.delete(id);
  }

  get(collection: string, id: string): Document | null {
    const store = this.collections.get(collection);
    return store ? store.get(id) : null;
  }

  listCollections(): string[] {
    return Array.from(this.collections.keys()).sort();
  }

  listDocuments(collection: string): Document[] {
    const store = this.collections.get(collection);
    return store ? store.list() : [];
  }

  iterate(collection: string, field: string, startValue?: FieldValue): IterableIterator<Document> {
    const store = this.collections.get(collection);
    if (!store) return [][Symbol.iterator]();
    return store.iterate(field, startValue);
  }

  async commit(): Promise<void> {
    const snapshot: SerializedDatabase = { version: CURRENT_VERSION, collections: {} };
    for (const [name, store] of this.collections) snapshot.collections[name] = store.list();
    await this.backend.persist(snapshot);
  }

  async close() {
    await this.backend.close();
  }

  private getOrCreateStore(collection: string): RecordStore {
    let store = this.collections.get(collection);
    if (!store) {
      store = new RecordStore(this.recordStoreOptions);
      this.collections.set(collection, store);
    }
    return store;
  }
}
