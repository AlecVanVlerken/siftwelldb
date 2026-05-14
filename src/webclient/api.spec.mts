import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ApiRouter, readLimit } from './api.mjs';
import type { DatabaseService } from './service.mjs';
import type { ConversationalService } from './conversational-service.mjs';
import type { SemanticModel } from '../conversational/semanticModel.mjs';
import type { AnalyticsResponse } from '../conversational/conversationalEngine.mjs';

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

function createConnectedDbStub(overrides: Partial<DatabaseService> = {}): DatabaseService {
  return createDbStub({
    get isConnected() {
      return true;
    },
    get filepath() {
      return 'data.db';
    },
    ...overrides,
  } as Partial<DatabaseService>);
}

function createConversationalStub(overrides: Partial<ConversationalService> = {}): ConversationalService {
  return {
    get llmAvailable() {
      return true;
    },
    get engineReady() {
      return true;
    },
    getModel() {
      return null;
    },
    hasExploreForCollection() {
      return false;
    },
    generateModel() {
      return Promise.resolve({ model: { explores: [] } as unknown as SemanticModel, enriched: false });
    },
    saveModel() {
      return Promise.resolve({ explores: [] } as unknown as SemanticModel);
    },
    ask() {
      return Promise.resolve({ question: '', query: '', data: [], summary: '', chart: null } as AnalyticsResponse);
    },
    ...overrides,
  } as unknown as ConversationalService;
}

async function handle(router: ApiRouter, method: string, path: string, body = ''): Promise<MockResponse> {
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
    expect(() => readLimit(new URL(`http://localhost/api/documents/books?limit=${limit}`), 100, 10000)).toThrow();
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

  it('inserts a document object into a collection', async () => {
    let inserted: unknown;
    let insertedCollection = '';
    const router = new ApiRouter(
      createConnectedDbStub({
        insertDocument(collection, document) {
          insertedCollection = collection;
          inserted = document;
          return Promise.resolve();
        },
      } as Partial<DatabaseService>),
    );

    const res = await handle(
      router,
      'POST',
      '/api/documents/books',
      JSON.stringify({ document: { id: 'b1', title: 'Dune' } }),
    );

    expect(res.statusCode).toBe(201);
    expect(insertedCollection).toBe('books');
    expect(inserted).toEqual({ id: 'b1', title: 'Dune' });
    expect(JSON.parse(res.body)).toEqual({ message: 'Document inserted' });
  });

  it('replaces a document in one edit request', async () => {
    let replaced: unknown;
    let replacedId = '';
    const router = new ApiRouter(
      createConnectedDbStub({
        replaceDocument(_collection, id, document) {
          replacedId = id;
          replaced = document;
          return Promise.resolve();
        },
      } as Partial<DatabaseService>),
    );

    const res = await handle(
      router,
      'POST',
      '/api/documents/books/b1/edit',
      JSON.stringify({ document: { id: 'b1', title: 'Dune Messiah', pages: 256 } }),
    );

    expect(res.statusCode).toBe(200);
    expect(replacedId).toBe('b1');
    expect(replaced).toEqual({ id: 'b1', title: 'Dune Messiah', pages: 256 });
    expect(JSON.parse(res.body)).toEqual({ message: 'Document replaced' });
  });

  it('rejects non-object full document replacements', async () => {
    const router = new ApiRouter(createConnectedDbStub());

    const res = await handle(
      router,
      'POST',
      '/api/documents/books/b1/edit',
      JSON.stringify({ document: ['not', 'object'] }),
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'document must be a JSON object' });
  });

  it('returns 503 for conversational routes when the service is not registered', async () => {
    const router = new ApiRouter(createConnectedDbStub());

    const res = await handle(router, 'GET', '/api/conversational/model');

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'Conversational features are not available' });
  });

  it('returns the conversational model and LLM availability', async () => {
    const model: SemanticModel = {
      explores: [
        { collection: 'employees', label: 'Employees', fields: [{ name: 'id', type: 'string', label: 'ID' }] },
      ],
    };
    const router = new ApiRouter(
      createConnectedDbStub(),
      createConversationalStub({
        getModel() {
          return model;
        },
      }),
    );

    const res = await handle(router, 'GET', '/api/conversational/model');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ model, llmAvailable: true });
  });

  it('generates a conversational model through the service', async () => {
    const model: SemanticModel = {
      explores: [
        { collection: 'employees', label: 'Employees', fields: [{ name: 'id', type: 'string', label: 'ID' }] },
      ],
    };
    const router = new ApiRouter(
      createConnectedDbStub(),
      createConversationalStub({
        generateModel() {
          return Promise.resolve({ model, enriched: true });
        },
      }),
    );

    const res = await handle(router, 'POST', '/api/conversational/model/generate');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ model, enriched: true });
  });

  it('saves a conversational model JSON string', async () => {
    const model: SemanticModel = {
      explores: [
        { collection: 'employees', label: 'Employees', fields: [{ name: 'id', type: 'string', label: 'ID' }] },
      ],
    };
    let saved = '';
    const router = new ApiRouter(
      createConnectedDbStub(),
      createConversationalStub({
        saveModel(json) {
          saved = json;
          return Promise.resolve(model);
        },
      }),
    );

    const res = await handle(
      router,
      'PUT',
      '/api/conversational/model',
      JSON.stringify({ model: JSON.stringify(model) }),
    );

    expect(res.statusCode).toBe(200);
    expect(saved).toBe(JSON.stringify(model));
    expect(JSON.parse(res.body)).toEqual({ model });
  });

  it('asks the conversational service with sanitized history', async () => {
    const response: AnalyticsResponse = {
      question: 'How many?',
      query: 'SELECT COUNT(*) FROM employees',
      data: [{ 'COUNT(*)': 2 }],
      summary: 'There are 2 employees.',
      chart: null,
    };
    let receivedHistory: unknown;
    const router = new ApiRouter(
      createConnectedDbStub(),
      createConversationalStub({
        ask(_question, history) {
          receivedHistory = history;
          return Promise.resolve(response);
        },
      }),
    );

    const res = await handle(
      router,
      'POST',
      '/api/conversational/ask',
      JSON.stringify({
        question: 'How many?',
        history: [
          { role: 'assistant', text: 'previous answer' },
          { role: 'system', text: 'coerce me to user' },
        ],
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(receivedHistory).toEqual([
      { role: 'assistant', text: 'previous answer' },
      { role: 'user', text: 'coerce me to user' },
    ]);
    expect(JSON.parse(res.body)).toEqual(response);
  });

  it('validates conversational ask request bodies', async () => {
    const router = new ApiRouter(createConnectedDbStub(), createConversationalStub());

    const res = await handle(router, 'POST', '/api/conversational/ask', JSON.stringify({ question: '' }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Missing "question" in request body' });
  });

  it('seeds demo employees through the main API', async () => {
    let requestedCount = 0;
    const router = new ApiRouter(
      createConnectedDbStub({
        seedDemoEmployees(count?: number) {
          requestedCount = count ?? 0;
          return Promise.resolve({ collection: 'employees', inserted: 25, skipped: false });
        },
      } as Partial<DatabaseService>),
    );

    const res = await handle(router, 'POST', '/api/demo/employees', JSON.stringify({ count: 25 }));

    expect(res.statusCode).toBe(200);
    expect(requestedCount).toBe(25);
    expect(JSON.parse(res.body)).toEqual({
      message: 'Seeded 25 demo employees',
      collection: 'employees',
      inserted: 25,
      skipped: false,
    });
  });
});
