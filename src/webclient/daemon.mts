// author: Alexandre-Gatien Bienfet
// date: 2026-02-23
//
// Daemon entry-point. Wires together:
//   - DatabaseService  (business logic / DBMS abstraction)
//   - ApiRouter         (HTTP route handling)
//   - Static file server

import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DatabaseService } from './service.mjs';
import { ApiRouter } from './api.mjs';

const PORT = 8000;
const FRONTEND_DIR = path.join(import.meta.dirname, 'frontend');
const SRC_FRONTEND_DIR = path.join(import.meta.dirname, '../../src/webclient/frontend');

// MIME types mapping
const MIME_TYPES: Record<string, string> = {
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
    let fullPath = path.join(FRONTEND_DIR, filePath);
    if (!fullPath.startsWith(FRONTEND_DIR)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    let content: Buffer;
    try {
      content = await fs.readFile(fullPath);
    } catch {
      // Fallback to source frontend directory
      fullPath = path.join(SRC_FRONTEND_DIR, filePath);
      if (!fullPath.startsWith(SRC_FRONTEND_DIR)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      content = await fs.readFile(fullPath);
    }

    const ext = path.extname(fullPath);
    const mimeType = MIME_TYPES[ext] ?? 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found' }));
  }
}

// ── Bootstrap ────────────────────────────────────────────────

const db = new DatabaseService();
const api = new ApiRouter(db);

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

server.listen(PORT, () => {
  console.log(`SimpleDBMS Daemon running on http://localhost:${PORT}`);
  console.log(`API available at http://localhost:${PORT}/api/`);
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
