// author: Alexandre-Gatien Bienfet
// date: 2026-02-24
//
// DatabaseService — abstraction layer over SimpleDbms.
// This is the single point of contact for all database operations.
// Future extension points:
//   - Query language: add a query() method that parses query strings
//   - Compression: wrap document JSON before insert / after read
//   - Caching: add an in-memory document cache here

import * as fs from 'node:fs/promises';
import { SimpleDbms } from '../dbms/simpledbms.mjs';
import { SafeRealFile as RealFile } from './safe-file.mjs';

/**
 * Delete a file if it exists (ignores the error if not found).
 */
async function deleteIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // File doesn't exist — that's fine
  }
}

/**
 * Manages the lifecycle of a SimpleDbms instance and exposes
 * high-level operations on collections and documents.
 *
 * All database interaction from the HTTP layer should go through
 * this service so that cross-cutting concerns (compression, query
 * parsing, logging, …) can be added in one place.
 */
export class DatabaseService {
  private dbms: SimpleDbms | null = null;
  private dataFile: RealFile | null = null;
  private currentFilepath: string | null = null;

  // ── Lifecycle ────────────────────────────────────────────────

  /** True when a database is currently connected. */
  get isConnected(): boolean {
    return this.dbms !== null;
  }

  /** The filepath of the currently connected database, or null. */
  get filepath(): string | null {
    return this.currentFilepath;
  }

  /**
   * Connect to an existing database or create a new one if the
   * file does not exist yet.
   */
  async connect(filepath: string): Promise<string> {
    await this.closeInternal();

    let fileExists = false;
    try {
      await fs.access(filepath);
      fileExists = true;
    } catch {
      fileExists = false;
    }

    const dataFile = new RealFile(filepath);
    const logFile = new RealFile(`${filepath}.log`);

    if (fileExists) {
      this.dbms = await SimpleDbms.open(dataFile, logFile);
      this.dataFile = dataFile;
      this.currentFilepath = filepath;
      return 'Connected to existing database';
    } else {
      this.dbms = await SimpleDbms.create(dataFile, logFile);
      await this.dbms.commit();
      this.dataFile = dataFile;
      this.currentFilepath = filepath;
      return 'Created new database';
    }
  }

  /**
   * Force-create a new database, deleting any existing files first.
   */
  async create(filepath: string): Promise<string> {
    await this.closeInternal();

    await deleteIfExists(filepath);
    await deleteIfExists(`${filepath}.log`);

    const dataFile = new RealFile(filepath);
    const logFile = new RealFile(`${filepath}.log`);

    this.dbms = await SimpleDbms.create(dataFile, logFile);
    await this.dbms.commit();
    this.dataFile = dataFile;
    this.currentFilepath = filepath;
    return 'Created new database';
  }

  /** Disconnect from the current database. */
  async disconnect(): Promise<void> {
    await this.closeInternal();
  }

  /**
   * Reset the database by dropping all data and re-creating from scratch.
   */
  async reset(): Promise<void> {
    const filepath = this.currentFilepath;
    if (!filepath) throw new Error('No filepath available');

    await this.closeInternal();

    await deleteIfExists(filepath);
    await deleteIfExists(`${filepath}.log`);

    const dataFile = new RealFile(filepath);
    const logFile = new RealFile(`${filepath}.log`);
    this.dbms = await SimpleDbms.create(dataFile, logFile);
    await this.dbms.commit();
    this.dataFile = dataFile;
    this.currentFilepath = filepath;
  }

  // ── Collections ──────────────────────────────────────────────

  /** Return the list of collection names. */
  async getCollections(): Promise<string[]> {
    this.ensureConnected();
    return this.dbms!.getCollections();
  }

  // ── Documents ────────────────────────────────────────────────

  /**
   * Query documents from a collection.
   *
   * Future: this method could accept a query-language string
   * and parse it into the appropriate cursor parameters.
   */
  async getDocuments(
    collection: string,
    iterableKey: string = 'id',
    value?: string,
    limit: number = 100,
  ): Promise<string[]> {
    this.ensureConnected();

    const documents: string[] = [];
    const cursor = this.dbms!.cursor(collection, iterableKey, value);

    let count = 0;
    for await (const doc of cursor) {
      documents.push(doc);
      count++;
      if (count >= limit) break;
    }

    return documents;
  }

  /** Insert a document into a collection. */
  async insertDocument(collection: string, document: unknown): Promise<void> {
    this.ensureConnected();
    const documentJSON = typeof document === 'string' ? document : JSON.stringify(document);
    await this.dbms!.insertDocument(collection, documentJSON);
    await this.dbms!.commit();
  }

  /** Delete a document by ID from a collection. */
  async deleteDocument(collection: string, id: string): Promise<void> {
    this.ensureConnected();
    await this.dbms!.deleteDocumentById(collection, id);
    await this.dbms!.commit();
  }

  /** Edit a single field in a document by ID. */
  async editDocument(collection: string, id: string, field: string, value: unknown): Promise<void> {
    this.ensureConnected();
    await this.dbms!.editDocument(
      collection,
      id,
      field,
      value as Parameters<SimpleDbms['editDocument']>[3],
    );
    await this.dbms!.commit();
  }

  // ── Internal helpers ─────────────────────────────────────────

  private ensureConnected(): void {
    if (!this.dbms) throw new Error('No database connected');
  }

  private async closeInternal(): Promise<void> {
    if (this.dbms) {
      await this.dbms.close();
      this.dbms = null;
      this.dataFile = null;
      this.currentFilepath = null;
    }
  }
}
