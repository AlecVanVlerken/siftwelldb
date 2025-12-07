import { DbmsBack } from './dbmsback.mjs';
import { type File } from '../core/file.mjs';
import { documentToJSON } from './document.mjs';
import { JSONtoDocument } from './document.mjs';

export class SimpleDbms {
  private dbmsback: DbmsBack;

  private constructor(dbmsback: DbmsBack) {
    this.dbmsback = dbmsback;
  }

  static async create(dataFile: File, logFile: File): Promise<SimpleDbms> {
    const dbmsback = new DbmsBack(dataFile, logFile);
    await dbmsback.create();
    return new SimpleDbms(dbmsback);
  }

  static async open(dataFile: File, logFile: File): Promise<SimpleDbms> {
    const dbmsback = await DbmsBack.open(dataFile, logFile);
    return new SimpleDbms(dbmsback);
  }

  async reopen(datafile: File, logfile: File): Promise<void> {
    const dbmsback = await DbmsBack.open(datafile, logfile);
    this.dbmsback = dbmsback;
  }
  async close(): Promise<void> {
    await this.dbmsback.close();
  }

  async insertDocument(collection: string, documentJSON: string): Promise<void> {
    const documentObj = JSONtoDocument(documentJSON, collection);
    return this.dbmsback.insertDocument(documentObj);
  }

  async getDocumentById(collection: string, id: string): Promise<string> {
    const document = await this.dbmsback.getDocument(id, collection);
    return documentToJSON(document);
  }
  async deleteDocumentById(collection: string, id: string): Promise<void> {
    return this.dbmsback.deleteDocument(id, collection);
  }

  cursor(collection: string, iterableKey: string, value?: string | number | Buffer): AsyncIterable<string> {
    const backendCursorPromise = this.dbmsback.cursor(collection, iterableKey, value);

    // The returned object implements AsyncIterable<string>
    return {
      async *[Symbol.asyncIterator]() {
        const backendCursor = await backendCursorPromise;

        for await (const document of backendCursor) {
          yield documentToJSON(document);
        }
      },
    };
  }

  async commit(): Promise<void> {
    await this.dbmsback.commit();
  }
}
