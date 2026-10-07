import type { SimpleDbms } from '../../src/database/simpledbms.mjs';

export type RawDocument = Record<string, unknown>;

/**
 * Reads all documents from a collection into a plain array.
 * Uses the cursor() API to iterate over every document sorted by id.
 */
export async function collectDocuments(db: SimpleDbms, collection: string): Promise<RawDocument[]> {
  const documents: RawDocument[] = [];

  for await (const docJSON of db.cursor(collection, 'id')) {
    documents.push(JSON.parse(docJSON) as RawDocument);
  }

  return documents;
}
