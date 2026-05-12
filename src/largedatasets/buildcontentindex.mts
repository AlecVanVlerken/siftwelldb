/**
 * Builds (or rebuilds) the _content_index collection from existing articles.
 *
 * Use this when the DB already has articles imported but _content_index is
 * missing (e.g. it was added after the initial import).
 *
 * Usage:
 *   node build/largedatasets/buildcontentindex.mjs <database.db>
 *   tsx src/largedatasets/buildcontentindex.mts <database.db>
 */

import { SimpleDbms } from '../dbms/simpledbms.mjs';
import { RealFile } from '../core/file.mjs';
import { InvertedIndex } from './invertedindex.mjs';
import { persistWordIndex, CONTENT_INDEX_COLLECTION } from './wordindex.mjs';
import { fetchPageCursor } from './pagination.mjs';

const COLLECTION = 'articles';
const PAGE_SIZE = 500;

async function buildContentIndex(dbPath: string): Promise<void> {
  const t0 = Date.now();
  console.log(`Opening database: ${dbPath}`);

  const db = await SimpleDbms.open(new RealFile(dbPath), new RealFile(`${dbPath}.log`));

  const contentIndex = new InvertedIndex(db, COLLECTION, ['_content']);

  console.log('Reading existing articles and building content index in memory...');
  let total = 0;
  let cursor: string | number | undefined = undefined;

  while (true) {
    const page = await fetchPageCursor(db, {
      collection: COLLECTION,
      iterableKey: 'id',
      limit: PAGE_SIZE,
      afterCursor: cursor,
    });

    for (const raw of page.data) {
      const doc = JSON.parse(raw) as Record<string, unknown>;
      contentIndex.indexObject(doc);
      total++;
    }

    if (total % 5000 === 0 && total > 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [${elapsed}s] ${total} articles processed...`);
    }

    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }

  console.log(`Processed ${total} articles. ${contentIndex.wordCount} unique words found.`);
  console.log('Persisting content index to database...');

  let wordsDone = 0;
  await persistWordIndex(
    db,
    contentIndex,
    500,
    (n) => {
      wordsDone = n;
      if (n % 5000 === 0) console.log(`  ${n} words persisted...`);
    },
    CONTENT_INDEX_COLLECTION,
  );

  console.log(`Content index persisted (${wordsDone} words total).`);
  await db.close();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s.`);
}

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Usage: buildcontentindex.mts <database.db>');
  process.exit(1);
}

buildContentIndex(dbPath).catch((err: unknown) => {
  console.error('Failed:', err);
  process.exit(1);
});
