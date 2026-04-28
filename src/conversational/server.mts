#!/usr/bin/env node
/**
 * Web server for the Conversational Analytics UI.
 *
 * Uses only Node built-ins (no Express) to avoid CJS/ESM interop issues.
 * Serves the single-page web app and exposes a REST API.
 *
 * Usage:
 *   npx tsx src/conversational/server.mts [--port 3000]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RealFile } from '../core/file.mjs';
import { SimpleDbms } from '../dbms/simpledbms.mjs';
import { QueryLanguage } from '../dbms/querylanguage/querylanguage.mjs';
import { GeminiProvider } from './llmProvider.mjs';
import { ConversationalEngine } from './conversationalEngine.mjs';
import {
  generateSemanticModel,
  loadSemanticModel,
  parseSemanticModel,
  type SemanticModel,
} from './semanticModel.mjs';
import { generateEmployees } from './seedData.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_DIR = path.join(__dirname, '../../converse-db');
const DATA_PATH = path.join(DB_DIR, 'employees.data');
const LOG_PATH = path.join(DB_DIR, 'employees.log');
const MODEL_PATH = path.join(DB_DIR, 'model.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(__dirname, '../../.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, msg: string, status = 400) {
  json(res, { error: msg }, status);
}

function serveFile(res: http.ServerResponse, filePath: string) {
  const ext = path.extname(filePath);
  const mime: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': mime[ext] ?? 'application/octet-stream' });
  res.end(content);
}

// ── State ────────────────────────────────────────────────────────────────────

let db: SimpleDbms;
let ql: QueryLanguage;
let semanticModel: SemanticModel;
let engine: ConversationalEngine;
let apiKey: string;

function rebuildEngine() {
  const llm = new GeminiProvider(apiKey);
  engine = new ConversationalEngine({ dbms: db, llmProvider: llm, semanticModel });
}

function enrichModel(model: SemanticModel) {
  const empExplore = model.explores.find((e) => e.collection === 'employees');
  if (!empExplore) return;
  empExplore.description = 'Employee records including salary, department, seniority, gender, and location data';
  const enrichments: Record<string, { description?: string; synonyms?: string[] }> = {
    salary: { description: 'Gross annual salary in EUR', synonyms: ['pay', 'wage', 'compensation', 'income', 'earnings'] },
    department: { description: 'Department the employee belongs to', synonyms: ['dept', 'team', 'division'] },
    name: { description: "Employee's full name", synonyms: ['employee', 'person', 'worker'] },
    city: { description: 'City where the employee is based', synonyms: ['location', 'office'] },
    age: { description: "Employee's age in years" },
    gender: { description: "Employee's gender (M or F)", synonyms: ['sex'] },
    seniority: { description: 'Seniority level: Junior, Mid, Senior, Lead, or Principal', synonyms: ['level', 'rank', 'experience'] },
    yearsAtCompany: { description: 'Number of years employed at the company', synonyms: ['tenure', 'years employed'] },
  };
  for (const f of empExplore.fields) {
    const e = enrichments[f.name];
    if (e) {
      if (e.description) f.description = e.description;
      if (e.synonyms) f.synonyms = e.synonyms;
    }
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const method = req.method ?? 'GET';
  const p = url.pathname;

  try {
    // ── Static files ───────────────────────────────────────────────────────
    if (method === 'GET' && !p.startsWith('/api/')) {
      const file = p === '/' ? 'index.html' : p.slice(1);
      const filePath = path.join(PUBLIC_DIR, file);
      if (fs.existsSync(filePath)) return serveFile(res, filePath);
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }

    // ── GET /api/collections ───────────────────────────────────────────────
    if (p === '/api/collections' && method === 'GET') {
      return json(res, { collections: db.listCollections() });
    }

    // ── GET /api/collections/:name ─────────────────────────────────────────
    const collGet = p.match(/^\/api\/collections\/([^/]+)$/);
    if (collGet && method === 'GET') {
      const name = decodeURIComponent(collGet[1]);
      try {
        const rows = await ql.execute(`SELECT * FROM ${name}`);
        const schema = db.describeCollection(name);
        return json(res, { collection: name, schema, rows });
      } catch (err) {
        return error(res, err instanceof Error ? err.message : String(err), 404);
      }
    }

    // ── POST /api/collections/:name (insert) ──────────────────────────────
    if (collGet && method === 'POST') {
      const name = decodeURIComponent(collGet[1]);
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const docJson = JSON.stringify(body);
      await db.insertDocument(name, docJson);
      await db.commit();
      return json(res, { ok: true });
    }

    // ── PUT /api/collections/:name/:id (edit) ─────────────────────────────
    const docMatch = p.match(/^\/api\/collections\/([^/]+)\/([^/]+)$/);
    if (docMatch && method === 'PUT') {
      const name = decodeURIComponent(docMatch[1]);
      const id = decodeURIComponent(docMatch[2]);
      const body = JSON.parse(await readBody(req)) as { field: string; value: string | number | boolean };
      await db.editDocument(name, id, body.field, body.value);
      await db.commit();
      return json(res, { ok: true });
    }

    // ── DELETE /api/collections/:name/:id ──────────────────────────────────
    if (docMatch && method === 'DELETE') {
      const name = decodeURIComponent(docMatch[1]);
      const id = decodeURIComponent(docMatch[2]);
      await db.deleteDocumentById(name, id);
      await db.commit();
      return json(res, { ok: true });
    }

    // ── POST /api/query ────────────────────────────────────────────────────
    if (p === '/api/query' && method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { query: string };
      const rows = await ql.execute(body.query);
      await db.commit();
      return json(res, { rows });
    }

    // ── POST /api/ask ──────────────────────────────────────────────────────
    if (p === '/api/ask' && method === 'POST') {
      const body = JSON.parse(await readBody(req)) as {
        question: string;
        history?: { role: 'user' | 'assistant'; text: string }[];
      };
      const result = await engine.ask(body.question, body.history);
      return json(res, result);
    }

    // ── GET /api/model ─────────────────────────────────────────────────────
    if (p === '/api/model' && method === 'GET') {
      return json(res, semanticModel);
    }

    // ── PUT /api/model ─────────────────────────────────────────────────────
    if (p === '/api/model' && method === 'PUT') {
      const body = await readBody(req);
      semanticModel = parseSemanticModel(body);
      fs.writeFileSync(MODEL_PATH, JSON.stringify(semanticModel, null, 2));
      rebuildEngine();
      return json(res, { ok: true });
    }

    // ── POST /api/model/generate ───────────────────────────────────────────
    if (p === '/api/model/generate' && method === 'POST') {
      semanticModel = await generateSemanticModel(db);
      enrichModel(semanticModel);
      fs.writeFileSync(MODEL_PATH, JSON.stringify(semanticModel, null, 2));
      rebuildEngine();
      return json(res, semanticModel);
    }

    // ── GET /api/schema ────────────────────────────────────────────────────
    if (p === '/api/schema' && method === 'GET') {
      const collections = db.listCollections();
      const schema = collections.map((c) => ({ collection: c, fields: db.describeCollection(c) }));
      return json(res, { schema });
    }

    error(res, 'Not found', 404);
  } catch (err) {
    console.error('Request error:', err);
    error(res, err instanceof Error ? err.message : 'Internal server error', 500);
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function main() {
  loadEnv();
  apiKey = process.env['GEMINI_API_KEY'] ?? '';
  if (!apiKey) {
    console.error('Error: Set GEMINI_API_KEY in .env or environment.');
    process.exit(1);
  }

  const port = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') ?? '3000', 10);

  // Ensure DB directory exists
  fs.mkdirSync(DB_DIR, { recursive: true });

  // Open or create+seed the database
  if (!fs.existsSync(DATA_PATH)) {
    console.log('Creating and seeding database...');
    db = await SimpleDbms.create(new RealFile(DATA_PATH), new RealFile(LOG_PATH));
    ql = new QueryLanguage(db);
    const employees = generateEmployees(200);
    for (const emp of employees) {
      const doc = JSON.stringify(emp);
      await db.insertDocument('employees', doc);
    }
    await db.commit();
    console.log(`Seeded ${employees.length} employees.`);
  } else {
    if (!fs.existsSync(LOG_PATH)) fs.closeSync(fs.openSync(LOG_PATH, 'w'));
    db = await SimpleDbms.open(new RealFile(DATA_PATH), new RealFile(LOG_PATH));
    ql = new QueryLanguage(db);
    console.log('Opened existing database.');
  }

  // Load or generate semantic model
  if (fs.existsSync(MODEL_PATH)) {
    semanticModel = loadSemanticModel(MODEL_PATH);
    console.log('Loaded semantic model from disk.');
  } else {
    semanticModel = await generateSemanticModel(db);
    enrichModel(semanticModel);
    fs.writeFileSync(MODEL_PATH, JSON.stringify(semanticModel, null, 2));
    console.log('Auto-generated semantic model.');
  }

  rebuildEngine();

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${port} is already in use. Either stop the other process or use --port <number>.\n`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`\n  Conversational Analytics running at http://localhost:${port}\n`);
  });

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
