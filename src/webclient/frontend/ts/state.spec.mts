import { describe, expect, it } from 'vitest';
import { resetDisconnectedState, state } from './state.js';

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

    resetDisconnectedState();

    expect(state.connected).toBe(false);
    expect(state.filepath).toBeNull();
    expect(state.collections).toEqual([]);
    expect(state.docsByColl).toEqual({});
    expect(state.countsByColl).toEqual({});
    expect(state.model).toBeNull();
    expect(state.selectedCol).toBeNull();
    expect(state.chatHistory).toEqual([]);
  });
});

