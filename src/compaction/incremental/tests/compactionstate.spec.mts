import assert from 'assert';
import { describe, it } from 'vitest';

import { CompactionState } from '../compactionstate.mjs';

describe('CompactionState', () => {
  it('starts with empty state', () => {
    const state = new CompactionState();

    assert.deepStrictEqual(state.getLastRecordCursor(), {});
    assert.strictEqual(state.getLastTailScanBlock(), undefined);
  });

  it('stores and returns record cursor copies', () => {
    const state = new CompactionState();
    const cursor = { collection: 'articles', id: 'a1' };

    state.setLastRecordCursor(cursor);
    cursor.collection = 'mutated';

    assert.deepStrictEqual(state.getLastRecordCursor(), { collection: 'articles', id: 'a1' });
  });

  it('stores and clears tail scan block', () => {
    const state = new CompactionState();

    state.setLastTailScanBlock(42);
    assert.strictEqual(state.getLastTailScanBlock(), 42);
    state.setLastTailScanBlock(undefined);
    assert.strictEqual(state.getLastTailScanBlock(), undefined);
  });
});
