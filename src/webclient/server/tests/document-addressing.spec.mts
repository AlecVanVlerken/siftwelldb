import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRouter } from '../api.mjs';
import { DatabaseService } from '../service.mjs';
import { collectionUrl, documentsUrl, documentUrl } from '../../frontend/ts/api-client.js';

vi.mock('../embedding-config.mjs', () => ({
  getClipHnswConfig: () => ({
    dimension: 2,
    M: 4,
    efConstruction: 16,
    efSearch: 16,
    embeddingFn: () => Promise.resolve(new Float32Array([1, 0])),
  }),
}));

describe('exact HTTP document addressing', () => {
  let directory: string;
  let filepath: string;
  let service: DatabaseService;
  let server: http.Server;
  let origin: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(tmpdir(), 'siftwell-document-address-'));
    filepath = path.join(directory, 'documents.db');
    service = new DatabaseService();
    await service.create(filepath);
    const router = new ApiRouter(service);
    server = http.createServer((req, res) => {
      void router.handle(req, res, new URL(req.url!, 'http://localhost'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected HTTP server address');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await service?.disconnect();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  async function request(url: string, method = 'GET', body?: Record<string, unknown>) {
    const response = await fetch(`${origin}${url}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it.each(['', 'metadata', 'edit', '.', '..', 'normal-id', 'a/b?#+% 雪😀', 42, '42'])(
    'retrieves, edits, replaces, inspects and deletes exact ID %j after disk reopen',
    async (id) => {
      const collection = 'a::b';
      const untouchedId = typeof id === 'number' ? 43 : 'untouched';
      await service.insertDocument(collection, { id, value: 1 });
      await service.insertDocument(collection, { id: untouchedId, value: 99 });
      await service.disconnect();
      await service.connect(filepath);

      expect(await request(documentUrl(collection, id))).toEqual({
        status: 200,
        body: { document: { id, value: 1 } },
      });
      const metadata = await request(documentUrl(collection, id, 'metadata'));
      expect(metadata.status).toBe(200);
      expect(metadata.body['storedSize']).toBeGreaterThan(0);
      expect(await request(documentUrl(collection, id, 'edit'), 'POST', { field: 'value', value: 2 })).toEqual({
        status: 200,
        body: { message: 'Document edited' },
      });
      expect(
        await request(documentUrl(collection, id, 'edit'), 'POST', { document: { id, value: 3, added: true } }),
      ).toEqual({ status: 200, body: { message: 'Document replaced' } });
      await service.disconnect();
      await service.connect(filepath);
      expect((await request(documentUrl(collection, id))).body).toEqual({ document: { id, value: 3, added: true } });
      expect((await request(documentUrl(collection, untouchedId))).body).toEqual({
        document: { id: untouchedId, value: 99 },
      });
      expect(await request(documentUrl(collection, id), 'DELETE')).toEqual({
        status: 200,
        body: { message: 'Document deleted' },
      });
      await service.disconnect();
      await service.connect(filepath);
      await expect(service.getDocumentById(collection, id)).rejects.toThrow('not found');
      expect(JSON.parse(await service.getDocumentById(collection, untouchedId))).toEqual({
        id: untouchedId,
        value: 99,
      });
    },
  );

  it('rejects wrong ID types and replacement identities without affecting either collection', async () => {
    await service.insertDocument('numeric', { id: 42, value: 1 });
    await service.insertDocument('string', { id: '42', value: 2 });
    for (const [collection, invalidId] of [
      ['numeric', '42'],
      ['string', 42],
    ] as const) {
      for (const operation of [undefined, 'metadata', 'edit'] as const) {
        const result = await request(
          documentUrl(collection, invalidId, operation),
          operation === 'edit' ? 'POST' : 'GET',
          operation === 'edit' ? { field: 'value', value: 9 } : undefined,
        );
        expect(result.status).toBe(400);
      }
      expect((await request(documentUrl(collection, invalidId), 'DELETE')).status).toBe(400);
    }
    expect(
      (await request(documentUrl('numeric', 42, 'edit'), 'POST', { document: { id: '42', value: 9 } })).status,
    ).toBe(400);
    expect(service.isConnected).toBe(true);
    expect(JSON.parse(await service.getDocumentById('numeric', 42))).toEqual({ id: 42, value: 1 });
    expect(JSON.parse(await service.getDocumentById('string', '42'))).toEqual({ id: '42', value: 2 });
  });

  it('rejects malformed bulk IDs before beginning any selected document mutation', async () => {
    await service.insertDocument('docs', { id: 'safe', value: 1 });
    const result = await request(documentsUrl('docs', 'bulk-delete'), 'POST', { ids: ['safe', '\uD800'] });
    expect(result.status).toBe(400);
    expect(result.body['error']).toContain('surrogate');
    expect(service.isConnected).toBe(true);
    expect(JSON.parse(await service.getDocumentById('docs', 'safe'))).toEqual({ id: 'safe', value: 1 });
  });

  it.each([
    '',
    '?collection=%22docs%22',
    '?id=%22a%22',
    '?collection=%22docs%22&id=null',
    '?collection=%22docs%22&id=true',
    '?collection=%22docs%22&id=1e400',
    '?collection=%22docs%22&id=%22%5Cud800%22',
    '?collection=%22docs%22&id=%7B%7D',
    '?collection=%22docs%22&id=%22a%22&id=%22b%22',
  ])('returns a readable input error for invalid typed address %s', async (query) => {
    const result = await request(`/api/document${query}`, 'DELETE');
    expect(result.status).toBe(400);
    expect(result.body['error']).toEqual(expect.any(String));
    expect(service.isConnected).toBe(true);
  });

  it.each(['__proto__', 'constructor', 'toString', '.', '..', 'a/b?#+% 雪😀', '', '\uD800'])(
    'keeps collection identity in query addressing for document management and index settings: %j',
    async (collection) => {
      const document = { id: '', value: 1 };
      expect((await request(documentsUrl(collection), 'POST', { document })).status).toBe(201);
      expect((await request('/api/collections')).body['collections']).toContain(collection);
      expect((await request(documentsUrl(collection))).body['documents']).toEqual([JSON.stringify(document)]);
      expect((await request(documentUrl(collection, ''))).body).toEqual({ document });
      expect((await request(collectionUrl(collection, 'storage'))).status).toBe(200);
      expect((await request(collectionUrl(collection, 'indexes'))).body['fields']).toMatchObject({
        id: true,
        value: true,
      });
      expect(
        (await request(collectionUrl(collection, 'indexes'), 'PUT', { field: 'value', indexed: false })).status,
      ).toBe(200);
      await service.disconnect();
      await service.connect(filepath);
      expect((await request(documentUrl(collection, ''))).body).toEqual({ document });
      expect((await request(collectionUrl(collection, 'indexes'))).body['fields']).toMatchObject({
        id: true,
        value: false,
      });
      expect((await request(collectionUrl(collection), 'DELETE')).status).toBe(200);
      expect(await service.getCollections()).not.toContain(collection);
      expect(Object.prototype).not.toHaveProperty('value');
    },
  );

  it('retains ordinary legacy string and numeric routes with explicit path-only conversion', async () => {
    await service.insertDocument('numeric', { id: 42, value: 1 });
    await service.insertDocument('string', { id: '42', value: 2 });
    expect((await request('/api/documents/numeric/42/metadata')).status).toBe(200);
    expect((await request('/api/documents/numeric/42/edit', 'POST', { document: { id: 42, value: 3 } })).status).toBe(
      200,
    );
    expect((await request('/api/documents/string/42/edit', 'POST', { document: { id: '42', value: 4 } })).status).toBe(
      200,
    );
    expect((await request('/api/documents/numeric/42', 'DELETE')).status).toBe(200);
    expect(JSON.parse(await service.getDocumentById('string', '42'))).toEqual({ id: '42', value: 4 });
  });

  it.each(['search', 'bulk-edit', 'bulk-delete'])(
    'preserves legacy collection routes whose collection name resembles a canonical operation: %s',
    async (collection) => {
      const document = { id: 'photos', value: 1 };
      expect((await request(`/api/documents/${collection}`, 'POST', { document })).status).toBe(201);
      expect((await request(`/api/documents/${collection}`)).body['documents']).toEqual([JSON.stringify(document)]);
      expect((await request(`/api/documents/${collection}/photos`, 'DELETE')).status).toBe(200);
    },
  );

  it.each(['', ' ', '__proto__', 'constructor', 'toString', ':'])(
    'edits, indexes and reports compression for the exact supported field name %j',
    async (field) => {
      const collection = '';
      const text = 'exact field value '.repeat(10);
      const bulkValue = `${text}bulk edited`;
      await service.insertDocument(collection, { id: 'target', [field]: text }, { [field]: 'gzip' });
      expect((await request(documentUrl(collection, 'target', 'metadata'))).body['compressions']).toEqual({
        [field]: 'gzip',
      });
      expect(
        (await request('/api/compression/defaults', 'PUT', { collection, defaults: { [field]: 'deflate' } })).status,
      ).toBe(200);
      expect((await request(collectionUrl(collection, 'compression'))).body['defaults']).toEqual({
        [field]: 'deflate',
      });
      expect((await request(collectionUrl(collection, 'indexes'), 'PUT', { field, indexed: false })).status).toBe(200);
      expect(
        (await request(documentUrl(collection, 'target', 'edit'), 'POST', { field, value: text + 'edited' })).status,
      ).toBe(200);
      expect(
        (await request(documentsUrl(collection, 'bulk-edit'), 'POST', { ids: ['target'], field, value: bulkValue }))
          .status,
      ).toBe(200);
      expect((await request(collectionUrl(collection, 'indexes'), 'PUT', { field, indexed: true })).status).toBe(200);
      await service.disconnect();
      await service.connect(filepath);
      expect((await request(documentUrl(collection, 'target'))).body['document']).toEqual({
        id: 'target',
        [field]: bulkValue,
      });
      expect((await request(documentUrl(collection, 'target', 'metadata'))).body['compressions']).toEqual({
        [field]: 'gzip',
      });
      const fields = (await request(collectionUrl(collection, 'indexes'))).body['fields'] as Record<string, boolean>;
      expect(Object.getOwnPropertyDescriptor(fields, field)?.value).toBe(true);
      expect(Object.prototype).not.toHaveProperty('target');
    },
  );
});
