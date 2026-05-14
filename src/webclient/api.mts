// @author Alexandre-Gatien Bienfet
// @date 2026-03-31

import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseService } from './service.mjs';
import type { ConversationalService } from './conversational-service.mjs';
import { getEmbeddingStatus, preloadClipModels } from '../conversational/clipHnswConfig.mjs';

const ENV_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.env');

type JsonBody = Record<string, unknown>;

const DEFAULT_JSON_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const IMAGE_JSON_BODY_LIMIT_BYTES = 15 * 1024 * 1024;

export class ApiHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

/**
 * Parse JSON body from an incoming HTTP request.
 *
 * @param {http.IncomingMessage} req The HTTP request.
 * @returns {Promise<JsonBody>} A promise resolving to the parsed JSON body.
 *
 * @author Alexandre-Gatien Bienfet
 */
async function parseBody(
  req: http.IncomingMessage,
  maxBytes: number = DEFAULT_JSON_BODY_LIMIT_BYTES,
): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    let body = '';
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      body += chunk.toString();
      if (Buffer.byteLength(body, 'utf-8') > maxBytes) {
        settled = true;
        reject(new ApiHttpError(413, 'Request body too large'));
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve((body ? (JSON.parse(body) as JsonBody) : {}) satisfies JsonBody);
      } catch {
        reject(new ApiHttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

export function readLimit(url: URL, defaultValue: number, maxValue: number): number {
  const raw = url.searchParams.get('limit');
  if (raw === null || raw === '') return defaultValue;
  if (!/^\d+$/.test(raw)) throw new ApiHttpError(400, 'Invalid "limit" parameter');
  const limit = Number.parseInt(raw, 10);
  if (limit < 1 || limit > maxValue) {
    throw new ApiHttpError(400, `"limit" must be between 1 and ${maxValue}`);
  }
  return limit;
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
  constructor(
    private readonly db: DatabaseService,
    private readonly conv?: ConversationalService,
  ) {}

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

      if (method === 'GET' && pathname === '/api/compression/profiles') {
        const profiles = this.db.listCompressionProfiles();
        sendJSON(res, 200, { profiles });
        return;
      }

      // GET /api/status — always available, even when disconnected
      if (method === 'GET' && pathname === '/api/status') {
        sendJSON(res, 200, { connected: this.db.isConnected, filepath: this.db.filepath });
        return;
      }

      // GET /api/settings — returns whether key is configured (never the key itself)
      if (method === 'GET' && pathname === '/api/settings') {
        sendJSON(res, 200, { geminiKeySet: this.conv?.llmAvailable ?? false });
        return;
      }

      // GET /api/embeddings/status — load-state of the CLIP embedding model
      if (method === 'GET' && pathname === '/api/embeddings/status') {
        sendJSON(res, 200, getEmbeddingStatus());
        return;
      }

      // POST /api/embeddings/preload — kick off CLIP load in the background
      if (method === 'POST' && pathname === '/api/embeddings/preload') {
        preloadClipModels();
        sendJSON(res, 200, getEmbeddingStatus());
        return;
      }

      // POST /api/settings/gemini-key — saves key to .env and updates runtime
      if (method === 'POST' && pathname === '/api/settings/gemini-key') {
        const body = await parseBody(req);
        const key = body['key'];
        if (typeof key !== 'string' || !key.trim()) {
          sendError(res, 400, 'Missing key');
          return;
        }
        // Persist to .env (create or update GEMINI_API_KEY line)
        let envContent = '';
        try { envContent = await fs.readFile(ENV_PATH, 'utf-8'); } catch { /* file may not exist */ }
        const lines = envContent.split('\n').filter(Boolean);
        const idx = lines.findIndex((l) => l.trim().startsWith('GEMINI_API_KEY='));
        if (idx >= 0) lines[idx] = `GEMINI_API_KEY=${key.trim()}`;
        else lines.push(`GEMINI_API_KEY=${key.trim()}`);
        await fs.writeFile(ENV_PATH, lines.join('\n') + '\n', 'utf-8');
        if (this.conv) this.conv.setApiKey(key.trim());
        sendJSON(res, 200, { message: 'Key saved' });
        return;
      }

      if (method === 'POST' && pathname === '/api/connect') {
        const body = await parseBody(req);
        const filepath = body['filepath'];
        if (typeof filepath !== 'string' || !filepath) {
          sendError(res, 400, 'Missing filepath');
          return;
        }
        const message = await this.db.connect(filepath);
        if (this.conv) await this.conv.onConnect(filepath, this.db.rawDbms);
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
        if (this.conv) await this.conv.onConnect(filepath, this.db.rawDbms);
        sendJSON(res, 200, { message, filepath });
        return;
      }

      if (method === 'POST' && pathname === '/api/disconnect') {
        if (!this.db.isConnected) {
          sendError(res, 400, 'No database connected');
          return;
        }
        await this.db.disconnect();
        if (this.conv) this.conv.onDisconnect();
        sendJSON(res, 200, { message: 'Disconnected' });
        return;
      }

      // ── Everything below requires an active connection ─────

      if (!this.db.isConnected) {
        sendError(res, 400, 'No database connected');
        return;
      }

      if (method === 'GET' && pathname === '/api/database/status') {
        sendJSON(res, 200, await this.db.getStatus());
        return;
      }

      if (method === 'POST' && pathname === '/api/database/vacuum') {
        const result = await this.db.vacuum();
        sendJSON(res, 200, result as unknown as JsonBody);
        return;
      }

      if (method === 'GET' && pathname === '/api/compression/defaults') {
        const collection = url.searchParams.get('collection');
        if (!collection) {
          sendError(res, 400, 'Missing collection');
          return;
        }
        const defaults = this.db.getCompressionDefaults(collection);
        sendJSON(res, 200, { defaults });
        return;
      }

      if (method === 'POST' && pathname === '/api/compression/recommendation') {
        const body = await parseBody(req);
        const collection = body['collection'];
        const field = body['field'];
        const workload = body['workload'];
        const profileOverride = body['profileOverride'];
        const draftValue = body['draftValue'];
        const sampleSize = body['sampleSize'];

        if (typeof collection !== 'string' || collection.length === 0) {
          sendError(res, 400, 'Missing collection');
          return;
        }
        if (typeof field !== 'string' || field.length === 0) {
          sendError(res, 400, 'Missing field');
          return;
        }

        const recommendation = await this.db.recommendCompression({
          collection,
          field,
          workload: typeof workload === 'number' ? workload : undefined,
          profileOverride:
            typeof profileOverride === 'string' && profileOverride.length > 0 ? profileOverride : undefined,
          sampleSize: typeof sampleSize === 'number' ? sampleSize : undefined,
          draftValue: typeof draftValue === 'string' ? draftValue : undefined,
        });
        sendJSON(res, 200, { recommendation });
        return;
      }

      if (method === 'POST' && pathname === '/api/compression/lab/seed-wiki') {
        const body = await parseBody(req);
        const count = body['count'];
        const result = await this.db.seedWikiLab({
          count: typeof count === 'number' ? count : undefined,
        });
        sendJSON(res, 200, result);
        return;
      }

      if (method === 'POST' && pathname === '/api/compression/lab/recommend-collection') {
        const body = await parseBody(req);
        const collection = body['collection'];
        const workload = body['workload'];
        const sampleSize = body['sampleSize'];

        if (typeof collection !== 'string' || collection.length === 0) {
          sendError(res, 400, 'Missing collection');
          return;
        }
        if (workload !== undefined && (typeof workload !== 'number' || workload < 0 || workload > 1)) {
          sendError(res, 400, 'Invalid workload');
          return;
        }

        const report = await this.db.recommendCollectionLab({
          collection,
          workload: typeof workload === 'number' ? workload : undefined,
          sampleSize: typeof sampleSize === 'number' ? sampleSize : undefined,
        });
        sendJSON(res, 200, { report });
        return;
      }

      if (method === 'POST' && pathname === '/api/compression/lab/apply-advice') {
        const body = await parseBody(req);
        const collection = body['collection'];
        const workload = body['workload'];
        const sampleSize = body['sampleSize'];

        if (typeof collection !== 'string' || collection.length === 0) {
          sendError(res, 400, 'Missing collection');
          return;
        }
        if (workload !== undefined && (typeof workload !== 'number' || workload < 0 || workload > 1)) {
          sendError(res, 400, 'Invalid workload');
          return;
        }

        const result = await this.db.applyCollectionLabAdvice({
          collection,
          workload: typeof workload === 'number' ? workload : undefined,
          sampleSize: typeof sampleSize === 'number' ? sampleSize : undefined,
        });
        sendJSON(res, 200, result);
        return;
      }

      // GET /api/collections
      if (method === 'GET' && pathname === '/api/collections') {
        const collections = await this.db.getCollections();
        sendJSON(res, 200, { collections });
        return;
      }

      // POST /api/query — execute a SQL-like statement (SELECT / INSERT / DELETE)
      if (method === 'POST' && pathname === '/api/query') {
        const body = await parseBody(req);
        const sql = body['sql'];
        if (typeof sql !== 'string' || !sql.trim()) {
          sendError(res, 400, 'Missing "sql" in request body');
          return;
        }
        try {
          const result = await this.db.query(sql);
          sendJSON(res, 200, {
            rows: result.rows as unknown as Record<string, unknown>[],
            rowCount: result.rowCount,
            kind: result.kind,
            elapsedMs: result.elapsedMs,
          });
        } catch (err) {
          sendError(res, 400, err instanceof Error ? err.message : String(err));
        }
        return;
      }

      // POST /api/debug/reset
      if (method === 'POST' && pathname === '/api/debug/reset') {
        const fp = this.db.filepath;
        await this.db.reset();
        if (this.conv && fp) await this.conv.onConnect(fp, this.db.rawDbms);
        sendJSON(res, 200, { message: 'Database reset' });
        return;
      }

      if (method === 'POST' && pathname === '/api/database/incremental-compaction/settings') {
        const body = await parseBody(req);
        const enabled = body['enabled'];
        if (typeof enabled !== 'boolean') {
          sendError(res, 400, 'Missing boolean enabled');
          return;
        }
        const incrementalCompaction = this.db.setIncrementalCompactionEnabled(enabled);
        sendJSON(res, 200, { message: 'Incremental compaction settings updated', incrementalCompaction });
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

      // GET /api/documents/:collection/wordsearch?word=...&limit=...&offset=...
      const wordSearchMatch = pathname.match(/^\/api\/documents\/([^/]+)\/wordsearch$/);
      if (method === 'GET' && wordSearchMatch) {
        const collection = decodeURIComponent(wordSearchMatch[1]);
        const word = url.searchParams.get('word') ?? '';
        const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
        const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
        if (!word) {
          sendError(res, 400, 'Missing word parameter');
          return;
        }
        const result = await this.db.wordSearch(collection, word, limit, offset);
        console.log(`[wordsearch] word="${word}" → ${result.documents.length} docs, total=${result.total}`);
        sendJSON(res, 200, result);
        return;
      }

      // GET /api/documents/:collection/contentsearch?word=...&limit=...&offset=...
      const contentSearchMatch = pathname.match(/^\/api\/documents\/([^/]+)\/contentsearch$/);
      if (method === 'GET' && contentSearchMatch) {
        const collection = decodeURIComponent(contentSearchMatch[1]);
        const word = url.searchParams.get('word') ?? '';
        const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
        const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
        if (!word) {
          sendError(res, 400, 'Missing word parameter');
          return;
        }
        const result = await this.db.contentSearch(collection, word, limit, offset);
        sendJSON(res, 200, result);
        return;
      }

      // GET /api/documents/:collection/search
      const searchMatch = pathname.match(/^\/api\/documents\/([^/]+)\/search$/);
      if (method === 'GET' && searchMatch) {
        const collection = decodeURIComponent(searchMatch[1]);
        const query = url.searchParams.get('q');
        const limit = readLimit(url, 10, 100);

        if (!query) {
          sendError(res, 400, 'Missing search query "q" parameter');
          return;
        }

        console.log(`Semantic text search: collection=${collection}, limit=${limit}`);
        const documents = await this.db.semanticSearch(collection, query, limit);
        console.log(`Semantic text search complete: ${documents.length} result(s)`);
        sendJSON(res, 200, { documents });
        return;
      }

      // POST /api/documents/:collection/search/image
      const searchImageMatch = pathname.match(/^\/api\/documents\/([^/]+)\/search\/image$/);
      if (method === 'POST' && searchImageMatch) {
        const collection = decodeURIComponent(searchImageMatch[1]);
        const limit = readLimit(url, 10, 100);
        const body = await parseBody(req, IMAGE_JSON_BODY_LIMIT_BYTES);
        const base64Image = body['image'];

        if (typeof base64Image !== 'string' || !base64Image) {
          sendError(res, 400, 'Missing base64 "image" in request body');
          return;
        }

        const imageBuffer = Buffer.from(base64Image, 'base64');
        console.log(`Semantic image search: collection=${collection}, limit=${limit}`);
        const documents = await this.db.semanticImageSearch(collection, imageBuffer, limit);
        console.log(`Semantic image search complete: ${documents.length} result(s)`);
        sendJSON(res, 200, { documents });
        return;
      }

      // GET /api/documents/:collection?cursor=...&limit=...&iterableKey=...
      if (method === 'GET' && collectionMatch) {
        const collection = decodeURIComponent(collectionMatch[1]);
        const iterableKey = url.searchParams.get('iterableKey') ?? 'id';
        const cursor = url.searchParams.get('cursor') ?? undefined;
        const limit = readLimit(url, 100, 10000);

        const result = await this.db.getDocuments(collection, iterableKey, cursor, limit);
        sendJSON(res, 200, result);
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

        // Accurate on-disk reservation: chainLength × blockSize.
        const storedSize = await this.db.getDocumentStoredBytes(collection, id);
        const blockSize = this.db.rawDbms.getBlockSize();

        // Compression algorithms in use per field, surfaced from the
        // encoded payload (informational; doesn't affect storedSize).
        const encodedStr = await this.db.getDocumentById(collection, id, { encoded: true });
        const encodedDoc = JSON.parse(encodedStr) as Record<string, unknown>;
        const compressions: Record<string, string> = {};
        for (const [key, val] of Object.entries(encodedDoc)) {
          if (key === 'id') continue;
          if (typeof val === 'object' && val !== null && 'payloadBase64' in val) {
            const encodedField = val as { compression?: string };
            if (encodedField.compression && encodedField.compression !== 'none') {
              compressions[key] = encodedField.compression;
            }
          }
        }

        sendJSON(res, 200, { storedSize, blockSize, compressions });
        return;
      }

      // GET /api/collections/:collection/storage
      const storageMatch = pathname.match(/^\/api\/collections\/([^/]+)\/storage$/);
      if (method === 'GET' && storageMatch) {
        const collection = decodeURIComponent(storageMatch[1]);
        const storage = await this.db.getCollectionStorage(collection);
        sendJSON(res, 200, storage);
        return;
      }

      // POST /api/documents/:collection/:id/edit
      //
      // Two body shapes:
      //   { document: {...} }       → whole-document replace (preferred)
      //   { field: ..., value: ... } → legacy single-field edit (kept for callers)
      if (method === 'POST' && editMatch) {
        const collection = decodeURIComponent(editMatch[1]);
        const id = decodeURIComponent(editMatch[2]);
        const body = await parseBody(req);
        const document = body['document'];
        if (document !== undefined) {
          if (document === null || typeof document !== 'object' || Array.isArray(document)) {
            sendError(res, 400, 'document must be a JSON object');
            return;
          }
          await this.db.replaceDocument(collection, id, document);
          sendJSON(res, 200, { message: 'Document replaced' });
          return;
        }
        const field = body['field'];
        const value = body['value'];
        if (typeof field !== 'string' || !field) {
          sendError(res, 400, 'Missing field (or document)');
          return;
        }
        await this.db.editDocument(collection, id, field, value);
        sendJSON(res, 200, { message: 'Document edited' });
        return;
      }

      // ── Conversational routes ──────────────────────────────
      // All under /api/conversational/

      if (pathname.startsWith('/api/conversational/')) {
        if (!this.conv) {
          sendError(res, 503, 'Conversational features are not available');
          return;
        }

        // GET /api/conversational/model
        if (method === 'GET' && pathname === '/api/conversational/model') {
          sendJSON(res, 200, {
            model: this.conv.getModel(),
            llmAvailable: this.conv.llmAvailable,
          });
          return;
        }

        // GET /api/conversational/model/collection/:name
        const collModelMatch = pathname.match(/^\/api\/conversational\/model\/collection\/([^/]+)$/);
        if (method === 'GET' && collModelMatch) {
          const collection = decodeURIComponent(collModelMatch[1]);
          sendJSON(res, 200, { hasModel: this.conv.hasExploreForCollection(collection) });
          return;
        }

        // POST /api/conversational/model/generate
        // Always available — even without a Gemini key, a basic
        // introspected model can be produced from the data alone.
        // `enriched` in the response tells the client whether the LLM
        // contributed descriptions / synonyms / measures.
        if (method === 'POST' && pathname === '/api/conversational/model/generate') {
          const result = await this.conv.generateModel();
          sendJSON(res, 200, { model: result.model, enriched: result.enriched });
          return;
        }

        // PUT /api/conversational/model
        if (method === 'PUT' && pathname === '/api/conversational/model') {
          const body = await parseBody(req);
          const json = body['model'];
          if (typeof json !== 'string' || !json) {
            sendError(res, 400, 'Missing "model" string in request body');
            return;
          }
          const model = await this.conv.saveModel(json);
          sendJSON(res, 200, { model });
          return;
        }

        // POST /api/conversational/ask
        if (method === 'POST' && pathname === '/api/conversational/ask') {
          const body = await parseBody(req);
          const question = body['question'];
          if (typeof question !== 'string' || !question.trim()) {
            sendError(res, 400, 'Missing "question" in request body');
            return;
          }
          const history = Array.isArray(body['history'])
            ? (body['history'] as { role: string; text: string }[]).map((m) => {
                const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
                return { role, text: String(m.text) };
              })
            : [];
          console.log(`Conversational ask: ${question.slice(0, 120)}`);
          const response = await this.conv.ask(question, history);
          console.log('Conversational ask complete');
          sendJSON(res, 200, response as unknown as Record<string, unknown>);
          return;
        }

        sendError(res, 404, 'Conversational API endpoint not found');
        return;
      }

      // No route matched
      sendError(res, 404, 'API endpoint not found');
    } catch (error) {
      if (error instanceof ApiHttpError) {
        sendError(res, error.statusCode, error.message);
        return;
      }
      console.error('API Error:', error);
      sendError(res, 500, `Internal server error: ${String(error)}`);
    }
  }
}
