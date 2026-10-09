import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ApiRouter, readLimit } from '../api.mjs';
import { DatabaseInputError, DatabaseService } from '../service.mjs';
import type { ConversationalService } from '../conversational-service.mjs';
import type { SemanticModel } from '../../../conversational/semanticModel.mjs';
import type { AnalyticsResponse } from '../../../conversational/conversationalEngine.mjs';

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
    onDisconnect() {},
    onConnect() {
      return Promise.resolve();
    },
    removeCollection() {
      return Promise.resolve();
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
  it.each([{}, { all: false }, { ids: [] }, { all: true, ids: ['a'] }, { ids: [{}] }])(
    'rejects ambiguous or invalid bulk selection %j',
    async (body) => {
      const router = new ApiRouter(createConnectedDbStub());
      const res = await handle(router, 'POST', '/api/documents/books/bulk-delete', JSON.stringify(body));
      expect(res.statusCode).toBe(400);
    },
  );

  it('passes explicit bulk selection to the service without SQL conversion', async () => {
    let captured: unknown;
    const router = new ApiRouter(
      createConnectedDbStub({
        mutateDocuments(collection, selection, edit) {
          captured = { collection, selection, edit };
          return Promise.resolve({ affected: 2 });
        },
      }),
    );
    const res = await handle(
      router,
      'POST',
      '/api/documents/books/bulk-edit',
      JSON.stringify({ ids: ['a', 42], field: 'pages', value: 99 }),
    );
    expect(res.statusCode).toBe(200);
    expect(captured).toEqual({
      collection: 'books',
      selection: { ids: ['a', 42] },
      edit: { field: 'pages', value: 99 },
    });
  });

  it.each([
    { field: 'id', value: 'changed' },
    { field: 'pages', value: null },
    { field: 'pages', value: {} },
  ])('rejects unsafe bulk edit %j', async (edit) => {
    const router = new ApiRouter(createConnectedDbStub());
    const res = await handle(router, 'POST', '/api/documents/books/bulk-edit', JSON.stringify({ all: true, ...edit }));
    expect(res.statusCode).toBe(400);
  });
  it('returns disconnected database status so polling can detect a closed connection', async () => {
    const res = await handle(new ApiRouter(new DatabaseService()), 'GET', '/api/database/status');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ connected: false, filepath: null, size: null });
  });

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

  it.each(['null', '[]', '42', '"filepath"'])('rejects non-object JSON bodies: %s', async (body) => {
    const res = await handle(new ApiRouter(createDbStub()), 'POST', '/api/connect', body);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('preserves UTF-8 values across split request chunks', async () => {
    let inserted: unknown;
    const router = new ApiRouter(
      createConnectedDbStub({
        insertDocument(_collection, document) {
          inserted = document;
          return Promise.resolve();
        },
      }),
    );
    const body = Buffer.from(JSON.stringify({ document: { id: 'b1', title: 'Café' } }));
    const split = body.indexOf(Buffer.from('é')) + 1;
    const req = Object.assign(Readable.from([body.subarray(0, split), body.subarray(split)]), { method: 'POST' });
    const res = createResponse();
    await router.handle(
      req as unknown as Parameters<ApiRouter['handle']>[0],
      res as unknown as Parameters<ApiRouter['handle']>[1],
      new URL('http://localhost/api/documents/books'),
    );
    expect(res.statusCode).toBe(201);
    expect(inserted).toEqual({ id: 'b1', title: 'Café' });
  });

  it('does not suppress invalid JSON on embedding preload', async () => {
    const res = await handle(new ApiRouter(createDbStub()), 'POST', '/api/embeddings/preload', '{');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid JSON' });
  });

  it.each(['-1', '1.5', 'NaN', '9007199254740992'])('rejects invalid pagination offsets: %s', async (offset) => {
    const res = await handle(new ApiRouter(createConnectedDbStub()), 'GET', `/api/documents/books?offset=${offset}`);
    expect(res.statusCode).toBe(400);
  });

  it.each(['wordsearch', 'contentsearch'])('validates %s limits and offsets', async (route) => {
    const router = new ApiRouter(createConnectedDbStub());
    expect((await handle(router, 'GET', `/api/documents/books/${route}?word=test&limit=abc`)).statusCode).toBe(400);
    expect((await handle(router, 'GET', `/api/documents/books/${route}?word=test&offset=-1`)).statusCode).toBe(400);
  });

  it('rejects mixing offset and cursor pagination', async () => {
    const res = await handle(new ApiRouter(createConnectedDbStub()), 'GET', '/api/documents/books?offset=0&cursor=b1');
    expect(res.statusCode).toBe(400);
  });

  it('passes offset pagination and total counts through to the client', async () => {
    let requestedOffset: number | undefined;
    const router = new ApiRouter(
      createConnectedDbStub({
        getDocuments(_collection, _key, _cursor, _limit, _sortBy, _sortDir, offset) {
          requestedOffset = offset;
          return Promise.resolve({ documents: ['{"id":"b2"}'], total: 3, hasMore: true });
        },
      }),
    );
    const res = await handle(router, 'GET', '/api/documents/books?offset=1&limit=1');
    expect(res.statusCode).toBe(200);
    expect(requestedOffset).toBe(1);
    expect(JSON.parse(res.body)).toEqual({ documents: ['{"id":"b2"}'], total: 3, hasMore: true });
  });

  it.each([
    { document: { title: 'Missing id' } },
    { document: { id: 'b1', title: ['Invalid field'] } },
    { document: { id: 'b1' }, compression: { title: 'unknown-codec' } },
    { document: { id: 'b1' }, compression: [] },
  ])('rejects invalid writes before touching the database: %j', async (body) => {
    let writes = 0;
    const router = new ApiRouter(
      createConnectedDbStub({
        insertDocument() {
          writes++;
          return Promise.resolve();
        },
      }),
    );
    const res = await handle(router, 'POST', '/api/documents/books', JSON.stringify(body));
    expect(res.statusCode).toBe(400);
    expect(writes).toBe(0);
  });

  it('rejects changing a document id in a replacement', async () => {
    const res = await handle(
      new ApiRouter(createConnectedDbStub()),
      'POST',
      '/api/documents/books/b1/edit',
      JSON.stringify({ document: { id: 'b2' } }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Document id cannot be changed' });
  });

  it('returns actionable 400 responses for indexed values rejected before storage', async () => {
    const message =
      'Field "body" exceeds the maximum indexed key size. Shorten the value or disable indexing for this field. Compression does not reduce index key size.';
    const router = new ApiRouter(
      createConnectedDbStub({
        insertDocument() {
          return Promise.reject(new DatabaseInputError(message));
        },
      }),
    );
    const res = await handle(
      router,
      'POST',
      '/api/documents/notes',
      JSON.stringify({ document: { id: 'n1', body: 'x'.repeat(4200) }, compression: { body: 'gzip' } }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: message });
  });

  it('reads document metadata through one serialized service operation', async () => {
    const router = new ApiRouter(
      createConnectedDbStub({
        getDocumentMetadata(collection, id) {
          expect([collection, id]).toEqual(['books', 'b1']);
          return Promise.resolve({ storedSize: 4096, blockSize: 4096, compressions: { content: 'gzip' } });
        },
      }),
    );
    const res = await handle(router, 'GET', '/api/documents/books/b1/metadata');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ storedSize: 4096, blockSize: 4096, compressions: { content: 'gzip' } });
  });

  it('rebinds the conversational backend after vacuum swaps the database files', async () => {
    let rebound = '';
    const router = new ApiRouter(
      createConnectedDbStub({
        vacuum() {
          return Promise.resolve({ filepath: 'data.db' } as Awaited<ReturnType<DatabaseService['vacuum']>>);
        },
      }),
      createConversationalStub({
        onConnect(filepath) {
          rebound = filepath;
          return Promise.resolve();
        },
      }),
    );
    const res = await handle(router, 'POST', '/api/database/vacuum');
    expect(res.statusCode).toBe(200);
    expect(rebound).toBe('data.db');
  });

  it('serializes conversational model saves with other database work', async () => {
    let operation = '';
    const router = new ApiRouter(
      createConnectedDbStub({
        runExclusiveOperation(name, task) {
          operation = name;
          return task();
        },
      }),
      createConversationalStub(),
    );
    const res = await handle(router, 'PUT', '/api/conversational/model', JSON.stringify({ model: '{"explores":[]}' }));
    expect(res.statusCode).toBe(200);
    expect(operation).toBe('conversational-model-save');
  });

  it('saves explicit field compression defaults through the service', async () => {
    let saved: Record<string, string> = {};
    const router = new ApiRouter(
      createConnectedDbStub({
        setCompressionDefaults(collection, defaults) {
          expect(collection).toBe('books');
          saved = defaults;
          return Promise.resolve();
        },
        getCompressionDefaults() {
          return Promise.resolve(saved) as ReturnType<DatabaseService['getCompressionDefaults']>;
        },
      }),
    );
    const res = await handle(
      router,
      'PUT',
      '/api/compression/defaults',
      JSON.stringify({ collection: 'books', defaults: { _body: 'gzip', title: 'none' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      defaults: { _body: 'gzip', title: 'none' },
      message: 'Compression defaults saved',
    });
  });

  it('prunes collection explores before releasing the delete operation', async () => {
    const calls: string[] = [];
    const router = new ApiRouter(
      createConnectedDbStub({
        async deleteCollection(collection, afterDelete) {
          calls.push(`delete:${collection}`);
          if (afterDelete) await afterDelete();
          calls.push('release');
        },
      }),
      createConversationalStub({
        removeCollection(collection) {
          calls.push(`prune:${collection}`);
          return Promise.resolve();
        },
      }),
    );
    const res = await handle(router, 'DELETE', '/api/collections/books');
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['delete:books', 'prune:books', 'release']);
  });

  it.each([null, [], { title: 'unknown' }, { title: 'off' }, { id: 'gzip' }, { '': 'gzip' }])(
    'rejects invalid default maps before saving: %j',
    async (defaults) => {
      const res = await handle(
        new ApiRouter(createConnectedDbStub()),
        'PUT',
        '/api/compression/defaults',
        JSON.stringify({ collection: 'books', defaults }),
      );
      expect(res.statusCode).toBe(400);
    },
  );

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

  it('returns 400 when sortDir is not asc or desc', async () => {
    const router = new ApiRouter(createConnectedDbStub());

    const res = await handle(router, 'GET', '/api/documents/books?sortBy=title&sortDir=sideways');

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: '"sortDir" must be "asc" or "desc"' });
  });

  it('passes sortBy and sortDir through to the database service', async () => {
    let receivedSortBy: string | undefined;
    let receivedSortDir: string | undefined;
    const router = new ApiRouter(
      createConnectedDbStub({
        getDocuments(_collection, _iterableKey, _cursor, _limit, sortBy, sortDir) {
          receivedSortBy = sortBy;
          receivedSortDir = sortDir;
          return Promise.resolve({ documents: [], total: 0, hasMore: false });
        },
      } as Partial<DatabaseService>),
    );

    const res = await handle(router, 'GET', '/api/documents/employees?sortBy=salary&sortDir=desc');

    expect(res.statusCode).toBe(200);
    expect(receivedSortBy).toBe('salary');
    expect(receivedSortDir).toBe('desc');
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

describe('field indexing API', () => {
  it('returns actual collection settings and awaits an index change', async () => {
    const config = { id: true, body: false };
    const router = new ApiRouter(
      createConnectedDbStub({
        getFieldIndexConfig: () => Promise.resolve(config),
        setFieldIndexed: async (_collection, field, indexed) => {
          await Promise.resolve();
          return { ...config, [field]: indexed };
        },
      }),
    );
    const response = await handle(router, 'GET', '/api/collections/articles/indexes');
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ fields: config });
    const changed = await handle(
      router,
      'PUT',
      '/api/collections/articles/indexes',
      JSON.stringify({ field: 'title', indexed: true }),
    );
    expect(changed.statusCode).toBe(200);
    expect(JSON.parse(changed.body)).toEqual({ fields: { ...config, title: true } });
  });

  it('rejects invalid checkbox input', async () => {
    const router = new ApiRouter(createConnectedDbStub());
    const response = await handle(
      router,
      'PUT',
      '/api/collections/articles/indexes',
      JSON.stringify({ field: 'title', indexed: 'true' }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('reports backend index build validation failures as input errors', async () => {
    const router = new ApiRouter(
      createConnectedDbStub({
        setFieldIndexed: () =>
          Promise.reject(new DatabaseInputError('Field body exceeds the maximum indexed key size')),
      }),
    );
    const response = await handle(
      router,
      'PUT',
      '/api/collections/articles/indexes',
      JSON.stringify({ field: 'body', indexed: true }),
    );
    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { error: string }).error).toContain('maximum indexed key size');
  });
});
