import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, collectionUrl, documentsUrl, documentUrl } from '../api-client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api client', () => {
  it.each(['.', '..', '', '__proto__', 'a/b?#+% 雪😀', '\uD800'])(
    'uses exact JSON collection names across frontend collection requests: %j',
    async (collection) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response('{}')));
      for (const path of [
        collectionUrl(collection),
        collectionUrl(collection, 'indexes'),
        collectionUrl(collection, 'storage'),
        collectionUrl(collection, 'compression'),
        documentsUrl(collection),
        documentsUrl(collection, 'bulk-edit'),
        documentsUrl(collection, 'search/image'),
      ]) {
        await api(path);
        const [request] = fetchMock.mock.calls.at(-1)!;
        if (typeof request !== 'string') throw new Error('Expected a frontend URL string');
        const url = new URL(request, 'http://localhost');
        expect(JSON.parse(url.searchParams.get('collection')!)).toBe(collection);
        expect(url.pathname).not.toContain(collection === '.' || collection === '..' ? collection : '%');
      }
    },
  );
  it.each(['', 'metadata', 'edit', '.', '..', 'normal-id', 'a/b?#% +', '雪😀', 42, '42'])(
    'preserves the exact document address in actual frontend requests: %j',
    async (id) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response('{}')));
      const collection = '../a/b?#雪';
      for (const operation of [undefined, 'metadata', 'edit'] as const) {
        await api(documentUrl(collection, id, operation), { method: operation === 'edit' ? 'POST' : 'GET' });
        const [request] = fetchMock.mock.calls.at(-1)!;
        if (typeof request !== 'string') throw new Error('Expected a frontend URL string');
        const url = new URL(request, 'http://localhost');
        expect(url.pathname).toBe(`/api/document${operation ? `/${operation}` : ''}`);
        expect(JSON.parse(url.searchParams.get('collection')!)).toBe(collection);
        expect(JSON.parse(url.searchParams.get('id')!)).toBe(id);
      }
      await api(documentUrl(collection, id), { method: 'DELETE' });
      expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
    },
  );
  it('serializes object bodies as JSON', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    await expect(api('/api/example', { method: 'POST', body: { name: 'Ada' } })).resolves.toEqual({ ok: true });

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.body).toBe('{"name":"Ada"}');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  });

  it('throws server error messages when available', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"No database connected"}', { status: 400 }));

    await expect(api('/api/documents/books')).rejects.toThrow('No database connected');
  });
  it('preserves completed numeric and string IDs from late query failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"Partial SQL write","affectedIds":[7,"a"]}', { status: 400 }),
    );
    await expect(api('/api/query')).rejects.toMatchObject({ message: 'Partial SQL write', affectedIds: [7, 'a'] });
  });

  it('preserves backend connection metadata so unsafe failures can open the reconnect dialog', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '{"error":"Close and reopen the database","affectedIds":[7],"connected":false,"filepath":"data.db"}',
        { status: 400 },
      ),
    );
    await expect(api('/api/query')).rejects.toMatchObject({
      message: 'Close and reopen the database',
      affectedIds: [7],
      connection: { connected: false, filepath: 'data.db' },
    });
  });

  it('leaves ordinary validation errors without a disconnect instruction', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"Field is too large"}', { status: 400 }));
    await expect(api('/api/documents/books')).rejects.toMatchObject({
      message: 'Field is too large',
      connection: undefined,
    });
  });

  it('reports maintenance availability without treating temporary handle closure as a disconnect', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Full vacuum is running',
          busyOperation: 'vacuum',
          connected: false,
          filepath: 'saved.db',
        }),
        { status: 409 },
      ),
    );
    await expect(api('/api/query')).rejects.toMatchObject({
      message: 'Full vacuum is running',
      busyOperation: 'vacuum',
      connection: undefined,
    });
  });

  it('ignores malformed connection metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"Failed","connected":false,"filepath":42}', { status: 500 }),
    );
    await expect(api('/api/documents/books')).rejects.toMatchObject({ connection: undefined });
  });

  it.each([new Blob(['image bytes']), new URLSearchParams({ q: 'books' })])(
    'preserves a native request body instead of converting it to JSON',
    async (body) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

      await api('/api/example', { method: 'POST', body });

      const [, init] = fetchMock.mock.calls[0];
      expect(init?.body).toBe(body);
      expect(new Headers(init?.headers).has('Content-Type')).toBe(false);
    },
  );

  it('rejects a malformed success response instead of returning an error as valid data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>Not an API response</html>'));

    await expect(api('/api/status')).rejects.toThrow('The server returned an invalid JSON response.');
  });

  it('shows plain-text server failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Server unavailable', { status: 503 }));

    await expect(api('/api/status')).rejects.toThrow('Server unavailable');
  });

  it('falls back to HTTP status when the server error is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":""}', { status: 500 }));

    await expect(api('/api/status')).rejects.toThrow('HTTP 500');
  });
});
