import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRouter } from '../api.mjs';
import { ConversationalService } from '../conversational-service.mjs';
import { DatabaseService } from '../service.mjs';

type HttpResult = { status: number; body: Record<string, unknown> };

describe('managed database catalogue over HTTP', () => {
  let directory: string;
  let databaseDirectory: string;
  let service: DatabaseService;
  let conversational: ConversationalService;
  let server: http.Server | undefined;
  let origin: string;

  beforeEach(async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    directory = await fs.mkdtemp(path.join(tmpdir(), 'siftwell-database-catalog-api-'));
    databaseDirectory = path.join(directory, 'databases');
    service = new DatabaseService({
      databaseDirectory,
      hnswConfig: {
        dimension: 2,
        M: 4,
        efConstruction: 16,
        efSearch: 16,
        embeddingFn: () => Promise.resolve(new Float32Array([1, 0])),
      },
    });
    conversational = new ConversationalService();
    const router = new ApiRouter(service, conversational);
    server = http.createServer((req, res) => {
      void router.handle(req, res, new URL(req.url ?? '/', 'http://localhost'));
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback HTTP listener');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
      server = undefined;
    }
    conversational?.onDisconnect();
    await service?.disconnect();
    vi.unstubAllEnvs();
    const target = path.resolve(directory);
    if (!target.startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error('Unexpected test directory');
    await fs.rm(target, { recursive: true, force: true });
  });

  async function request(method: string, route: string, body?: Record<string, unknown>): Promise<HttpResult> {
    const response = await fetch(`${origin}${route}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function createWithDocument(): Promise<void> {
    expect((await request('POST', '/api/create', { name: 'notes' })).status).toBe(200);
    const response = await request('POST', '/api/documents?collection=%22notes%22', {
      document: { id: 7, title: 'Keep this document', count: 3 },
    });
    expect(response.status).toBe(201);
  }

  async function expectOriginalDocument(): Promise<void> {
    const result = await request('GET', '/api/document?collection=%22notes%22&id=7');
    expect(result).toEqual({
      status: 200,
      body: { document: { id: 7, title: 'Keep this document', count: 3 } },
    });
  }

  function expectClientError(result: HttpResult): void {
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
    expect(result.body['error']).toEqual(expect.any(String));
  }

  it('creates a named pair, lists it and reopens its persisted documents and schema', async () => {
    expect(await request('GET', '/api/databases')).toEqual({ status: 200, body: { databases: [] } });
    await createWithDocument();
    const filepath = path.join(databaseDirectory, 'notes.db');
    expect(service.filepath).toBe(filepath);
    expect((await fs.stat(filepath)).isFile()).toBe(true);
    expect((await fs.stat(`${filepath}.log`)).isFile()).toBe(true);

    const generated = await request('POST', '/api/conversational/model/generate');
    expect(generated.status).toBe(200);
    expect(generated.body['enriched']).toBe(false);
    const model = generated.body['model'];
    expect(JSON.parse(await fs.readFile(`${filepath}.model.json`, 'utf8'))).toEqual(model);
    expect(await request('GET', '/api/databases')).toEqual({
      status: 200,
      body: { databases: [{ name: 'notes', filename: 'notes.db' }] },
    });

    expect((await request('POST', '/api/disconnect')).status).toBe(200);
    expect((await request('GET', '/api/status')).body['connected']).toBe(false);
    expect((await request('POST', '/api/connect', { name: 'notes' })).status).toBe(200);
    await expectOriginalDocument();
    expect((await request('GET', '/api/conversational/model')).body['model']).toEqual(model);
    expect((await fs.readdir(databaseDirectory)).sort()).toEqual(['notes.db', 'notes.db.log', 'notes.db.model.json']);
  });

  it('lists only database files rather than their companions, unrelated files or directories', async () => {
    expect((await request('POST', '/api/create', { name: 'zeta' })).status).toBe(200);
    expect((await request('POST', '/api/create', { name: 'alpha' })).status).toBe(200);
    await fs.writeFile(path.join(databaseDirectory, 'README.txt'), 'Not a database');
    await fs.writeFile(path.join(databaseDirectory, 'orphan.db.log'), 'Recovery evidence');
    await fs.mkdir(path.join(databaseDirectory, 'directory.db'));
    const response = await request('GET', '/api/databases');
    expect(response.status).toBe(200);
    expect(response.body['databases']).toEqual([
      { name: 'alpha', filename: 'alpha.db' },
      { name: 'zeta', filename: 'zeta.db' },
    ]);
  });

  it('rejects duplicate creation without erasing data or detaching the conversational model', async () => {
    await createWithDocument();
    const generated = await request('POST', '/api/conversational/model/generate');
    expect(generated.status).toBe(200);
    const filepath = path.join(databaseDirectory, 'notes.db');
    const before = await Promise.all([fs.readFile(filepath), fs.readFile(`${filepath}.log`)]);
    expectClientError(await request('POST', '/api/create', { name: 'notes' }));
    expect(await Promise.all([fs.readFile(filepath), fs.readFile(`${filepath}.log`)])).toEqual(before);
    expect(service.filepath).toBe(filepath);
    await expectOriginalDocument();
    expect((await request('GET', '/api/conversational/model')).body['model']).toEqual(generated.body['model']);
    expect(
      (await request('POST', '/api/documents?collection=%22notes%22', { document: { id: 8, title: 'Still writable' } }))
        .status,
    ).toBe(201);
    expect((await request('POST', '/api/disconnect')).status).toBe(200);
    expect((await request('POST', '/api/connect', { name: 'notes' })).status).toBe(200);
    await expectOriginalDocument();
    expect((await request('GET', '/api/document?collection=%22notes%22&id=8')).body['document']).toEqual({
      id: 8,
      title: 'Still writable',
    });
  });

  it('does not create files or drop the active session when opening an unknown database', async () => {
    await createWithDocument();
    const generated = await request('POST', '/api/conversational/model/generate');
    expect(generated.status).toBe(200);
    const before = (await fs.readdir(databaseDirectory)).sort();
    expectClientError(await request('POST', '/api/connect', { name: 'missing' }));
    expect((await fs.readdir(databaseDirectory)).sort()).toEqual(before);
    expect(service.filepath).toBe(path.join(databaseDirectory, 'notes.db'));
    await expectOriginalDocument();
    expect((await request('GET', '/api/conversational/model')).body['model']).toEqual(generated.body['model']);

    expect((await request('POST', '/api/disconnect')).status).toBe(200);
    expectClientError(await request('POST', '/api/connect', { name: 'missing' }));
    expect((await fs.readdir(databaseDirectory)).sort()).toEqual(before);
    expect(service.isConnected).toBe(false);
  });

  it('reports disconnection and clears the old model when an existing database cannot be opened', async () => {
    await createWithDocument();
    const generated = await request('POST', '/api/conversational/model/generate');
    expect(generated.status).toBe(200);
    const corruptPath = path.join(databaseDirectory, 'corrupt.db');
    const corruptData = Buffer.from('This is not a database');
    await fs.writeFile(corruptPath, corruptData);
    await fs.writeFile(`${corruptPath}.log`, Buffer.alloc(0));
    const result = await request('POST', '/api/connect', { name: 'corrupt' });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body['connected']).toBe(false);
    expect(service.isConnected).toBe(false);
    expect(conversational.getModel()).toBeNull();
    expect(await fs.readFile(corruptPath)).toEqual(corruptData);
    expect((await request('POST', '/api/connect', { name: 'notes' })).status).toBe(200);
    await expectOriginalDocument();
    expect((await request('GET', '/api/conversational/model')).body['model']).toEqual(generated.body['model']);
  });

  it('rejects missing names and paths while retaining the current database and loaded model', async () => {
    await createWithDocument();
    const generated = await request('POST', '/api/conversational/model/generate');
    expect(generated.status).toBe(200);
    const before = (await fs.readdir(databaseDirectory)).sort();
    const invalidBodies: Record<string, unknown>[] = [
      {},
      { name: null },
      { name: 7 },
      { name: [] },
      { name: {} },
      { name: '' },
      { name: '   ' },
      { name: '.' },
      { name: '..' },
      { name: '../escape' },
      { name: '..\\escape' },
      { name: 'folder/child' },
      { name: 'folder\\child' },
      { name: '/tmp/escape.db' },
      { name: 'C:\\Databases\\escape.db' },
      { name: path.join(directory, 'escape.db') },
      { name: 'embedded\u0000name' },
    ];
    for (const route of ['/api/create', '/api/connect']) {
      for (const body of invalidBodies) {
        const response = await request('POST', route, body);
        expect(response.status, `${route}: ${JSON.stringify(body)}`).toBe(400);
        expect(response.body['error']).toEqual(expect.any(String));
        expect(service.isConnected).toBe(true);
        expect(service.filepath).toBe(path.join(databaseDirectory, 'notes.db'));
        expect((await request('GET', '/api/conversational/model')).body['model']).toEqual(generated.body['model']);
      }
    }
    expect((await fs.readdir(databaseDirectory)).sort()).toEqual(before);
    expect((await fs.readdir(directory)).sort()).toEqual(['databases']);
    await expectOriginalDocument();
  });

  it('rejects the old filepath payload without modifying files outside the managed directory', async () => {
    await createWithDocument();
    const outside = path.join(directory, 'outside.db');
    const original = Buffer.from('Unrelated existing database');
    const originalLog = Buffer.from('Unrelated existing WAL');
    await fs.writeFile(outside, original);
    await fs.writeFile(`${outside}.log`, originalLog);
    for (const route of ['/api/create', '/api/connect']) {
      expect((await request('POST', route, { filepath: outside })).status).toBe(400);
      expect(await fs.readFile(outside)).toEqual(original);
      expect(await fs.readFile(`${outside}.log`)).toEqual(originalLog);
      expect(service.filepath).toBe(path.join(databaseDirectory, 'notes.db'));
      await expectOriginalDocument();
    }
  });

  it('retains an orphaned WAL instead of treating its name as an available new database', async () => {
    await createWithDocument();
    const orphan = path.join(databaseDirectory, 'orphan.db');
    const evidence = Buffer.from('Existing WAL must be retained');
    await fs.writeFile(`${orphan}.log`, evidence);
    for (const route of ['/api/create', '/api/connect']) {
      expectClientError(await request('POST', route, { name: 'orphan' }));
      expect(await fs.readFile(`${orphan}.log`)).toEqual(evidence);
      await expect(fs.stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
      await expectOriginalDocument();
    }
  });

  it('keeps direct service paths available without exposing them through the managed catalogue', async () => {
    const direct = path.join(directory, 'library-example.db');
    await service.create(direct);
    await service.insertDocument('notes', { id: 1, title: 'Direct service caller' });
    await service.disconnect();
    await service.connect(direct);
    expect(JSON.parse(await service.getDocumentById('notes', 1))).toEqual({ id: 1, title: 'Direct service caller' });
    expect(await request('GET', '/api/databases')).toEqual({ status: 200, body: { databases: [] } });
    expect((await request('POST', '/api/create', { name: 'managed' })).status).toBe(200);
    expect(service.filepath).toBe(path.join(databaseDirectory, 'managed.db'));
    expect((await fs.stat(direct)).isFile()).toBe(true);
    expect((await fs.stat(`${direct}.log`)).isFile()).toBe(true);
  });
});
