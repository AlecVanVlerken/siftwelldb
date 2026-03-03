// author: Alexandre-Gatien Bienfet
// date: 2026-02-23
//
// ApiRouter — handles HTTP routing for /api/* endpoints.
// Delegates all database logic to DatabaseService

import * as http from 'node:http';
import { DatabaseService } from './service.mjs';

type JsonBody = Record<string, unknown>;

/**
 * Parse JSON body from an incoming HTTP request.
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
 */
function sendJSON(res: http.ServerResponse, statusCode: number, data: JsonBody): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Send an error response.
 */
function sendError(res: http.ServerResponse, statusCode: number, message: string): void {
  sendJSON(res, statusCode, { error: message });
}

/**
 * Routes API requests to the appropriate DatabaseService method.
 */
export class ApiRouter {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Handle an incoming API request.
   * Returns true if a route matched, false otherwise.
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

      // ── Collection / document routes ───────────────────────

      const collectionMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
      const documentMatch = pathname.match(/^\/api\/documents\/([^/]+)\/([^/]+)$/);
      const editMatch = pathname.match(/^\/api\/documents\/([^/]+)\/([^/]+)\/edit$/);

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
        if (document === undefined || document === null) {
          sendError(res, 400, 'Missing document');
          return;
        }
        await this.db.insertDocument(collection, document);
        sendJSON(res, 201, { message: 'Document inserted' });
        return;
      }

      // DELETE /api/documents/:collection/:id
      if (method === 'DELETE' && documentMatch) {
        const collection = decodeURIComponent(documentMatch[1]);
        const id = decodeURIComponent(documentMatch[2]);
        await this.db.deleteDocument(collection, id);
        sendJSON(res, 200, { message: 'Document deleted' });
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
