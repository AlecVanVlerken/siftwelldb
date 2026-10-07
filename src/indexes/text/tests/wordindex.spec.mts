import { describe, expect, it, beforeEach } from 'vitest';
import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { SimpleDbms } from '../../../database/simpledbms.mjs';
import { InvertedIndex } from '../invertedindex.mjs';
import {
  persistWordIndex,
  mergeWordIndex,
  searchWordIndex,
  searchContentIndex,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  WORD_INDEX_COLLECTION,
  CONTENT_INDEX_COLLECTION,
} from '../wordindex.mjs';

async function makeDb(): Promise<SimpleDbms> {
  return SimpleDbms.create(new MockFile(256), new MockFile(4096));
}

function makeIndex(db: SimpleDbms, fields: string[] = ['title']): InvertedIndex {
  return new InvertedIndex(db, 'articles', fields);
}

// ── persistWordIndex ────────────────────────────────────────────────────────

describe('persistWordIndex', () => {
  it('writes words and docIds to the database', async () => {
    const db = await makeDb();
    const idx = makeIndex(db);
    idx.indexObject({ id: 'a1', title: 'hello world' });
    idx.indexObject({ id: 'a2', title: 'hello earth' });

    await persistWordIndex(db, idx);

    const r = await searchWordIndex(db, 'hello', 10, 0);
    expect(r.total).toBe(2);
    expect(r.docIds).toContain('a1');
    expect(r.docIds).toContain('a2');
  });

  it('skips duplicate words on second call (does not merge)', async () => {
    const db = await makeDb();
    const idx = makeIndex(db);
    idx.indexObject({ id: 'a1', title: 'alpha' });
    await persistWordIndex(db, idx);

    // Second index with a new doc for the same word
    const idx2 = makeIndex(db);
    idx2.indexObject({ id: 'a2', title: 'alpha' });
    await persistWordIndex(db, idx2);

    // persistWordIndex skips duplicates — a2 should NOT appear
    const r = await searchWordIndex(db, 'alpha', 10, 0);
    expect(r.total).toBe(1);
    expect(r.docIds).toContain('a1');
    expect(r.docIds).not.toContain('a2');
  });
});

// ── mergeWordIndex ──────────────────────────────────────────────────────────

describe('mergeWordIndex', () => {
  let db: SimpleDbms;

  beforeEach(async () => {
    db = await makeDb();
  });

  it('behaves like persistWordIndex when the DB is empty (no prior entries)', async () => {
    const idx = makeIndex(db);
    idx.indexObject({ id: 'a1', title: 'quantum physics' });
    idx.indexObject({ id: 'a2', title: 'quantum chemistry' });

    await mergeWordIndex(db, idx);

    const r = await searchWordIndex(db, 'quantum', 10, 0);
    expect(r.total).toBe(2);
    expect(r.docIds).toContain('a1');
    expect(r.docIds).toContain('a2');
  });

  it('merges two chunks with no overlapping words correctly', async () => {
    const idx1 = makeIndex(db);
    idx1.indexObject({ id: 'a1', title: 'apple fruit' });
    await mergeWordIndex(db, idx1);

    const idx2 = makeIndex(db);
    idx2.indexObject({ id: 'a2', title: 'banana fruit' });
    await mergeWordIndex(db, idx2);

    // 'apple' only in chunk 1
    const ra = await searchWordIndex(db, 'apple', 10, 0);
    expect(ra.docIds).toEqual(['a1']);

    // 'banana' only in chunk 2
    const rb = await searchWordIndex(db, 'banana', 10, 0);
    expect(rb.docIds).toEqual(['a2']);

    // 'fruit' in both chunks — should have both docIds
    const rf = await searchWordIndex(db, 'fruit', 10, 0);
    expect(rf.total).toBe(2);
    expect(rf.docIds).toContain('a1');
    expect(rf.docIds).toContain('a2');
  });

  it('does not duplicate docIds when the same word appears in two chunks', async () => {
    const idx1 = makeIndex(db);
    idx1.indexObject({ id: 'doc1', title: 'common word' });
    await mergeWordIndex(db, idx1);

    const idx2 = makeIndex(db);
    idx2.indexObject({ id: 'doc2', title: 'another common word' });
    await mergeWordIndex(db, idx2);

    const r = await searchWordIndex(db, 'common', 100, 0);
    expect(r.total).toBe(2);

    // Verify no duplicates by checking unique count equals total
    const unique = new Set(r.docIds);
    expect(unique.size).toBe(r.total);
  });

  it('does not duplicate a docId that appears in the same word across two chunks', async () => {
    // Simulates the edge case where the same article is re-indexed in two chunks
    const idx1 = makeIndex(db);
    idx1.indexObject({ id: 'same-doc', title: 'unique keyword' });
    await mergeWordIndex(db, idx1);

    const idx2 = makeIndex(db);
    idx2.indexObject({ id: 'same-doc', title: 'unique keyword' });
    await mergeWordIndex(db, idx2);

    const r = await searchWordIndex(db, 'unique', 100, 0);
    expect(r.total).toBe(1);
    expect(r.docIds).toEqual(['same-doc']);
  });

  it('handles merging an empty index without errors', async () => {
    const idx1 = makeIndex(db);
    idx1.indexObject({ id: 'a1', title: 'hello' });
    await mergeWordIndex(db, idx1);

    // Merge empty index — should be a no-op
    const emptyIdx = makeIndex(db);
    await mergeWordIndex(db, emptyIdx);

    const r = await searchWordIndex(db, 'hello', 10, 0);
    expect(r.total).toBe(1);
  });

  it('merges three chunks correctly', async () => {
    for (let chunk = 0; chunk < 3; chunk++) {
      const idx = makeIndex(db);
      idx.indexObject({ id: `doc-${chunk}`, title: `shared term chunk${chunk}` });
      await mergeWordIndex(db, idx);
      idx.clear();
    }

    const r = await searchWordIndex(db, 'shared', 10, 0);
    expect(r.total).toBe(3);
    expect(r.docIds).toContain('doc-0');
    expect(r.docIds).toContain('doc-1');
    expect(r.docIds).toContain('doc-2');

    // No duplicates
    const unique = new Set(r.docIds);
    expect(unique.size).toBe(3);
  });

  it('works correctly with the content index collection', async () => {
    const idx = new InvertedIndex(db, 'articles', ['_content']);
    idx.indexObject({ id: 'art1', _content: 'the quick brown fox' });
    await mergeWordIndex(db, idx, 500, undefined, CONTENT_INDEX_COLLECTION);

    idx.clear();
    idx.indexObject({ id: 'art2', _content: 'the lazy dog' });
    await mergeWordIndex(db, idx, 500, undefined, CONTENT_INDEX_COLLECTION);

    // 'the' appears in both articles
    const r = await searchContentIndex(db, 'the', 10, 0);
    expect(r.total).toBe(2);
    expect(r.docIds).toContain('art1');
    expect(r.docIds).toContain('art2');

    // 'fox' only in art1
    const rf = await searchContentIndex(db, 'fox', 10, 0);
    expect(rf.total).toBe(1);
    expect(rf.docIds).toEqual(['art1']);
  });

  it('pagination still works correctly after merging multiple chunks', async () => {
    // Insert 10 docs across 2 chunks all sharing the word 'shared'
    for (let i = 0; i < 5; i++) {
      const idx = makeIndex(db);
      idx.indexObject({ id: `doc-a-${i}`, title: 'shared topic' });
      await mergeWordIndex(db, idx);
    }
    for (let i = 0; i < 5; i++) {
      const idx = makeIndex(db);
      idx.indexObject({ id: `doc-b-${i}`, title: 'shared topic' });
      await mergeWordIndex(db, idx);
    }

    const page1 = await searchWordIndex(db, 'shared', 6, 0);
    expect(page1.total).toBe(10);
    expect(page1.docIds).toHaveLength(6);
    expect(page1.hasMore).toBe(true);

    const page2 = await searchWordIndex(db, 'shared', 6, 6);
    expect(page2.docIds).toHaveLength(4);
    expect(page2.hasMore).toBe(false);

    // All 10 unique
    const all = [...page1.docIds, ...page2.docIds];
    expect(new Set(all).size).toBe(10);
  });
});

// ── InvertedIndex.clear() ───────────────────────────────────────────────────

describe('InvertedIndex.clear()', () => {
  it('resets wordCount to 0', async () => {
    const db = await makeDb();
    const idx = makeIndex(db);
    idx.indexObject({ id: 'a1', title: 'hello world' });
    expect(idx.wordCount).toBeGreaterThan(0);

    idx.clear();
    expect(idx.wordCount).toBe(0);
  });

  it('returns empty search results after clear', async () => {
    const db = await makeDb();
    const idx = makeIndex(db);
    idx.indexObject({ id: 'a1', title: 'hello world' });
    idx.clear();

    expect(idx.search('hello')).toEqual([]);
    expect(idx.words).toEqual([]);
  });

  it('can be re-used after clear', async () => {
    const db = await makeDb();
    const idx = makeIndex(db);
    idx.indexObject({ id: 'a1', title: 'first batch' });
    idx.clear();

    idx.indexObject({ id: 'a2', title: 'second batch' });
    expect(idx.search('second')).toContain('a2');
    expect(idx.search('first')).toEqual([]);
  });
});
