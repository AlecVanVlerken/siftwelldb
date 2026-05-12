// @author Alexandre-Gatien Bienfet
// @date 2026-03-31

import 'dotenv/config';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import * as path from 'node:path';
import { DatabaseService } from './service.mjs';
import { ApiRouter } from './api.mjs';
import { ConversationalService } from './conversational-service.mjs';

const port = 8000;
const frontendDir = path.join(import.meta.dirname, 'frontend');
const srcFrontendDir = path.join(import.meta.dirname, '../../src/webclient/frontend');

// MIME types mapping
const mimeTypes: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

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

    // Serve .js files from the compiled build directory
    if (filePath.endsWith('.js')) {
      const BUILD_DIR = path.join(import.meta.dirname, '../../build/webclient');
      const buildPath = path.join(BUILD_DIR, filePath);
      if (!buildPath.startsWith(BUILD_DIR)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      try {
        const content = await fs.readFile(buildPath);
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(content);
        return;
      } catch {
        console.log(`Build file not found: ${filePath}`);
      }
    }

    // Try local frontend/ first (dev), then src/ fallback (build)
    let fullPath = path.join(frontendDir, filePath);
    if (!fullPath.startsWith(frontendDir)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    let content: Buffer;
    try {
      content = await fs.readFile(fullPath);
    } catch {
      // Fallback to source frontend directory
      fullPath = path.join(srcFrontendDir, filePath);
      if (!fullPath.startsWith(srcFrontendDir)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      content = await fs.readFile(fullPath);
    }

    const ext = path.extname(fullPath);
    const mimeType = mimeTypes[ext] ?? 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found' }));
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
  console.log(`${req.method} ${url.pathname}`);

  if (url.pathname.startsWith('/api/')) {
    void api.handle(req, res, url);
  } else {
    void serveStaticFile(req, res);
  }
}

const server = http.createServer(requestHandler);

server.listen(port, () => {
  console.log(`SimpleDBMS Daemon running on http://localhost:${port}`);
  console.log(`API available at http://localhost:${port}/api/`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  const shutdown = async () => {
    await db.disconnect();
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  };
  void shutdown();
});
