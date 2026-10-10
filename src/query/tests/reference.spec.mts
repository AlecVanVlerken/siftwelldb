import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { SimpleDbms } from '../../database/simpledbms.mjs';
import { QueryLanguage } from '../querylanguage.mjs';

describe('bundled SQL reference', () => {
  it('runs every published example through the real parser and executor', async () => {
    const reference = JSON.parse(
      await readFile(new URL('../../webclient/frontend/sql-reference.json', import.meta.url), 'utf8'),
    ) as { sections: { id: string; examples: string[] }[] };
    const db = await SimpleDbms.create(new MockFile(4096), new MockFile(4096));
    await db.setFieldIndexed('articles', 'body', false);
    const documents = [
      { id: 42, title: 'Data_a_b', year: 2024, category: 'Science', author: "O'Brien", body: 'database a_b % .*[]' },
      { id: 43, title: 'Data other', year: 2025, category: 'Science', author: 'Alice', body: 'database' },
      { id: 44, title: 'Archive', year: 1990, category: 'Technology', author: 'Alice', body: 'old' },
    ];
    for (const document of documents) await db.insertDocumentObject('articles', document);
    try {
      const sql = new QueryLanguage(db);
      const expected: Record<string, unknown[]> = {
        overview: [documents, [{ heading: 'Data_a_b' }]],
        select: [[], [{ category: 'Science' }, { category: 'Technology' }]],
        filters: [
          [{ id: 42 }, { id: 43 }, { id: 44 }],
          [{ id: 42 }],
          [{ title: 'Data_a_b' }, { title: 'Data other' }],
          [{ id: 42 }],
        ],
        aggregates: [
          [{ category: 'Science', n: 2, average_year: 2024.5 }],
          [{ category: 'Science' }],
          [{ n: 0, total: null }],
        ],
        writes: [[{ id: 7 }], [{ id: 7 }], [{ id: 7 }], [{ id: 44 }]],
        plans: [
          ['collection', 'scan', 'filter', 'project'],
          ['collection', 'scan', 'filter', 'sort', 'slice', 'project'],
        ],
        unsupported: [],
      };
      for (const section of reference.sections) {
        expect(section.examples).toHaveLength(expected[section.id].length);
        for (const [i, example] of section.examples.entries()) {
          const rows = await sql.execute(example);
          expect(section.id === 'plans' ? rows.map((row) => row['stage']) : rows).toEqual(expected[section.id][i]);
        }
      }
      expect(await sql.execute('SELECT id FROM articles ORDER BY id')).toEqual([{ id: 42 }, { id: 43 }]);
      expect(await sql.execute('SELECT * FROM numbers')).toEqual([]);
    } finally {
      await db.close();
    }
  });
  it('keeps the README synchronized with the bundled content', () => {
    expect(() => execFileSync(process.execPath, ['scripts/build-sql-reference.mjs', '--check'])).not.toThrow();
  });
});
