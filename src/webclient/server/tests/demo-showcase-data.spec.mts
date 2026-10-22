import { describe, expect, it } from 'vitest';
import {
  generateDemoArticles,
  generateDemoOrders,
  generateDemoProducts,
  generateShowcaseCollections,
  SHOWCASE_DEFAULT_COUNTS,
} from '../demo-showcase-data.mjs';

describe('deterministic showcase content', () => {
  it('generates substantial collections with unique document IDs and supported flat values', () => {
    const collections = generateShowcaseCollections();
    expect(collections.map(({ name, documents }) => [name, documents.length])).toEqual([
      ['employees', 200],
      ['products', 160],
      ['orders', 400],
      ['knowledge', 31],
      ['articles', 240],
      ['travel_guides', 64],
      ['support_tickets', 120],
    ]);
    expect(collections.reduce((total, collection) => total + collection.documents.length, 0)).toBe(1215);
    const ids = new Set<string>();
    for (const collection of collections) {
      for (const document of collection.documents) {
        expect(typeof document['id']).toBe('string');
        const id = String(document['id']);
        expect(ids.has(id)).toBe(false);
        ids.add(id);
        for (const value of Object.values(document)) {
          expect(['string', 'number', 'boolean']).toContain(typeof value);
          if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
          if (typeof value === 'string') expect(value.isWellFormed()).toBe(true);
        }
      }
    }
  });

  it('returns deterministic independent copies and honours small collection counts', () => {
    const counts = { employees: 2, products: 3, orders: 7, articles: 4, travel_guides: 2, support_tickets: 3 };
    const first = generateShowcaseCollections(counts);
    const second = generateShowcaseCollections(counts);
    expect(first).toEqual(second);
    first[0].documents[0]['name'] = 'Changed name';
    expect(second[0].documents[0]['name']).not.toBe('Changed name');
    expect(generateShowcaseCollections(counts)).toEqual(second);
    expect(SHOWCASE_DEFAULT_COUNTS.articles).toBe(240);
  });

  it('keeps orders consistent with their product, quantity, price and calendar date', () => {
    const products = generateDemoProducts();
    const byId = new Map(products.map((product) => [product['id'], product]));
    const orders = generateDemoOrders(products);
    for (const order of orders) {
      const product = byId.get(order['productId']);
      expect(product).toBeDefined();
      expect(order['unitPrice']).toBe(product?.['price']);
      const quantity = Number(order['quantity']);
      expect(quantity).toBeGreaterThanOrEqual(1);
      expect(quantity).toBeLessThanOrEqual(5);
      expect(order['total']).toBe((Math.round(Number(product?.['price']) * 100) * quantity) / 100);
      const date = String(order['orderDate']);
      expect(new Date(date).toISOString().slice(0, 10)).toBe(date);
    }
    expect(new Set(orders.map((order) => order['productId'])).size).toBe(products.length);
    expect(new Set(orders.map((order) => order['status'])).size).toBe(5);
    for (const product of products) {
      expect(product['available']).toBe(Number(product['stock']) > 0);
      expect(Number(product['price'])).toBeGreaterThan(0);
      expect(Number(product['rating'])).toBeGreaterThanOrEqual(1);
      expect(Number(product['rating'])).toBeLessThanOrEqual(5);
    }
  });

  it('provides long coherent article cores with explicit distinct perspectives across all requested categories', () => {
    const articles = generateDemoArticles();
    expect(new Set(articles.map((article) => article['title'])).size).toBe(240);
    expect(new Set(articles.map((article) => article['body'])).size).toBe(240);
    expect(new Set(articles.map((article) => article['category']))).toEqual(
      new Set([
        'Technology',
        'Computer Science',
        'Databases',
        'Artificial Intelligence',
        'Science',
        'Physics',
        'Astronomy',
        'Biology',
        'History',
        'Geography',
        'Travel',
        'Nature',
        'Engineering',
        'Music',
        'Sports',
        'Food',
        'Culture',
      ]),
    );
    for (const article of articles) {
      const body = String(article['body']);
      const words = body.trim().split(/\s+/u).length;
      expect(words).toBeGreaterThanOrEqual(500);
      expect(words).toBeLessThanOrEqual(1500);
      expect(body).toContain('The central process\n');
      expect(body).toContain('How the parts interact\n');
      expect(body).toContain('Interpreting the evidence\n');
      expect(body).toContain('Conclusion\n');
      const paragraphs = body.split('\n\n');
      expect(new Set(paragraphs).size).toBe(paragraphs.length);
      expect(body.toLowerCase()).not.toContain('lorem ipsum');
      expect(typeof article['tags']).toBe('string');
      expect(Object.keys(article).indexOf('summary')).toBeLessThan(Object.keys(article).indexOf('body'));
      expect(body.startsWith(String(article['summary']).split(' Focus:')[0])).toBe(true);
    }
  });

  it('marks large content unindexed and gzip compressed while leaving useful short metadata indexed', () => {
    const collections = new Map(generateShowcaseCollections().map((collection) => [collection.name, collection]));
    for (const name of ['articles', 'travel_guides']) {
      expect(collections.get(name)?.unindexedFields).toContain('body');
      expect(collections.get(name)?.compressionDefaults?.['body']).toBe('gzip');
      expect(collections.get(name)?.unindexedFields).not.toContain('id');
      expect(collections.get(name)?.unindexedFields).not.toContain('title');
      expect(collections.get(name)?.unindexedFields).not.toContain('category');
    }
    expect(collections.get('knowledge')?.unindexedFields).toContain('body');
    expect(collections.get('support_tickets')?.unindexedFields).toEqual(['description', 'resolution']);
  });

  it('makes guides and tickets distinct useful documents rather than sentence-repeat padding', () => {
    const collections = generateShowcaseCollections({ employees: 0, products: 0, orders: 0, articles: 0 });
    const guides = collections.find(({ name }) => name === 'travel_guides')?.documents ?? [];
    expect(new Set(guides.map((guide) => guide['title'])).size).toBe(64);
    expect(new Set(guides.map((guide) => guide['body'])).size).toBe(64);
    for (const guide of guides) {
      expect(String(guide['body'])).toContain('Before leaving');
      expect(String(guide['body']).split(/\s+/u).length).toBeGreaterThan(200);
    }
    const tickets = collections.find(({ name }) => name === 'support_tickets')?.documents ?? [];
    expect(new Set(tickets.map((ticket) => ticket['description'])).size).toBe(120);
    expect(new Set(tickets.map((ticket) => ticket['category'])).size).toBe(6);
    for (const ticket of tickets) {
      expect(Object.hasOwn(ticket, 'resolution')).toBe(ticket['status'] === 'resolved');
      expect(String(ticket['description']).length).toBeGreaterThan(100);
    }
  });

  it('rejects invalid sizes and prevents orders with dangling product references', () => {
    for (const articles of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 10001]) {
      expect(() => generateShowcaseCollections({ articles })).toThrow(RangeError);
    }
    expect(() => generateShowcaseCollections({ products: 0, orders: 1 })).toThrow(/require at least one product/u);
    expect(generateDemoOrders([], 0)).toEqual([]);
    expect(() => generateDemoOrders([{ id: 'broken-product' }], 1)).toThrow(TypeError);
  });
});
