// @author Alexandre-Gatien Bienfet
// @date 2026-03-31

import 'dotenv/config';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DatabaseService } from './service.mjs';
import { ApiRouter } from './api.mjs';
import { ConversationalService } from './conversational-service.mjs';

const port = 8000;
const frontendDir = path.join(import.meta.dirname, 'frontend');
const srcFrontendDir = path.join(import.meta.dirname, '../../src/webclient/frontend');
const builtFrontendDir = path.join(process.cwd(), 'build/webclient/frontend');

// MIME types mapping for static frontend assets. Browser JavaScript is
// generated from TypeScript into build/webclient/frontend.
const mimeTypes: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.map': 'application/json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function tryReadFrom(rootDir: string, filePath: string): Promise<{ fullPath: string; content: Buffer } | null> {
  const fullPath = path.resolve(rootDir, `.${filePath}`);
  const root = path.resolve(rootDir);
  if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) {
    throw new Error('Forbidden');
  }
  try {
    return { fullPath, content: await fs.readFile(fullPath) };
  } catch {
    return null;
  }
}

// ── Static file serving ──────────────────────────────────────

/**
 * Serves a static file from the frontend directory.
 *
 * @param {http.IncomingMessage} req The HTTP request.
 * @param {http.ServerResponse} res The HTTP response object.
 * @returns {Promise<void>}
 *
 * @author Alexandre-Gatien Bienfet
 */
async function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    let filePath = req.url === '/' ? '/index.html' : (req.url ?? '/index.html');

    // Remove query string
    const queryIndex = filePath.indexOf('?');
    if (queryIndex !== -1) {
      filePath = filePath.substring(0, queryIndex);
    }

    // Source assets first, then compiled frontend TypeScript output.
    // In build output frontendDir and builtFrontendDir are usually the
    // same path; in tsx/dev runs builtFrontendDir makes /ts/*.js available.
    let found: { fullPath: string; content: Buffer } | null = null;
    for (const root of [frontendDir, builtFrontendDir, srcFrontendDir]) {
      found = await tryReadFrom(root, filePath);
      if (found) break;
    }
    if (!found) throw new Error('File not found');

    const ext = path.extname(found.fullPath);
    const mimeType = mimeTypes[ext] ?? 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(found.content);
  } catch (err) {
    const forbidden = err instanceof Error && err.message === 'Forbidden';
    res.writeHead(forbidden ? 403 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: forbidden ? 'Forbidden' : 'File not found' }));
  }
}

// ── Bootstrap ────────────────────────────────────────────────

const db = new DatabaseService();
const conv = new ConversationalService();
const api = new ApiRouter(db, conv);

/**
 * Global HTTP request handler.
 *
 * @param {http.IncomingMessage} req The HTTP request.
 * @param {http.ServerResponse} res The HTTP response object.
 *
 * @author Alexandre-Gatien Bienfet
 */
function requestHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    void api.handle(req, res, url);
  } else {
    void serveStaticFile(req, res);
  }
}

const server = http.createServer(requestHandler);

server.listen(port);

// Graceful shutdown
process.on('SIGINT', () => {
  const shutdown = async () => {
    await db.disconnect();
    server.close(() => process.exit(0));
  };
  void shutdown();
});
