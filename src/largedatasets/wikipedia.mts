/**
 * Dutch Wikipedia XML dump importer for SimpleDbms.
 *
 * Streams a Wikipedia XML dump, extracts namespace-0 articles, strips
 * wikitext markup, inserts them via bulkImportStream, then builds and
 * persists a title-only word index.
 *
 * Usage (after building):
 *   node build/largedatasets/wikipedia.mjs <dump.xml[.gz]> <db.db> [--limit N]
 *
 * Or directly with tsx:
 *   tsx src/largedatasets/wikipedia.mts <dump.xml[.gz]> <db.db> [--limit N]
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as zlib from 'node:zlib';
import * as readline from 'node:readline';
import { SimpleDbms } from '../dbms/simpledbms.mjs';
import { RealFile } from '../core/file.mjs';
import { bulkImportStream } from './bulkimport.mjs';
import { InvertedIndex } from './invertedindex.mjs';
import { persistWordIndex, mergeWordIndex, CONTENT_INDEX_COLLECTION } from './wordindex.mjs';

// ── Wikitext stripping ───────────────────────────────────────

function removeNested(text: string, open: string, close: string): string {
  let result = '';
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith(open, i)) {
      depth++;
      i += open.length;
    } else if (depth > 0 && text.startsWith(close, i)) {
      depth--;
      i += close.length;
    } else {
      if (depth === 0) result += text[i];
      i++;
    }
  }
  return result;
}

export function stripWikitext(text: string): string {
  // HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // Templates {{...}} (nested)
  text = removeNested(text, '{{', '}}');
  // File/Image links (nl: Bestand/Afbeelding)
  text = text.replace(/\[\[(?:File|Image|Bestand|Afbeelding|Categorie|Category):[^\]]*\]\]/gi, '');
  // [[link|display]] → display, [[link]] → link
  text = text.replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1');
  // External links [http://... text] → text
  text = text.replace(/\[https?:\/\/[^\s\]]+\s([^\]]+)\]/g, '$1');
  text = text.replace(/\[https?:\/\/[^\]]*\]/g, '');
  // Section headers → plain text
  text = text.replace(/={2,6}\s*([^=]+?)\s*={2,6}/g, '$1');
  // HTML tags
  text = text.replace(/<[^>]+>/g, '');
  // Table rows
  text = text.replace(/^\s*[|!{].*$/gm, '');
  // Bold/italic
  text = text.replace(/'{2,3}/g, '');
  // Normalize whitespace
  return text.replace(/\s+/g, ' ').trim();
}

// ── Article ID from title ────────────────────────────────────

function titleToId(title: string): string {
  // Mirrors MediaWiki's canonical URL encoding (spaces → underscores)
  return title.replace(/ /g, '_');
}

// ── Streaming XML parser ─────────────────────────────────────

interface WikiArticle {
  id: string;
  title: string;
  _content: string;
}

async function* parseWikipediaDump(filePath: string, limit = Infinity): AsyncGenerator<WikiArticle> {
  const raw = fs.createReadStream(filePath);
  const input = filePath.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let title = '';
  let ns = '';
  let textBuf: string[] = [];
  let inText = false;
  let isRedirect = false;
  let yielded = 0;

  for await (const line of rl) {
    if (yielded >= limit) break;
    const trimmed = line.trim();

    if (trimmed.startsWith('<title>') && trimmed.includes('</title>')) {
      title = trimmed.slice(trimmed.indexOf('<title>') + 7, trimmed.indexOf('</title>'));
    } else if (trimmed.startsWith('<ns>') && trimmed.includes('</ns>')) {
      ns = trimmed.slice(4, trimmed.indexOf('</ns>'));
    } else if (trimmed.includes('<redirect ') || trimmed === '<redirect/>') {
      isRedirect = true;
    } else if (trimmed.startsWith('<text')) {
      inText = true;
      // content may start on the same line after the closing >
      const gtIdx = trimmed.indexOf('>');
      if (gtIdx !== -1) {
        const rest = trimmed.slice(gtIdx + 1);
        if (rest.endsWith('</text>')) {
          textBuf.push(rest.slice(0, -7));
          inText = false;
        } else {
          textBuf.push(rest);
        }
      }
    } else if (inText) {
      if (line.includes('</text>')) {
        textBuf.push(line.slice(0, line.indexOf('</text>')));
        inText = false;
      } else {
        textBuf.push(line);
      }
    } else if (trimmed === '</page>') {
      if (ns === '0' && title && !isRedirect) {
        const rawText = textBuf.join('\n');
        const _content = stripWikitext(rawText);
        yield { id: titleToId(title), title, _content };
        yielded++;
      }
      title = '';
      ns = '';
      textBuf = [];
      inText = false;
      isRedirect = false;
    }
  }
}

// ── Main import function ─────────────────────────────────────

export async function importWikipedia(
  dumpPath: string,
  dbPath: string,
  options: { limit?: number; batchSize?: number } = {},
): Promise<void> {
  const { limit = Infinity, batchSize = 500 } = options;

  const t0 = Date.now();
  console.log(`Opening database: ${dbPath}`);

  const dataFile = new RealFile(dbPath);
  const logFile = new RealFile(`${dbPath}.log`);

  let db: SimpleDbms;
  try {
    await fsp.access(dbPath);
    db = await SimpleDbms.open(dataFile, logFile);
  } catch {
    db = await SimpleDbms.create(dataFile, logFile);
    await db.commit();
  }

  const COLLECTION = 'articles';
  const index = new InvertedIndex(db, COLLECTION, ['title']);
  const contentIndex = new InvertedIndex(db, COLLECTION, ['_content']);

  // Flush the content index to disk every CHUNK_SIZE articles so the
  // in-memory index never grows beyond ~2-3 GB regardless of dataset size.
  const CHUNK_SIZE = 50_000;
  let totalInserted = 0;
  let chunkArticleCount = 0;
  let contentChunksDone = 0;

  async function flushContentChunk(): Promise<void> {
    if (contentIndex.wordCount === 0) return;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  [${elapsed}s] Flushing content index chunk ${contentChunksDone + 1} (${contentIndex.wordCount} words)...`);
    await mergeWordIndex(db, contentIndex, 500, undefined, CONTENT_INDEX_COLLECTION);
    contentIndex.clear();
    chunkArticleCount = 0;
    contentChunksDone++;
  }

  // Stream articles, build both in-memory indexes, flush content index periodically
  async function* articleStream(): AsyncGenerator<Record<string, unknown>> {
    for await (const article of parseWikipediaDump(dumpPath, limit)) {
      const doc = article as unknown as Record<string, unknown>;
      index.indexObject(doc);
      contentIndex.indexObject(doc);
      chunkArticleCount++;
      yield doc;

      if (chunkArticleCount >= CHUNK_SIZE) {
        await flushContentChunk();
      }
    }
  }

  console.log('Importing articles...');
  const result = await bulkImportStream(db, articleStream(), {
    collection: COLLECTION,
    batchSize,
    onBatchComplete: ({ totalImported, batchNumber }) => {
      totalInserted = totalImported;
      if (batchNumber % 10 === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`  [${elapsed}s] ${totalImported} articles imported (batch ${batchNumber})`);
      }
    },
  });

  totalInserted = result.totalImported;
  console.log(`Import done: ${totalInserted} articles, ${result.failedCount} errors.`);
  if (result.errors.length > 0) {
    console.warn('First errors:', result.errors.slice(0, 5));
  }

  // Flush the final partial content index chunk
  await flushContentChunk();
  console.log(`Content index fully persisted (${contentChunksDone} chunks).`);

  console.log(`Building title word index (${index.wordCount} unique words)...`);
  let wordsDone = 0;
  await persistWordIndex(db, index, 500, (n) => {
    wordsDone = n;
    if (n % 5000 === 0) console.log(`  ${n} words persisted...`);
  });
  console.log(`Title index persisted (${wordsDone} words total).`);

  await db.close();

  // Verify the index was persisted correctly by reopening the DB fresh.
  console.log('Verifying index (fresh DB open)...');
  const db2 = await SimpleDbms.open(new RealFile(dbPath), new RealFile(`${dbPath}.log`));
  const { searchWordIndex } = await import('./wordindex.mjs');
  for (const probe of ['amsterdam', 'nederland', '11', 'van']) {
    const r = await searchWordIndex(db2, probe, 5, 0);
    console.log(`  probe "${probe}": ${r.total} docs`);
  }
  await db2.close();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s.`);
}

// ── CLI entry point ──────────────────────────────────────────

if (process.argv[1] && process.argv[1].includes('wikipedia')) {
  const args = process.argv.slice(2);
  const dumpPath = args[0];
  const dbPath = args[1];
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1] ?? '0', 10) : undefined;

  if (!dumpPath || !dbPath) {
    console.error('Usage: wikipedia.mts <dump.xml[.gz]> <database.db> [--limit N]');
    process.exit(1);
  }

  importWikipedia(dumpPath, dbPath, { limit }).catch((err: unknown) => {
    console.error('Import failed:', err);
    process.exit(1);
  });
}
