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

type Page = { documents: string[]; total: number; hasMore: boolean; nextCursor?: string; error?: string };
const ids = (page: Page) => page.documents.map((json) => (JSON.parse(json) as { id: string | number }).id);

describe('HTTP cursor pagination', () => {
  let directory: string;
  let filepath: string;
  let service: DatabaseService;
  let server: http.Server;
  let origin: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(tmpdir(), 'siftwell-http-cursor-'));
    filepath = path.join(directory, 'documents.db');
    service = new DatabaseService();
    await service.create(filepath);
    const router = new ApiRouter(service);
    server = http.createServer((request, response) => {
      void router.handle(request, response, new URL(request.url!, 'http://localhost'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected HTTP server address');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await service.disconnect();
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function page(collection: string, field = 'id', cursor?: string, limit = 2) {
    const address = new URL(documentsUrl(collection), origin);
    address.searchParams.set('iterableKey', field);
    address.searchParams.set('limit', String(limit));
    if (cursor !== undefined) address.searchParams.set('cursor', cursor);
    const response = await fetch(address);
    return { status: response.status, body: (await response.json()) as Page };
  }

  it.each(['', '__proto__', '..', 'docs/a?#+%'])(
    'traverses duplicate values in exact collection %j across requests and reopen',
    async (collection) => {
      const expected = ['', '42', 'a', 'e\u0301', 'é', '雪', '😀'];
      for (const id of expected) await service.insertDocument(collection, { id, category: 'A' });
      const result: Array<string | number> = [];
      let cursor: string | undefined;
      for (let remaining = expected.length; remaining > 0; remaining--) {
        const response = await page(collection, 'category', cursor);
        expect(response.status).toBe(200);
        expect(response.body.total).toBe(expected.length);
        result.push(...ids(response.body));
        if (!response.body.hasMore) {
          expect(response.body.nextCursor).toBeUndefined();
          break;
        }
        cursor = response.body.nextCursor;
        expect(cursor).toEqual(expect.any(String));
        await service.disconnect();
        await service.connect(filepath);
      }
      expect(result).toEqual(expected);
    },
  );

  it.each(['id', 'category'])(
    'retains numeric types and the next successor after deleting the saved %s entry',
    async (field) => {
      for (const id of [1, 2, 3, 4, 5]) await service.insertDocument('numbers', { id, category: 'A' });
      const first = await page('numbers', field);
      expect(ids(first.body)).toEqual([1, 2]);
      const deletion = await fetch(new URL(documentUrl('numbers', 2), origin), { method: 'DELETE' });
      expect(deletion.status).toBe(200);
      await service.disconnect();
      await service.connect(filepath);
      const second = await page('numbers', field, first.body.nextCursor);
      expect(second.status).toBe(200);
      expect(ids(second.body)).toEqual([3, 4]);
      expect(second.body.total).toBe(4);
      const final = await page('numbers', field, second.body.nextCursor);
      expect(ids(final.body)).toEqual([5]);
      expect(final.body.hasMore).toBe(false);
    },
  );

  it('returns readable HTTP 400 errors for malformed, legacy and mismatched cursors', async () => {
    for (const collection of ['docs', 'other']) {
      for (const id of ['a', 'b']) await service.insertDocument(collection, { id, category: 'A' });
    }
    const first = await page('docs', 'category', undefined, 1);
    for (const cursor of ['', 'A', '!malformed', Buffer.from('{"v":2}').toString('base64url')]) {
      const invalid = await page('docs', 'category', cursor);
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toMatch(/invalid or unsupported cursor/i);
    }
    expect((await page('other', 'category', first.body.nextCursor)).status).toBe(400);
    expect((await page('docs', 'id', first.body.nextCursor)).status).toBe(400);
    expect(service.isConnected).toBe(true);
    expect(ids((await page('docs', 'category', first.body.nextCursor)).body)).toEqual(['b']);
  });

  it('rejects multiple cursor parameters rather than guessing which one to use', async () => {
    await service.insertDocument('docs', { id: 'a' });
    const address = new URL(documentsUrl('docs'), origin);
    address.searchParams.append('cursor', 'a');
    address.searchParams.append('cursor', 'b');
    const response = await fetch(address);
    expect(response.status).toBe(400);
    expect((await response.json()) as Record<string, unknown>).toHaveProperty('error');
  });

  it('reports a dropped collection cursor before attempting the ordinary collection count', async () => {
    await service.insertDocument('docs', { id: 'a' });
    await service.insertDocument('docs', { id: 'b' });
    const first = await page('docs', 'id', undefined, 1);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const deletion = await fetch(new URL(collectionUrl('docs'), origin), { method: 'DELETE' });
    expect(deletion.status).toBe(200);
    const resumed = await page('docs', 'id', first.body.nextCursor);
    expect(resumed.status).toBe(400);
    expect(resumed.body.error).toMatch(/invalid or unsupported cursor: collection no longer exists/i);
    expect(service.isConnected).toBe(true);
    await service.insertDocument('remaining', { id: 'safe' });
    expect(ids((await page('remaining')).body)).toEqual(['safe']);
  });

  it('preserves offset browsing and ordinary legacy document-list routes', async () => {
    for (const id of [1, 2, 3, 4, 5]) await service.insertDocument('docs', { id, category: 'A' });
    const address = new URL(documentsUrl('docs'), origin);
    address.searchParams.set('offset', '2');
    address.searchParams.set('limit', '2');
    const offset = await fetch(address);
    const result = (await offset.json()) as Page;
    expect(ids(result)).toEqual([3, 4]);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeUndefined();
    const legacy = await fetch(`${origin}/api/documents/docs?limit=2`);
    const first = (await legacy.json()) as Page;
    expect(ids(first)).toEqual([1, 2]);
    const resumed = await fetch(`${origin}/api/documents/docs?limit=2&cursor=${first.nextCursor}`);
    expect(ids((await resumed.json()) as Page)).toEqual([3, 4]);
  });
});
