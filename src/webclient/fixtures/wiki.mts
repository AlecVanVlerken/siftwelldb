import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type WikiArticle = {
  id: string;
  title: string;
  summary: string;
  body: string;
  _infobox: string;
  'thumbnail.jpeg'?: string;
  _order_: string;
  '_layout_thumbnail.jpeg'?: string;
};

export type WikiArticleGeneratorOptions = {
  count?: number;
  imageDir?: string;
  wikiXmlPath?: string;
};

const DEFAULT_COUNT = 100;
const THUMBNAIL_PROBABILITY = 0.72;
const MAX_IMAGE_FILES = 100;

const DEFAULT_WIKI_XML = path.join(os.homedir(), 'Downloads', 'Wikipedia-20260505132706.xml');
const DEFAULT_IMAGE_DIR = path.join(os.homedir(), 'Downloads', 'Memes_template');

// A tiny valid JPEG base. Deterministic high-entropy tails are appended so the
// fixtures behave like already-compressed photos without requiring large files.
const JPEG_BASE = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
  'base64',
);

const FALLBACK_TOPICS = [
  'Ancient hammock',
  'Canal observatory',
  'Brussels glass archive',
  'Harbour clockwork',
  'North sea atlas',
  'University herbarium',
  'Ceramic signal tower',
  'Steam tram registry',
  'Meadow radio station',
  'Flemish textile guild',
];

type ParsedWikiPage = {
  title: string;
  body: string;
};

function fixtureBytes(seed: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  let counter = 0;
  while (offset < bytes.length) {
    const chunk = createHash('sha256').update(`${seed}:${counter}`).digest();
    chunk.copy(bytes, offset);
    offset += chunk.length;
    counter++;
  }
  return bytes;
}

function jpegFixture(index: number): string {
  const tails = [12_200, 15_500, 10_800, 17_250];
  const tail = fixtureBytes(0x5eed + index * 97, tails[index % tails.length]);
  return Buffer.concat([JPEG_BASE, tail]).toString('base64');
}

const JPEG_FIXTURES = [jpegFixture(0), jpegFixture(1), jpegFixture(2), jpegFixture(3)];

function xmlValue(page: string, tag: string): string | null {
  const match = page.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? decodeXml(match[1]) : null;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

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

function stripWikitext(text: string): string {
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = removeNested(text, '{{', '}}');
  text = text.replace(/\[\[(?:File|Image|Bestand|Afbeelding|Categorie|Category):[^\]]*\]\]/gi, '');
  text = text.replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1');
  text = text.replace(/\[https?:\/\/[^\s\]]+\s([^\]]+)\]/g, '$1');
  text = text.replace(/\[https?:\/\/[^\]]*\]/g, '');
  text = text.replace(/={2,6}\s*([^=]+?)\s*={2,6}/g, '\n\n$1\n');
  text = text.replace(/<ref[\s\S]*?<\/ref>/gi, '');
  text = text.replace(/<ref[^/>]*\/>/gi, '');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/^\s*[|!{].*$/gm, '');
  text = text.replace(/'{2,5}/g, '');
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseWikiXml(xmlPath: string): ParsedWikiPage[] {
  let xml: string;
  try {
    xml = fs.readFileSync(xmlPath, 'utf8');
  } catch {
    return [];
  }

  const pages: ParsedWikiPage[] = [];
  for (const match of xml.matchAll(/<page>[\s\S]*?<\/page>/g)) {
    const page = match[0];
    const ns = xmlValue(page, 'ns');
    const title = xmlValue(page, 'title');
    const rawText = xmlValue(page, 'text');
    if (ns !== '0' || !title || !rawText || /<redirect\b/i.test(page)) continue;

    const body = stripWikitext(rawText);
    if (body.length < 160) continue;
    pages.push({ title, body });
  }

  return pages;
}

function imageDirs(explicitDir?: string): string[] {
  return [
    explicitDir,
    process.env['WIKI_LAB_IMAGE_DIR'],
    DEFAULT_IMAGE_DIR,
    path.join(process.cwd(), 'attachment'),
    path.join(process.cwd(), 'attachments'),
  ].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
}

function loadJpegs(explicitDir?: string): string[] {
  const seen = new Set<string>();
  const files: string[] = [];

  for (const dir of imageDirs(explicitDir)) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_IMAGE_FILES) break;
      if (entry.isFile() && /\.jpe?g$/i.test(entry.name)) {
        files.push(path.join(resolved, entry.name));
      }
    }
    if (files.length > 0) break;
  }

  return files.sort((a, b) => a.localeCompare(b)).map((file) => fs.readFileSync(file).toString('base64'));
}

function fallbackBody(topic: string, index: number): string {
  const paragraphs: string[] = [];
  for (let section = 0; section < 18; section++) {
    paragraphs.push(
      [
        `${topic} is referenced in regional catalogues, municipal inventories, and field notes from the same archive series.`,
        `The article records aliases, measurements, accession numbers, ownership changes, and restoration notes for ${topic}.`,
        `Cross references repeatedly mention ${topic}, catalog shelf ${index % 17}, and the same inspection route.`,
        `Editors retained the phrase documented example across revisions to keep the dataset deliberately redundant for compression study.`,
      ].join(' '),
    );
  }
  return paragraphs.join('\n\n');
}

function bodyForPage(page: ParsedWikiPage, index: number): string {
  const trimmed = page.body.length > 5_500 ? `${page.body.slice(0, 5_500).trim()}...` : page.body;
  return `${trimmed}\n\nCompression lab note: this imported Wikipedia article is stored with a local media sample, revision-style text, repeated title "${page.title}", and field-level metadata for compression comparison ${index}.`;
}

function summaryForBody(body: string): string {
  const firstParagraph = body.split(/\n\s*\n/).find((part) => part.trim().length > 0) ?? body;
  return firstParagraph.replace(/\s+/g, ' ').trim().slice(0, 260);
}

function infobox(title: string, index: number, source: string): string {
  const rows = [
    ['name', title],
    ['type', 'Wikipedia import'],
    ['source', source],
    ['catalogue', `WIKI-LAB-${String(index).padStart(4, '0')}`],
    ['status', 'imported'],
    ['media', 'local meme template folder'],
  ];
  return rows.map(([key, value]) => `${key}: ${value}`).join('\n');
}

export function generateWikiArticles(options: WikiArticleGeneratorOptions = {}): WikiArticle[] {
  const requestedCount = Math.max(1, Math.floor(options.count ?? DEFAULT_COUNT));
  const wikiPath = options.wikiXmlPath ?? process.env['WIKI_LAB_XML'] ?? DEFAULT_WIKI_XML;
  const pages = parseWikiXml(wikiPath);
  const images = loadJpegs(options.imageDir);
  const count = pages.length > 0 ? Math.min(requestedCount, pages.length) : requestedCount;
  const articles: WikiArticle[] = [];

  for (let i = 0; i < count; i++) {
    const page = pages[i];
    const title =
      page?.title ?? `${FALLBACK_TOPICS[i % FALLBACK_TOPICS.length]} ${Math.floor(i / FALLBACK_TOPICS.length) + 1}`;
    const body = page ? bodyForPage(page, i) : fallbackBody(title, i);
    const hasThumbnail = i === 0 || (i * 37) % 100 < THUMBNAIL_PROBABILITY * 100;
    const article: WikiArticle = {
      id: `wiki-${String(i + 1).padStart(3, '0')}`,
      title,
      summary: summaryForBody(body),
      body,
      _infobox: infobox(title, i, page ? path.basename(wikiPath) : 'fallback fixture'),
      _order_: 'summary,thumbnail.jpeg,body,_infobox',
    };

    if (hasThumbnail) {
      article['thumbnail.jpeg'] =
        images.length > 0 ? images[i % images.length] : JPEG_FIXTURES[i % JPEG_FIXTURES.length];
      article['_layout_thumbnail.jpeg'] = 'right';
    }

    articles.push(article);
  }

  return articles;
}
