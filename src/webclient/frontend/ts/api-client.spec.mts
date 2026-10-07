import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api-client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api client', () => {
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
