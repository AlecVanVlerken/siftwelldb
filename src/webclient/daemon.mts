// author: Alexandre-Gatien Bienfet
// date: 2025-02-17

import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SimpleDbms } from '../dbms/simpledbms.mjs';
import { SafeRealFile as RealFile } from './safe-file.mjs';

const PORT = 8000;
const FRONTEND_DIR = path.join(import.meta.dirname, 'frontend');

/**
 * Delete a file if it exists (ignores the error if not found).
 */
async function deleteIfExists(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch {
    // File doesn't exist — that's fine
  }
}

// Global database instance
let dbms: SimpleDbms | null = null;
let currentDataFile: RealFile | null = null;
let currentLogFile: RealFile | null = null;

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

/**
 * Parse JSON body from request
 */
async function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send JSON response
 */
function sendJSON(res: http.ServerResponse, statusCode: number, data: any) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Send error response
 */
function sendError(res: http.ServerResponse, statusCode: number, message: string) {
  sendJSON(res, statusCode, { error: message });
}

/**
 * Serve static files from frontend directory
 */
async function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    let filePath = req.url === '/' ? '/index.html' : req.url || '/index.html';
    
    // Remove query string
    const queryIndex = filePath.indexOf('?');
    if (queryIndex !== -1) {
      filePath = filePath.substring(0, queryIndex);
    }

    // Serve client.js from build directory (if exists) or src (if strict mode off? no browser needs JS)
    if (filePath === '/client.js') {
      // Try build directory first
      const buildPath = path.join(import.meta.dirname, '../../build/webclient/client.js');
      try {
        const content = await fs.readFile(buildPath);
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(content);
        return;
      } catch (e) {
        // Fallback or ignore
         console.log('Build file not found, trying to serve from src (might fail in browser if TS)');
      }
    }

    const fullPath = path.join(FRONTEND_DIR, filePath);
    
    // Security: prevent directory traversal
    if (!fullPath.startsWith(FRONTEND_DIR)) {
      sendError(res, 403, 'Forbidden');
      return;
    }

    const content = await fs.readFile(fullPath);
    const ext = path.extname(fullPath);
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(content);
  } catch (error) {
    sendError(res, 404, 'File not found');
  }
}

/**
 * Handle API routes
 */
async function handleAPI(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const method = req.method || 'GET';
  const pathname = url.pathname;

  try {
    // POST /api/connect
    if (method === 'POST' && pathname === '/api/connect') {
      const body = await parseBody(req);
      const { filepath } = body;

      if (!filepath) {
        sendError(res, 400, 'Missing filepath');
        return;
      }

      // Close existing connection if any
      if (dbms) {
        await dbms.close();
        dbms = null;
        currentDataFile = null;
        currentLogFile = null;
      }

      // Check if file exists to decide between open or create
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
        // Try to open existing
        try {
          dbms = await SimpleDbms.open(dataFile, logFile);
          currentDataFile = dataFile;
          currentLogFile = logFile;
          sendJSON(res, 200, { message: 'Connected to existing database', filepath });
        } catch (error) {
          console.error('Failed to open database:', error);
          sendError(res, 500, `Failed to open existing database: ${error}`);
        }
      } else {
        // Create new
        try {
          dbms = await SimpleDbms.create(dataFile, logFile);
          await dbms.commit(); // Persist initial metadata
          currentDataFile = dataFile;
          currentLogFile = logFile;
          sendJSON(res, 200, { message: 'Created new database', filepath });
        } catch (createError) {
          console.error('Failed to create database:', createError);
          sendError(res, 500, `Failed to create database: ${createError}`);
        }
      }
      return;
    }

    // POST /api/create - Force create new database (deletes existing files first)
    if (method === 'POST' && pathname === '/api/create') {
      const body = await parseBody(req);
      const { filepath } = body;

      if (!filepath) {
        sendError(res, 400, 'Missing filepath');
        return;
      }

      // Close existing connection if any
      if (dbms) {
        await dbms.close();
        dbms = null;
        currentDataFile = null;
        currentLogFile = null;
      }

      // Delete existing files so create() starts with a clean slate
      await deleteIfExists(filepath);
      await deleteIfExists(`${filepath}.log`);

      const dataFile = new RealFile(filepath);
      const logFile = new RealFile(`${filepath}.log`);

      try {
        dbms = await SimpleDbms.create(dataFile, logFile);
        await dbms.commit(); // Persist initial metadata
        currentDataFile = dataFile;
        currentLogFile = logFile;
        sendJSON(res, 200, { message: 'Created new database', filepath });
      } catch (createError) {
        console.error('Failed to create database:', createError);
        sendError(res, 500, `Failed to create database: ${createError}`);
      }
      return;
    }

    // POST /api/disconnect
    if (method === 'POST' && pathname === '/api/disconnect') {
      if (!dbms) {
        sendError(res, 400, 'No database connected');
        return;
      }

      await dbms.close();
      dbms = null;
      currentDataFile = null;
      currentLogFile = null;
      sendJSON(res, 200, { message: 'Disconnected' });
      return;
    }

    // All other endpoints require active connection
    if (!dbms) {
      sendError(res, 400, 'No database connected');
      return;
    }

    // GET /api/collections
    if (method === 'GET' && pathname === '/api/collections') {
      const collections = await dbms.getCollections();
      sendJSON(res, 200, { collections });
      return;
    }

    // POST /api/debug/reset
    if (method === 'POST' && pathname === '/api/debug/reset') {
      const filepath = currentDataFile?.filePath;
      if (!filepath) {
        sendError(res, 500, 'No filepath available');
        return;
      }

      // Close, delete files, and recreate database from scratch
      await dbms.close();
      dbms = null;

      await deleteIfExists(filepath);
      await deleteIfExists(`${filepath}.log`);

      const dataFile = new RealFile(filepath);
      const logFile = new RealFile(`${filepath}.log`);
      dbms = await SimpleDbms.create(dataFile, logFile);
      await dbms.commit();
      currentDataFile = dataFile;
      currentLogFile = logFile;

      sendJSON(res, 200, { message: 'Database reset' });
      return;
    }

    // Collection-based routes
    const collectionMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
    const documentMatch = pathname.match(/^\/api\/documents\/([^/]+)\/([^/]+)$/);
    const editMatch = pathname.match(/^\/api\/documents\/([^/]+)\/([^/]+)\/edit$/);

    // GET /api/documents/:collection
    if (method === 'GET' && collectionMatch) {
      const collection = decodeURIComponent(collectionMatch[1]);
      const iterableKey = url.searchParams.get('iterableKey') || 'id';
      const value = url.searchParams.get('value') || undefined;
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);

      const documents: string[] = [];
      const cursor = dbms.cursor(collection, iterableKey, value);

      let count = 0;
      for await (const doc of cursor) {
        documents.push(doc);
        count++;
        if (count >= limit) break;
      }

      sendJSON(res, 200, { documents });
      return;
    }

    // POST /api/documents/:collection
    if (method === 'POST' && collectionMatch) {
      const collection = decodeURIComponent(collectionMatch[1]);
      const body = await parseBody(req);
      const { document } = body;

      if (!document) {
        sendError(res, 400, 'Missing document');
        return;
      }

      const documentJSON = typeof document === 'string' ? document : JSON.stringify(document);
      await dbms.insertDocument(collection, documentJSON);
      await dbms.commit();

      sendJSON(res, 201, { message: 'Document inserted' });
      return;
    }

    // DELETE /api/documents/:collection/:id
    if (method === 'DELETE' && documentMatch) {
      const collection = decodeURIComponent(documentMatch[1]);
      const id = decodeURIComponent(documentMatch[2]);

      await dbms.deleteDocumentById(collection, id);
      await dbms.commit();

      sendJSON(res, 200, { message: 'Document deleted' });
      return;
    }

    // POST /api/documents/:collection/:id/edit
    if (method === 'POST' && editMatch) {
      const collection = decodeURIComponent(editMatch[1]);
      const id = decodeURIComponent(editMatch[2]);
      const body = await parseBody(req);
      const { field, value } = body;

      if (!field) {
        sendError(res, 400, 'Missing field');
        return;
      }

      await dbms.editDocument(collection, id, field, value);
      await dbms.commit();

      sendJSON(res, 200, { message: 'Document edited' });
      return;
    }

    // No route matched
    sendError(res, 404, 'API endpoint not found');
  } catch (error) {
    console.error('API Error:', error);
    sendError(res, 500, `Internal server error: ${error}`);
  }
}

/**
 * Main request handler
 */
async function requestHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  console.log(`${req.method} ${url.pathname}`);

  if (url.pathname.startsWith('/api/')) {
    await handleAPI(req, res, url);
  } else {
    await serveStaticFile(req, res);
  }
}

/**
 * Start server
 */
const server = http.createServer(requestHandler);

server.listen(PORT, () => {
  console.log(`SimpleDBMS Daemon running on http://localhost:${PORT}`);
  console.log(`API available at http://localhost:${PORT}/api/`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (dbms) {
    await dbms.close();
  }
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});
