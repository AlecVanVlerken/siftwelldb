import { describe, expect, it, beforeEach } from 'vitest';
import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { SimpleDbms } from '../../../database/simpledbms.mjs';
import { InvertedIndex, tokenize } from '../invertedindex.mjs';

describe('tokenize', () => {
  it('lowercases and splits on whitespace', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('strips punctuation', () => {
    expect(tokenize("it's a test, right?")).toEqual(['it', 's', 'a', 'test', 'right']);
  });

  it('handles multiple spaces', () => {
    expect(tokenize('  foo   bar  ')).toEqual(['foo', 'bar']);
  });

  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('keeps numbers', () => {
    expect(tokenize('version 3 beta2')).toEqual(['version', '3', 'beta2']);
  });
});

describe('InvertedIndex', () => {
  let db: SimpleDbms;
  let idx: InvertedIndex;

  const articles = [
    { id: 'a1', title: 'Introduction to Databases', body: 'Databases store data efficiently' },
    { id: 'a2', title: 'Advanced Indexing', body: 'Inverted indexes speed up text search' },
    { id: 'a3', title: 'Database Performance', body: 'Indexes help databases perform better' },
    { id: 'a4', title: 'Web Development', body: 'Modern web apps use databases and APIs' },
  ];

  beforeEach(async () => {
    const dataFile = new MockFile(256);
    const logFile = new MockFile(4096);
    db = await SimpleDbms.create(dataFile, logFile);
    idx = new InvertedIndex(db, 'articles');

    for (const article of articles) {
      await idx.addDocument(article);
    }
    await db.commit();
  });

  describe('single word search', () => {
    it('finds documents containing a word', () => {
      const results = idx.search('databases');
      expect(results).toContain('a1');
      expect(results).toContain('a3');
      expect(results).toContain('a4');
    });

    it('is case insensitive', () => {
      const results = idx.search('DATABASES');
      expect(results.length).toBeGreaterThan(0);
    });

    it('returns empty for unknown word', () => {
      expect(idx.search('nonexistent')).toEqual([]);
    });

    it('finds word in title field', () => {
      const results = idx.search('introduction');
      expect(results).toContain('a1');
    });

    it('finds word in body field', () => {
      const results = idx.search('efficiently');
      expect(results).toEqual(['a1']);
    });
  });

  describe('AND search (searchAll)', () => {
    it('returns documents matching all words', () => {
      const results = idx.searchAll(['databases', 'store']);
      expect(results).toEqual(['a1']);
    });

    it('returns empty when no document matches all words', () => {
      const results = idx.searchAll(['databases', 'nonexistent']);
      expect(results).toEqual([]);
    });

    it('works with single word', () => {
      const results = idx.searchAll(['web']);
      expect(results).toContain('a4');
    });
  });

  describe('OR search (searchAny)', () => {
    it('returns documents matching any word', () => {
      const results = idx.searchAny(['introduction', 'web']);
      expect(results).toContain('a1');
      expect(results).toContain('a4');
    });

    it('returns empty for no matches', () => {
      expect(idx.searchAny(['xyz', 'abc'])).toEqual([]);
    });
  });

  describe('buildFromExisting', () => {
    it('rebuilds index from database', async () => {
      // Create a new index without adding docs through it
      const freshIdx = new InvertedIndex(db, 'articles');
      expect(freshIdx.wordCount).toBe(0);

      await freshIdx.buildFromExisting('id');
      expect(freshIdx.wordCount).toBeGreaterThan(0);

      const results = freshIdx.search('databases');
      expect(results).toContain('a1');
      expect(results).toContain('a3');
    });
  });

  describe('removeDocument', () => {
    it('removes a document from the index', () => {
      expect(idx.search('databases')).toContain('a1');

      idx.removeDocument('a1');

      expect(idx.search('databases')).not.toContain('a1');
      // Others should still be there
      expect(idx.search('databases')).toContain('a3');
    });
  });

  describe('field filtering', () => {
    it('only indexes specified fields', async () => {
      const filteredDb = await SimpleDbms.create(new MockFile(256), new MockFile(4096));
      const filteredIdx = new InvertedIndex(filteredDb, 'articles', ['title']);

      await filteredIdx.addDocument({
        id: 'f1',
        title: 'Alpha Beta',
        body: 'Gamma Delta',
      });

      // 'alpha' is in the title (indexed)
      expect(filteredIdx.search('alpha')).toContain('f1');
      // 'gamma' is in the body (not indexed)
      expect(filteredIdx.search('gamma')).toEqual([]);
    });
  });

  describe('wordCount and words', () => {
    it('tracks word count', () => {
      expect(idx.wordCount).toBeGreaterThan(0);
    });

    it('returns all indexed words', () => {
      const words = idx.words;
      expect(words).toContain('databases');
      expect(words).toContain('indexing');
    });
  });

  describe('documents actually stored in DB', () => {
    it('can retrieve indexed documents from the database', async () => {
      const doc = await db.getDocumentById('articles', 'a1');
      const parsed = JSON.parse(doc) as Record<string, unknown>;
      expect(parsed['title']).toBe('Introduction to Databases');
    });
  });
});
