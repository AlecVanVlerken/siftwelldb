// @author Alexandre-Gatien Bienfet
// @date 2026-03-31

import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseService, DatabaseInputError } from './service.mjs';
import type { ConversationalService } from './conversational-service.mjs';
import { getEmbeddingStatus, preloadEmbeddingModels } from './clipHnswConfig.mjs';
import {
  COMPRESSION_ALGORITHMS,
  type FieldCompressionDefaults,
  type FieldCompressionOverrides,
} from '../dbms/compression.mjs';
import { isFieldValue, parseRawDocument } from '../dbms/document.mjs';

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
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        reject(new ApiHttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        const parsed: unknown = body ? JSON.parse(body) : {};
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new ApiHttpError(400, 'Request body must be a JSON object'));
          return;
        }
        resolve(parsed as JsonBody);
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

function readOffset(url: URL): number | undefined {
  const raw = url.searchParams.get('offset');
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new ApiHttpError(400, 'Invalid "offset" parameter');
  }
  return Number(raw);
}

function readCompression(value: unknown): FieldCompressionOverrides | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiHttpError(400, 'compression must be a JSON object');
  }
  for (const algorithm of Object.values(value)) {
    if (algorithm !== 'off' && !COMPRESSION_ALGORITHMS.some((candidate) => candidate === algorithm)) {
      throw new ApiHttpError(400, 'Invalid compression algorithm');
    }
  }
  return value as FieldCompressionOverrides;
}

function validateDocument(collection: string, value: unknown): void {
  try {
    parseRawDocument(collection, value);
  } catch (error) {
    throw new ApiHttpError(400, error instanceof Error ? error.message : String(error));
  }
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

  private async runDatabaseExclusive<T>(operation: string, task: () => Promise<T>): Promise<T> {
    const maybeExclusive = this.db as DatabaseService & {
      runExclusiveOperation?: <Result>(operation: string, task: () => Promise<Result>) => Promise<Result>;
    };
    if (typeof maybeExclusive.runExclusiveOperation === 'function') {
      return maybeExclusive.runExclusiveOperation(operation, task);
    }
    return task();
  }

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

      if (method === 'GET' && pathname === '/api/database/status') {
        sendJSON(res, 200, await this.db.getStatus());
        return;
      }

      // GET /api/settings — returns whether key is configured (never the key itself)
      if (method === 'GET' && pathname === '/api/settings') {
        sendJSON(res, 200, { geminiKeySet: this.conv?.llmAvailable ?? false });
        return;
      }

      // GET /api/embeddings/status — load-state of the CLIP embedding model
      if (method === 'GET' && pathname === '/api/embeddings/status') {
        sendJSON(res, 200, getEmbeddingStatus() as unknown as JsonBody);
        return;
      }

      // POST /api/embeddings/preload — kick off the requested embedding model load
      if (method === 'POST' && pathname === '/api/embeddings/preload') {
        const body = await parseBody(req);
        const kind = body['kind'];
        if (kind !== undefined && kind !== 'text' && kind !== 'image' && kind !== 'all') {
          throw new ApiHttpError(400, 'Invalid embedding model kind');
        }
        preloadEmbeddingModels(kind === 'text' || kind === 'image' || kind === 'all' ? kind : 'all');
        sendJSON(res, 200, getEmbeddingStatus() as unknown as JsonBody);
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
        if (/[\r\n]/.test(key)) throw new ApiHttpError(400, 'Invalid key');
        // Persist to .env (create or update GEMINI_API_KEY line)
        let envContent = '';
        try {
          envContent = await fs.readFile(ENV_PATH, 'utf-8');
        } catch {
          /* file may not exist */
        }
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
        if (this.conv) this.conv.onDisconnect();
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
        if (this.conv) this.conv.onDisconnect();
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

      if (method === 'POST' && pathname === '/api/database/vacuum') {
        if (this.conv) this.conv.onDisconnect();
        let result: Awaited<ReturnType<DatabaseService['vacuum']>>;
        try {
          result = await this.db.vacuum();
        } finally {
          // Vacuum replaces the backend, and a failed swap may reopen the original.
          if (this.conv && this.db.isConnected && this.db.filepath) {
            await this.conv.onConnect(this.db.filepath, this.db.rawDbms);
          }
        }
        sendJSON(res, 200, result as unknown as JsonBody);
        return;
      }

      if (method === 'POST' && pathname === '/api/database/incremental-compaction/run') {
        const incrementalCompaction = await this.db.runIncrementalCompactionStep();
        sendJSON(res, 200, { message: 'Incremental compaction step complete', incrementalCompaction });
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

      if (method === 'PUT' && pathname === '/api/compression/defaults') {
        const body = await parseBody(req);
        const collection = body['collection'];
        const defaults = body['defaults'];
        if (typeof collection !== 'string' || !collection.trim()) throw new ApiHttpError(400, 'Missing collection');
        if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
          throw new ApiHttpError(400, 'defaults must be a JSON object');
        }
        for (const [field, codec] of Object.entries(defaults)) {
          if (
            !field.trim() ||
            field === 'id' ||
            field === '_order_' ||
            field.startsWith('_layout_') ||
            !COMPRESSION_ALGORITHMS.some((candidate) => candidate === codec)
          ) {
            throw new ApiHttpError(400, 'Invalid compression defaults');
          }
        }
        await this.db.setCompressionDefaults(collection, defaults as FieldCompressionDefaults);
        sendJSON(res, 200, {
          defaults,
          message: 'Compression defaults saved',
        });
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

      // POST /api/demo/employees — seed deterministic demo data into the connected DB
      if (method === 'POST' && pathname === '/api/demo/employees') {
        const body = await parseBody(req);
        const rawCount = body['count'];
        const count = typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount > 0 ? rawCount : 200;
        const result = await this.db.seedDemoEmployees(count);
        sendJSON(res, 200, {
          message: result.skipped ? 'Demo employees already exist' : `Seeded ${result.inserted} demo employees`,
          ...result,
        });
        return;
      }

      if (method === 'POST' && pathname === '/api/demo/semantic-knowledge') {
        const result = await this.db.seedSemanticKnowledgeDemo();
        sendJSON(res, 200, {
          message: result.skipped
            ? 'Semantic knowledge demo already exists'
            : `Seeded ${result.inserted} semantic knowledge documents`,
          ...result,
        });
        return;
      }

      if (method === 'POST' && pathname === '/api/demo/semantic-images') {
        const result = await this.db.seedSemanticImageDemo();
        sendJSON(res, 200, {
          message: result.skipped
            ? 'Semantic image demo already exists'
            : `Seeded ${result.inserted} semantic image documents`,
          ...result,
        });
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
        if (this.conv) this.conv.onDisconnect();
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
        await this.db.deleteCollection(
          collection,
          this.conv ? () => this.conv!.removeCollection(collection) : undefined,
        );
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
        const limit = readLimit(url, 50, 10000);
        const offset = readOffset(url) ?? 0;
        if (!word) {
          sendError(res, 400, 'Missing word parameter');
          return;
        }
        const result = await this.db.wordSearch(collection, word, limit, offset);

        sendJSON(res, 200, result);
        return;
      }

      // GET /api/documents/:collection/contentsearch?word=...&limit=...&offset=...
      const contentSearchMatch = pathname.match(/^\/api\/documents\/([^/]+)\/contentsearch$/);
      if (method === 'GET' && contentSearchMatch) {
        const collection = decodeURIComponent(contentSearchMatch[1]);
        const word = url.searchParams.get('word') ?? '';
        const limit = readLimit(url, 50, 10000);
        const offset = readOffset(url) ?? 0;
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

        const documents = await this.db.semanticSearch(collection, query, limit);

        sendJSON(res, 200, { documents });
        return;
      }

      // GET /api/documents/:collection/search/photos
      const photoSearchMatch = pathname.match(/^\/api\/documents\/([^/]+)\/search\/photos$/);
      if (method === 'GET' && photoSearchMatch) {
        const collection = decodeURIComponent(photoSearchMatch[1]);
        const query = url.searchParams.get('q');
        const limit = readLimit(url, 10, 100);

        if (!query) {
          sendError(res, 400, 'Missing search query "q" parameter');
          return;
        }

        const documents = await this.db.semanticImageTextSearch(collection, query, limit);

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

        const documents = await this.db.semanticImageSearch(collection, imageBuffer, limit);

        sendJSON(res, 200, { documents });
        return;
      }

      // GET /api/documents/:collection?cursor=...&limit=...&iterableKey=...&sortBy=...&sortDir=asc|desc
      if (method === 'GET' && collectionMatch) {
        const collection = decodeURIComponent(collectionMatch[1]);
        const iterableKey = url.searchParams.get('iterableKey') ?? 'id';
        const cursor = url.searchParams.get('cursor') ?? undefined;
        const limit = readLimit(url, 100, 10000);
        const offset = readOffset(url);
        if (cursor !== undefined && offset !== undefined) {
          throw new ApiHttpError(400, 'Use either cursor or offset pagination');
        }
        const sortBy = url.searchParams.get('sortBy') ?? undefined;
        if (cursor !== undefined && sortBy) {
          throw new ApiHttpError(400, 'Sorted documents require offset pagination');
        }
        const sortDirRaw = url.searchParams.get('sortDir');
        if (sortDirRaw !== null && sortDirRaw !== 'asc' && sortDirRaw !== 'desc') {
          sendError(res, 400, '"sortDir" must be "asc" or "desc"');
          return;
        }
        const sortDir: 'asc' | 'desc' = sortDirRaw === 'desc' ? 'desc' : 'asc';

        const result = await this.db.getDocuments(collection, iterableKey, cursor, limit, sortBy, sortDir, offset);
        sendJSON(res, 200, result);
        return;
      }

      // POST /api/documents/:collection
      const bulkMatch = pathname.match(/^\/api\/documents\/([^/]+)\/bulk-(delete|edit)$/);
      if (method === 'POST' && bulkMatch) {
        const collection = decodeURIComponent(bulkMatch[1]);
        const body = await parseBody(req);
        const ids = body['ids'];
        const all = body['all'];
        if (
          !(
            (all === true && ids === undefined) ||
            (all === undefined &&
              Array.isArray(ids) &&
              ids.length > 0 &&
              ids.length <= 10000 &&
              ids.every((id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))))
          )
        ) {
          throw new ApiHttpError(400, 'Provide either all: true or a nonempty list of at most 10000 document IDs');
        }
        const selection = all === true ? { all: true as const } : { ids: ids as Array<string | number> };
        let edit: { field: string; value: unknown } | undefined;
        if (bulkMatch[2] === 'edit') {
          const field = body['field'];
          const value = body['value'];
          if (
            typeof field !== 'string' ||
            !field.trim() ||
            field === 'id' ||
            !(['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value)))
          ) {
            throw new ApiHttpError(400, 'Choose a non-ID field and a string, boolean or finite number value');
          }
          edit = { field, value };
        }
        sendJSON(res, 200, await this.db.mutateDocuments(collection, selection, edit));
        return;
      }

      // POST /api/documents/:collection
      if (method === 'POST' && collectionMatch) {
        const collection = decodeURIComponent(collectionMatch[1]);
        const body = await parseBody(req);
        const document = body['document'];
        const compression = readCompression(body['compression']);
        if (document === undefined || document === null) {
          sendError(res, 400, 'Missing document');
          return;
        }
        validateDocument(collection, document);
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

        sendJSON(res, 200, await this.db.getDocumentMetadata(collection, id));
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
          const compression = readCompression(body['compression']);
          validateDocument(collection, document);
          const replacementId = (document as Record<string, unknown>)['id'];
          if (String(replacementId) !== id) throw new ApiHttpError(400, 'Document id cannot be changed');
          await this.db.replaceDocument(collection, id, document, compression);
          sendJSON(res, 200, { message: 'Document replaced' });
          return;
        }
        const field = body['field'];
        const value = body['value'];
        if (typeof field !== 'string' || !field) {
          sendError(res, 400, 'Missing field (or document)');
          return;
        }
        if (!isFieldValue(value)) throw new ApiHttpError(400, 'Invalid field value');
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
          const result = await this.runDatabaseExclusive('conversational-model-generate', () =>
            this.conv!.generateModel(),
          );
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
          const model = await this.runDatabaseExclusive('conversational-model-save', () => this.conv!.saveModel(json));
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
            ? (body['history'] as unknown[]).map((entry) => {
                if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
                  throw new ApiHttpError(400, 'Invalid conversation history');
                }
                const m = entry as Record<string, unknown>;
                const role: 'user' | 'assistant' = m['role'] === 'assistant' ? 'assistant' : 'user';
                return { role, text: String(m['text']) };
              })
            : [];
          const collection =
            typeof body['collection'] === 'string' && body['collection'].length > 0 ? body['collection'] : undefined;

          const response = await this.runDatabaseExclusive('conversational-ask', () =>
            this.conv!.ask(question, history, collection),
          );

          sendJSON(res, 200, response as unknown as Record<string, unknown>);
          return;
        }

        sendError(res, 404, 'Conversational API endpoint not found');
        return;
      }

      // No route matched
      sendError(res, 404, 'API endpoint not found');
    } catch (error) {
      if (error instanceof ApiHttpError || error instanceof DatabaseInputError) {
        sendError(res, error instanceof ApiHttpError ? error.statusCode : 400, error.message);
        return;
      }
      console.error('API Error:', error);
      sendError(res, 500, `Internal server error: ${String(error)}`);
    }
  }
}
