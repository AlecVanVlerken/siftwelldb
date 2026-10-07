/**
 * Quick seed script — inserts sample articles for demo/testing.
 * Run with: npx tsx scripts/seed-articles.mts <database.db> [--count N]
 */

import * as fsp from 'node:fs/promises';
import { SimpleDbms } from '../src/database/simpledbms.mjs';
import { RealFile } from '../src/storage/file.mjs';
import { bulkImportStream } from '../src/database/bulkimport.mjs';
import { InvertedIndex } from '../src/indexes/text/invertedindex.mjs';
import { persistWordIndex, CONTENT_INDEX_COLLECTION } from '../src/indexes/text/wordindex.mjs';

const TOPICS = [
  'Amsterdam',
  'Rotterdam',
  'Den Haag',
  'Utrecht',
  'Eindhoven',
  'Groningen',
  'Tilburg',
  'Almere',
  'Breda',
  'Nijmegen',
  'Voetbal',
  'Tennis',
  'Wielrennen',
  'Zwemmen',
  'Atletiek',
  'Biologie',
  'Scheikunde',
  'Natuurkunde',
  'Wiskunde',
  'Informatica',
  'Muziek',
  'Schilderkunst',
  'Architectuur',
  'Literatuur',
  'Film',
  'Nederland',
  'België',
  'Duitsland',
  'Frankrijk',
  'Spanje',
  'Rembrandt',
  'Van Gogh',
  'Vermeer',
  'Mondriaan',
  'Escher',
  'Tulpen',
  'Molens',
  'Fietsen',
  'Kaas',
  'Klompen',
  'Wetenschap',
  'Technologie',
  'Geschiedenis',
  'Aardrijkskunde',
  'Economie',
];

function makeArticle(i: number): Record<string, unknown> {
  const topic = TOPICS[i % TOPICS.length];
  const suffix = i >= TOPICS.length ? ` ${Math.floor(i / TOPICS.length) + 1}` : '';
  const title = `${topic}${suffix}`;
  return {
    id: title.replace(/ /g, '_'),
    title,
    _content:
      `Dit is een artikel over ${title}. Het bevat informatie over ${topic.toLowerCase()} en verwante onderwerpen. ` +
      `Dit artikel is nummer ${i + 1} in de collectie en dient als testdata voor de SimpleDBMS demonstratie.`,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dbPath = args[0];
  const countIdx = args.indexOf('--count');
  const count = countIdx !== -1 ? parseInt(args[countIdx + 1] ?? '200', 10) : 200;

  if (!dbPath) {
    console.error('Usage: scripts/seed-articles.mts <database.db> [--count N]');
    process.exit(1);
  }

  const dataFile = new RealFile(dbPath);
  const logFile = new RealFile(`${dbPath}.log`);

  let db: SimpleDbms;
  try {
    await fsp.access(dbPath);
    db = await SimpleDbms.open(dataFile, logFile);
    console.log(`Opened existing database: ${dbPath}`);
  } catch {
    db = await SimpleDbms.create(dataFile, logFile);
    await db.commit();
    console.log(`Created new database: ${dbPath}`);
  }

  const COLLECTION = 'articles';
  const index = new InvertedIndex(db, COLLECTION, ['title']);
  const contentIndex = new InvertedIndex(db, COLLECTION, ['_content']);

  function* docs(): Generator<Record<string, unknown>> {
    for (let i = 0; i < count; i++) {
      const doc = makeArticle(i);
      index.indexObject(doc);
      contentIndex.indexObject(doc);
      yield doc;
    }
  }

  console.log(`Inserting ${count} sample articles...`);
  const result = await bulkImportStream(db, docs(), {
    collection: COLLECTION,
    batchSize: 100,
    onBatchComplete: ({ totalImported }) => console.log(`  ${totalImported} inserted...`),
  });
  console.log(`Done: ${result.totalImported} articles inserted.`);

  console.log(`Building title index (${index.wordCount} words)...`);
  await persistWordIndex(db, index, 500, (n) => console.log(`  ${n} words persisted...`));
  console.log('Title index done.');

  console.log(`Building content index (${contentIndex.wordCount} words)...`);
  await persistWordIndex(db, contentIndex, 500, undefined, CONTENT_INDEX_COLLECTION);
  console.log('Content index done.');

  await db.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
