// @author Alexandre-Gatien Bienfet
// @date 2026-03-31

import * as http from 'node:http';
import { DatabaseService } from './service.mjs';

type JsonBody = Record<string, unknown>;

/**
 * Parse JSON body from an incoming HTTP request.
 *
 * @param {http.IncomingMessage} req The HTTP request.
 * @returns {Promise<JsonBody>} A promise resolving to the parsed JSON body.
 *
 * @author Alexandre-Gatien Bienfet
 */
async function parseBody(req: http.IncomingMessage): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve((body ? (JSON.parse(body) as JsonBody) : {}) satisfies JsonBody);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send a JSON response.
 *
 * @param {http.ServerResponse} res The HTTP response object.
 * @param {number} statusCode The HTTP status code.
 * @param {JsonBody} data The JSON data to send.
 *
 * @author Alexandre-Gatien Bienfet
 */
function sendJSON(res: http.ServerResponse, statusCode: number, data: JsonBody): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Send an error response.
 *
 * @param {http.ServerResponse} res The HTTP response object.
 * @param {number} statusCode The HTTP status code.
 * @param {string} message The error message to send.
 *
 * @author Alexandre-Gatien Bienfet
 */
function sendError(res: http.ServerResponse, statusCode: number, message: string): void {
  sendJSON(res, statusCode, { error: message });
}

/**
 * Routes API requests to the appropriate DatabaseService method.
 *
 * @author Alexandre-Gatien Bienfet
 */
export class ApiRouter {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Handle an incoming API request.
   *
   * @param {http.IncomingMessage} req The HTTP request.
   * @param {http.ServerResponse} res The HTTP response object.
   * @param {URL} url The request URL.
   * @returns {Promise<void>}
   *
   * @author Alexandre-Gatien Bienfet
   */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const pathname = url.pathname;

    try {
      // ── Connection management ──────────────────────────────

      if (method === 'POST' && pathname === '/api/connect') {
        const body = await parseBody(req);
        const filepath = body['filepath'];
        if (typeof filepath !== 'string' || !filepath) {
          sendError(res, 400, 'Missing filepath');
          return;
        }
        const message = await this.db.connect(filepath);
        sendJSON(res, 200, { message, filepath });
        return;
      }

      if (method === 'POST' && pathname === '/api/create') {
        const body = await parseBody(req);
        const filepath = body['filepath'];
        if (typeof filepath !== 'string' || !filepath) {
          sendError(res, 400, 'Missing filepath');
          return;
        }
        const message = await this.db.create(filepath);
        sendJSON(res, 200, { message, filepath });
        return;
      }

      if (method === 'POST' && pathname === '/api/disconnect') {
        if (!this.db.isConnected) {
          sendError(res, 400, 'No database connected');
          return;
        }
        await this.db.disconnect();
        sendJSON(res, 200, { message: 'Disconnected' });
        return;
      }

      // ── Everything below requires an active connection ─────

      if (method === 'GET' && pathname === '/api/database/status') {
        sendJSON(res, 200, await this.db.getStatus());
        return;
      }

      if (!this.db.isConnected) {
        sendError(res, 400, 'No database connected');
        return;
      }

      // GET /api/collections
      if (method === 'GET' && pathname === '/api/collections') {
        const collections = await this.db.getCollections();
        sendJSON(res, 200, { collections });
        return;
      }

      // POST /api/debug/reset
      if (method === 'POST' && pathname === '/api/debug/reset') {
        await this.db.reset();
        sendJSON(res, 200, { message: 'Database reset' });
        return;
      }

      if (method === 'POST' && pathname === '/api/database/vacuum') {
        const result = await this.db.vacuum();
        sendJSON(res, 200, { message: 'Database compacted', ...result });
        return;
      }

      // DELETE /api/collections/:collection
      const collectionDeleteMatch = pathname.match(/^\/api\/collections\/([^/]+)$/);
      if (method === 'DELETE' && collectionDeleteMatch) {
        const collection = decodeURIComponent(collectionDeleteMatch[1]);
        await this.db.deleteCollection(collection);
        sendJSON(res, 200, { message: `Collection "${collection}" deleted` });
        return;
      }

      // ── Collection / document routes ───────────────────────

      const collectionMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
      const documentMatch = pathname.match(/^\/api\/documents\/([^/]+)\/([^/]+)$/);
      const editMatch = pathname.match(/^\/api\/documents\/([^/]+)\/([^/]+)\/edit$/);

      // GET /api/documents/:collection/search
      const searchMatch = pathname.match(/^\/api\/documents\/([^/]+)\/search$/);
      if (method === 'GET' && searchMatch) {
        const collection = decodeURIComponent(searchMatch[1]);
        const query = url.searchParams.get('q');
        const limit = parseInt(url.searchParams.get('limit') ?? '10', 10);

        if (!query) {
          sendError(res, 400, 'Missing search query "q" parameter');
          return;
        }

        const documents = await this.db.semanticSearch(collection, query, limit);
        sendJSON(res, 200, { documents });
        return;
      }

      // POST /api/documents/:collection/search/image
      const searchImageMatch = pathname.match(/^\/api\/documents\/([^/]+)\/search\/image$/);
      if (method === 'POST' && searchImageMatch) {
        const collection = decodeURIComponent(searchImageMatch[1]);
        const limit = parseInt(url.searchParams.get('limit') ?? '10', 10);
        const body = await parseBody(req);
        const base64Image = body['image'];

        if (typeof base64Image !== 'string' || !base64Image) {
          sendError(res, 400, 'Missing base64 "image" in request body');
          return;
        }

        const imageBuffer = Buffer.from(base64Image, 'base64');
        const documents = await this.db.semanticImageSearch(collection, imageBuffer, limit);
        sendJSON(res, 200, { documents });
        return;
      }

      // GET /api/documents/:collection
      if (method === 'GET' && collectionMatch) {
        const collection = decodeURIComponent(collectionMatch[1]);
        const iterableKey = url.searchParams.get('iterableKey') ?? 'id';
        const rawValue = url.searchParams.get('value');
        const value = rawValue ?? undefined;
        const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);

        const documents = await this.db.getDocuments(collection, iterableKey, value, limit);
        sendJSON(res, 200, { documents });
        return;
      }

      // POST /api/documents/:collection
      if (method === 'POST' && collectionMatch) {
        const collection = decodeURIComponent(collectionMatch[1]);
        const body = await parseBody(req);
        const document = body['document'];
        const compression = body['compression'] as
          | import('../dbms/compression.mts').FieldCompressionOverrides
          | undefined;
        if (document === undefined || document === null) {
          sendError(res, 400, 'Missing document');
          return;
        }
        await this.db.insertDocument(collection, document, compression);
        sendJSON(res, 201, { message: 'Document inserted' });
        return;
      }

      // DELETE /api/documents/:collection/:id
      if (method === 'DELETE' && documentMatch && !pathname.endsWith('/metadata') && !pathname.endsWith('/edit')) {
        const collection = decodeURIComponent(documentMatch[1]);
        const id = decodeURIComponent(documentMatch[2]);
        await this.db.deleteDocument(collection, id);
        sendJSON(res, 200, { message: 'Document deleted' });
        return;
      }

      // GET /api/documents/:collection/:id/metadata
      const metaMatch = pathname.match(/^\/api\/documents\/([^/]+)\/([^/]+)\/metadata$/);
      if (method === 'GET' && metaMatch) {
        const collection = decodeURIComponent(metaMatch[1]);
        const id = decodeURIComponent(metaMatch[2]);
        const encodedStr = await this.db.getDocumentById(collection, id, { encoded: true });
        const encodedDoc = JSON.parse(encodedStr) as Record<string, unknown>;

        let totalPayloadSize = 0;
        const compressions: Record<string, string> = {};
        for (const [key, val] of Object.entries(encodedDoc)) {
          if (key === 'id') {
            totalPayloadSize += Buffer.from(String(val)).length;
            continue;
          }
          if (typeof val === 'object' && val !== null && 'payloadBase64' in val) {
            const encodedField = val as { payloadBase64?: string; compression?: string };
            if (encodedField.payloadBase64) {
              const payloadLen = Buffer.from(encodedField.payloadBase64, 'base64').length;
              totalPayloadSize += payloadLen;
            }
            if (encodedField.compression && encodedField.compression !== 'none') {
              compressions[key] = encodedField.compression;
            }
          }
        }

        sendJSON(res, 200, { storedSize: totalPayloadSize, compressions });
        return;
      }

      // POST /api/documents/:collection/:id/edit
      if (method === 'POST' && editMatch) {
        const collection = decodeURIComponent(editMatch[1]);
        const id = decodeURIComponent(editMatch[2]);
        const body = await parseBody(req);
        const field = body['field'];
        const value = body['value'];
        if (typeof field !== 'string' || !field) {
          sendError(res, 400, 'Missing field');
          return;
        }
        await this.db.editDocument(collection, id, field, value);
        sendJSON(res, 200, { message: 'Document edited' });
        return;
      }

      // No route matched
      sendError(res, 404, 'API endpoint not found');
    } catch (error) {
      console.error('API Error:', error);
      sendError(res, 500, `Internal server error: ${String(error)}`);
    }
  }
}
