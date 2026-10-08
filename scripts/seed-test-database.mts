import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseService } from '../src/webclient/server/service.mjs';

// Run from the repository root. An existing database is never overwritten.
const filepath = path.resolve(process.argv[2] ?? 'webclient-test.db');
for (const candidate of [filepath, `${filepath}.log`]) {
  try {
    await fs.access(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
    throw error;
  }
  throw new Error(`File already exists: ${candidate}. Choose a different filename.`);
}

const db = new DatabaseService();
const categories = [
  [
    'Outdoors',
    'Trail backpack',
    'A lightweight waterproof backpack for hiking, camping and exploring mountain trails.',
  ],
  ['Kitchen', 'Coffee grinder', 'An adjustable burr grinder for fresh espresso and morning coffee at home.'],
  [
    'Electronics',
    'Wireless headphones',
    'Noise cancelling headphones for music, video calls and quiet work on busy trains.',
  ],
  [
    'Garden',
    'Herb growing kit',
    'Grow basil, mint and parsley on a sunny balcony with reusable pots and organic seeds.',
  ],
  ['Fitness', 'Yoga mat', 'A comfortable non slip exercise mat for stretching, yoga and home workouts.'],
  [
    'Photography',
    'Camera tripod',
    'A stable travel tripod for wildlife photography, landscapes and long exposure pictures.',
  ],
  [
    'Cycling',
    'Bicycle repair kit',
    'Portable tools, tyre patches and a pump for fixing punctures during bicycle rides.',
  ],
  [
    'Books',
    'Astronomy field guide',
    'An illustrated introduction to planets, constellations and observing the night sky.',
  ],
];
const destinations = [
  ['Ardennes', 'Belgium', 'Forest hiking, river kayaking, cosy cabins and quiet trails through wooded valleys.'],
  [
    'Ghent',
    'Belgium',
    'Historic canals, medieval architecture, museums and vegetarian restaurants in a walkable city.',
  ],
  ['Lisbon', 'Portugal', 'Sunny streets, ocean beaches, seafood, hilltop viewpoints and colourful trams.'],
  [
    'Tromso',
    'Norway',
    'Northern lights, snowy landscapes, whale watching and winter photography above the Arctic Circle.',
  ],
  ['Kyoto', 'Japan', 'Temple gardens, cherry blossoms, traditional tea houses and peaceful bamboo forests.'],
  ['Dolomites', 'Italy', 'Mountain climbing, alpine hiking, cycling and dramatic limestone peaks.'],
  ['Reykjavik', 'Iceland', 'Volcanoes, hot springs, waterfalls and guided trips across rugged lava landscapes.'],
  ['Amsterdam', 'Netherlands', 'Canal boat tours, art museums, bicycle paths and weekend markets.'],
];
const issues = [
  [
    'Delivery',
    'Package has not arrived',
    'My parcel is late and tracking has stopped updating. Please check the delivery address.',
  ],
  ['Returns', 'Request a refund', 'The item arrived damaged. I would like a return label and my money back.'],
  ['Account', 'Cannot sign in', 'I forgot my password and the reset email never arrived. Please help restore access.'],
  [
    'Payment',
    'Charged twice',
    'My card shows two payments for the same order. Please investigate the duplicate charge.',
  ],
  [
    'Technical',
    'Headphones will not connect',
    'Bluetooth pairing fails on my laptop even after restarting both devices.',
  ],
  ['Product', 'Looking for camping equipment', 'I need a waterproof bag for a weekend hiking trip with lots of rain.'],
];

try {
  await db.connect(filepath);
  await db.seedDemoEmployees(200);
  await db.seedSemanticKnowledgeDemo();
  await db.seedWikiLab({ count: 100 });
  for (let i = 0; i < 120; i++) {
    const [category, name, description] = categories[i % categories.length];
    await db.insertDocument('products', {
      id: `product-${String(i + 1).padStart(3, '0')}`,
      name: `${name} ${['Essential', 'Plus', 'Pro'][Math.floor(i / 8) % 3]} ${Math.floor(i / 24) + 1}`,
      category,
      description,
      price: Math.round((19.95 + i * 2.35) * 100) / 100,
      stock: (i * 17) % 150,
      available: i % 7 !== 0,
      rating: 3 + (i % 21) / 10,
      _supplier_note: i % 2 ? 'Local warehouse' : 'Restock every Monday',
    });
  }
  for (let i = 0; i < 320; i++) {
    await db.insertDocument('orders', {
      id: `order-${String(i + 1).padStart(4, '0')}`,
      customer: `Customer ${String((i % 80) + 1).padStart(3, '0')}`,
      product_id: `product-${String((i % 120) + 1).padStart(3, '0')}`,
      status: ['pending', 'paid', 'shipped', 'delivered', 'cancelled'][i % 5],
      city: ['Ghent', 'Brussels', 'Antwerp', 'Leuven', 'Namur', 'Liege', 'Bruges', 'Hasselt'][i % 8],
      quantity: 1 + (i % 5),
      total: Math.round((25 + i * 1.7) * 100) / 100,
      date: `2026-${String(1 + (Math.floor(i / 28) % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
      express: i % 4 === 0,
    });
  }
  await db.setFieldIndexed('travel_guides', '_body', false);
  for (let i = 0; i < 48; i++) {
    const [destination, country, summary] = destinations[i % destinations.length];
    await db.insertDocument(
      'travel_guides',
      {
        id: `guide-${String(i + 1).padStart(3, '0')}`,
        destination,
        country,
        title: `${destination}: ${['a weekend escape', 'family adventure', 'budget itinerary', 'photography trip', 'slow travel', 'outdoor holiday'][Math.floor(i / 8)]}`,
        summary,
        budget_eur: 200 + i * 25,
        days: 2 + (i % 8),
        _body: `${summary}\nBring comfortable shoes, check transport times and respect local wildlife.\n`.repeat(70),
      },
      { _body: 'gzip' },
    );
  }
  for (let i = 0; i < 48; i++) {
    const [category, subject, message] = issues[i % issues.length];
    await db.insertDocument('support_tickets', {
      id: `ticket-${String(i + 1).padStart(3, '0')}`,
      category,
      subject,
      message,
      priority: ['low', 'normal', 'high'][i % 3],
      status: ['open', 'in_progress', 'resolved'][i % 3],
      customer: `Customer ${String(i + 1).padStart(3, '0')}`,
      ...(i % 3 === 2 ? { satisfaction: 3 + (i % 3) } : {}),
    });
  }
  await db.insertDocument('playground', {
    id: 'edit-me',
    title: 'Safe place to try editing',
    quantity: 7,
    enabled: true,
    description: 'Change these fields, upload an image, or delete this document without disturbing the other examples.',
    _notes: 'Field names do not control indexing; use the collection Indexed setting.',
  });
  await db.seedSemanticImageDemo();
  await db.disconnect();

  // Verify persisted data and real embeddings using a fresh database instance.
  await db.connect(filepath);
  const expected: Record<string, number> = {
    employees: 200,
    knowledge: 31,
    wiki_lab: 100,
    products: 120,
    orders: 320,
    travel_guides: 48,
    support_tickets: 48,
    playground: 1,
  };
  for (const [collection, count] of Object.entries(expected)) {
    const result = await db.getDocuments(collection);
    assert.equal(result.total, count, `${collection} count after reopening`);
    console.log(`${collection}: ${result.total}`);
  }
  const photos = await db.getDocuments('photos');
  assert.ok(photos.total > 0);
  console.log(`photos: ${photos.total}`);
  assert.equal((await db.query('SELECT * FROM orders WHERE total > 100 LIMIT 5')).rowCount, 5);
  assert.ok((await db.semanticSearch('products', 'equipment for a rainy hiking trip', 5)).length > 0);
  assert.ok((await db.semanticSearch('support_tickets', 'I want my money back', 5)).length > 0);
  assert.ok((await db.semanticImageTextSearch('photos', 'a bear in the wild', 5)).length > 0);
  const photo = (JSON.parse(photos.documents[0]) as Record<string, unknown>)['image'];
  assert.ok(typeof photo === 'string');
  assert.ok((await db.semanticImageSearch('photos', Buffer.from(photo, 'base64'), 5)).length > 0);
  console.log(`Verified database ready: ${filepath}`);
} finally {
  await db.disconnect();
}
