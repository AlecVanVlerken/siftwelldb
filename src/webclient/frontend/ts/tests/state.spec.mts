import { beforeEach, describe, expect, it } from 'vitest';
import {
  captureRequestContext,
  invalidateRequestContext,
  isCurrentRequestContext,
  resetDisconnectedState,
  state,
} from '../state.js';

beforeEach(() => resetDisconnectedState());

describe('frontend state', () => {
  it('resets connection-scoped state on disconnect', () => {
    state.connected = true;
    state.filepath = 'data.db';
    state.collections = ['books'];
    state.docsByColl = { books: [{ id: 'b1' }] };
    state.countsByColl = { books: 1 };
    state.model = { explores: [] };
    state.selectedCol = 'books';
    state.chatHistory = [{ role: 'user', text: 'hi' }];
    state.sqlHistory = [{ sql: 'SELECT * FROM books' }];
    state.selectedDoc = { id: 'b1' };
    state.selectedDocIndex = 0;
    state.tab = 'search';
    state.dataFilter = 'private';
    state.dataSort = { col: 'id', dir: 'desc' };
    state.treeExpanded = { books: true };
    state.modelPromptDismissed = { books: true };
    state.modelGenerating = true;
    state.seedBusy = true;
    state.search.query = 'old question';
    state.search.image = { name: 'photo.png', dataUrl: 'data:image/png;base64,aA==', buffer: 'aA==' };
    state.search.results = ['{"id":"b1"}'];
    state.search.busy = true;
    state.search.error = 'old error';
    state.lab.busy = true;

    resetDisconnectedState();

    expect(state.connected).toBe(false);
    expect(state.filepath).toBeNull();
    expect(state.collections).toEqual([]);
    expect(state.docsByColl).toEqual({});
    expect(state.countsByColl).toEqual({});
    expect(state.model).toBeNull();
    expect(state.selectedCol).toBeNull();
    expect(state.chatHistory).toEqual([]);
    expect(state.sqlHistory).toEqual([]);
    expect(state.selectedDoc).toBeNull();
    expect(state.selectedDocIndex).toBeNull();
    expect(state.tab).toBe('overview');
    expect(state.dataFilter).toBe('');
    expect(state.dataSort).toBeNull();
    expect(state.treeExpanded).toEqual({});
    expect(state.modelPromptDismissed).toEqual({});
    expect(state.modelGenerating).toBe(false);
    expect(state.seedBusy).toBe(false);
    expect(state.search).toMatchObject({ query: '', image: null, results: null, busy: false, error: null });
    expect(state.lab.busy).toBe(false);
  });

  it('preserves process-wide settings and detaches old search results on disconnect', () => {
    state.geminiKeySet = true;
    state.search.embedStatus = { state: 'ready', error: null };
    state.compression.workload = 0.75;
    const oldSearch = state.search;

    resetDisconnectedState();
    oldSearch.results = ['{"id":"old-result"}'];

    expect(state.search.results).toBeNull();
    expect(state.search.embedStatus).toEqual({ state: 'ready', error: null });
    expect(state.geminiKeySet).toBe(true);
    expect(state.compression.workload).toBe(0.75);
  });

  it('keeps database reads current while invalidating old collection responses', () => {
    state.connected = true;
    state.filepath = 'data.db';
    state.selectedCol = 'books';
    const databaseRequest = captureRequestContext('database');
    const collectionRequest = captureRequestContext();
    expect(isCurrentRequestContext(collectionRequest)).toBe(true);

    invalidateRequestContext();
    state.selectedCol = 'photos';

    expect(isCurrentRequestContext(databaseRequest)).toBe(true);
    expect(isCurrentRequestContext(collectionRequest)).toBe(false);
    state.selectedCol = 'books';
    expect(isCurrentRequestContext(collectionRequest)).toBe(false);
  });

  it('rejects old responses when reconnecting to the same filepath', () => {
    state.connected = true;
    state.filepath = 'data.db';
    const request = captureRequestContext('database');

    resetDisconnectedState();
    state.connected = true;
    state.filepath = 'data.db';

    expect(isCurrentRequestContext(request)).toBe(false);
    const newRequest = captureRequestContext('database');
    invalidateRequestContext('database');
    expect(isCurrentRequestContext(newRequest)).toBe(false);
  });
});
