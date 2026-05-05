// @author Codex
// @date 2026-05-05

import { createHash } from 'node:crypto';

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
};

const DEFAULT_COUNT = 100;
const THUMBNAIL_PROBABILITY = 0.62;

// A tiny valid JPEG base. Deterministic high-entropy tails are appended so the
// fixtures behave like already-compressed photos without requiring large files.
const JPEG_BASE = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
  'base64',
);

const TOPICS = [
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

const CATEGORIES = [
  'History',
  'Engineering',
  'Architecture',
  'Geography',
  'Culture',
  'Transport',
  'Science',
  'Collections',
];

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

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

function sentence(topic: string, index: number): string {
  const category = CATEGORIES[index % CATEGORIES.length].toLowerCase();
  return `${topic} is referenced in regional ${category} catalogues, municipal inventories, and field notes from the same archive series.`;
}

function bodyText(topic: string, index: number): string {
  const paragraphs: string[] = [];
  for (let section = 0; section < 18; section++) {
    const repeated = [
      sentence(topic, index + section),
      `The article records aliases, measurements, accession numbers, ownership changes, and restoration notes for ${topic}.`,
      `Cross references repeatedly mention ${topic}, the surrounding district, catalog shelf ${index % 17}, and the same inspection route.`,
      `Editors retained the phrase "documented example" across revisions to keep the dataset deliberately redundant for compression study.`,
    ];
    paragraphs.push(repeated.join(' '));
  }
  return paragraphs.join('\n\n');
}

function infobox(topic: string, index: number): string {
  const rows = [
    ['name', topic],
    ['type', CATEGORIES[index % CATEGORIES.length]],
    ['country', 'Belgium'],
    ['region', ['Flanders', 'Brussels', 'Wallonia'][index % 3]],
    ['catalogue', `WIKI-LAB-${String(index).padStart(4, '0')}`],
    ['status', index % 5 === 0 ? 'restored' : 'documented'],
    ['source', 'municipal archive'],
    ['source', 'municipal archive'],
    ['source', 'municipal archive'],
  ];
  return rows.map(([key, value]) => `${key}: ${value}`).join('\n');
}

export function generateWikiArticles(options: WikiArticleGeneratorOptions = {}): WikiArticle[] {
  const count = Math.max(1, Math.floor(options.count ?? DEFAULT_COUNT));
  const next = lcg(0xdecafbad);
  const articles: WikiArticle[] = [];

  for (let i = 0; i < count; i++) {
    const topic = `${TOPICS[i % TOPICS.length]} ${Math.floor(i / TOPICS.length) + 1}`;
    const hasThumbnail = i === 0 || next() < THUMBNAIL_PROBABILITY;
    const article: WikiArticle = {
      id: `wiki-${String(i + 1).padStart(3, '0')}`,
      title: topic,
      summary: `${topic}: archived entry.`,
      body: bodyText(topic, i),
      _infobox: infobox(topic, i),
      _order_: 'summary,thumbnail.jpeg,body,_infobox',
    };

    if (hasThumbnail) {
      article['thumbnail.jpeg'] = JPEG_FIXTURES[i % JPEG_FIXTURES.length];
      article['_layout_thumbnail.jpeg'] = 'right';
    }

    articles.push(article);
  }

  return articles;
}
