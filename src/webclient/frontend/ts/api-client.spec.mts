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
});
