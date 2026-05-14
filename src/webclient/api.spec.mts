import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ApiRouter, readLimit } from './api.mjs';
import type { DatabaseService } from './service.mjs';

class MockRequest extends Readable {
  private sent = false;

  constructor(
    readonly method: string,
    private readonly body: string = '',
  ) {
    super();
  }

  override _read(): void {
    if (this.sent) return;
    this.sent = true;
    this.push(this.body);
    this.push(null);
  }
}

type MockResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead: (statusCode: number, headers: Record<string, string>) => void;
  end: (chunk?: string) => void;
};

function createResponse(): MockResponse {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += chunk;
    },
  };
}

function createDbStub(overrides: Partial<DatabaseService> = {}): DatabaseService {
  return {
    get isConnected() {
      return false;
    },
    get filepath() {
      return null;
    },
    ...overrides,
  } as unknown as DatabaseService;
}

async function handle(
  router: ApiRouter,
  method: string,
  path: string,
  body = '',
): Promise<MockResponse> {
  const req = new MockRequest(method, body);
  const res = createResponse();
  await router.handle(
    req as unknown as Parameters<ApiRouter['handle']>[0],
    res as unknown as Parameters<ApiRouter['handle']>[1],
    new URL(path, 'http://localhost'),
  );
  return res;
}

describe('readLimit', () => {
  it('uses the default when no limit is provided', () => {
    expect(readLimit(new URL('http://localhost/api/documents/books'), 100, 10000)).toBe(100);
  });

  it('accepts positive integer limits inside bounds', () => {
    expect(readLimit(new URL('http://localhost/api/documents/books?limit=25'), 100, 10000)).toBe(25);
  });

  it.each(['0', '-1', 'abc', '1.5', '10001'])('rejects invalid limit %s', (limit) => {
    expect(() => readLimit(new URL(`http://localhost/api/documents/books?limit=${limit}`), 100, 10000))
      .toThrow();
  });
});

describe('ApiRouter', () => {
  it('returns status while disconnected', async () => {
    const router = new ApiRouter(createDbStub());

    const res = await handle(router, 'GET', '/api/status');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ connected: false, filepath: null });
  });

  it('returns 400 for malformed JSON request bodies', async () => {
    const router = new ApiRouter(createDbStub());

    const res = await handle(router, 'POST', '/api/connect', '{"filepath":');

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid JSON' });
  });

  it('returns 413 for oversized JSON request bodies', async () => {
    const router = new ApiRouter(createDbStub());
    const body = JSON.stringify({ filepath: 'x'.repeat(5 * 1024 * 1024) });

    const res = await handle(router, 'POST', '/api/connect', body);

    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: 'Request body too large' });
  });

  it('returns 400 for invalid document list limits', async () => {
    const router = new ApiRouter(createDbStub({ isConnected: true } as Partial<DatabaseService>));

    const res = await handle(router, 'GET', '/api/documents/books?limit=abc');

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid "limit" parameter' });
  });
});
