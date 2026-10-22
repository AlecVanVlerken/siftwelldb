import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { RawImage } from '@huggingface/transformers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimpleDbms, type HnswConfig } from '../../../database/simpledbms.mjs';
import type { DbmsBack } from '../../../database/dbmsback.mjs';
import { RealFile } from '../../../storage/file.mjs';
import { QueryLanguage } from '../../../query/querylanguage.mjs';
import { semanticIndexKey } from '../../../database/identity.mjs';
import { discoverDemoAssets, type DemoAssetSelection } from '../demo-assets.mjs';
import { generateShowcaseCollections } from '../demo-showcase-data.mjs';
import { demoEmbeddingConfig, seedComprehensiveDemo, type DemoSeedOptions } from '../demo-seeder.mjs';
import type { DemoStatus } from '../temporary-demo.mjs';

// These are controllable test encoders, not MiniLM or CLIP model inference.
function testModels() {
  const text = vi.fn((value: string) =>
    Promise.resolve(new Float32Array([1, (value.length % 17) / 17, (value.length % 11) / 11])),
  );
  const image = vi.fn((value: Buffer) =>
    Promise.resolve(
      new Float32Array([
        1,
        (value.length % 13) / 13,
        (value.length % 19) / 19,
        value[0] / 255,
        value[value.length - 1] / 255,
      ]),
    ),
  );
  const imageText = vi.fn((_value: string) => Promise.resolve(new Float32Array([1, 0, 0, 0, 0])));
  const textIndex = { dimension: 3, embeddingFn: text, M: 4, efConstruction: 32, efSearch: 32 };
  const config: HnswConfig = {
    ...textIndex,
    textIndex,
    imageIndex: {
      dimension: 5,
      embeddingFn: imageText,
      imageEmbeddingFn: image,
      M: 4,
      efConstruction: 32,
      efSearch: 32,
    },
  };
  return { ...demoEmbeddingConfig(config), text, image, imageText };
}

function ids(rows: string[]): string[] {
  return rows.map((row) => String((JSON.parse(row) as Record<string, unknown>)['id'])).sort();
}

describe('comprehensive demo seeding on real database files', () => {
  let root: string;
  let filepath: string;
  let assets: DemoAssetSelection;
  let models: ReturnType<typeof testModels>;
  const openDatabases = new Set<SimpleDbms>();

  const counts = { employees: 3, products: 4, orders: 7, articles: 3, travel_guides: 2, support_tickets: 4 };
  const expectedCounts = { ...counts, knowledge: 31, photos: 2, gallery: 1, memes: 1 };

  async function createDatabase(config = models.config): Promise<SimpleDbms> {
    const database = await SimpleDbms.create(new RealFile(filepath), new RealFile(`${filepath}.log`), config);
    openDatabases.add(database);
    return database;
  }

  async function closeDatabase(database: SimpleDbms): Promise<void> {
    await database.close();
    openDatabases.delete(database);
  }

  async function footprint(): Promise<number> {
    const sizes = await Promise.all([filepath, `${filepath}.log`].map(async (file) => (await fs.stat(file)).size));
    return sizes.reduce((total, size) => total + size, 0);
  }

  function options(overrides: Partial<DemoSeedOptions> = {}): DemoSeedOptions {
    return {
      signal: new AbortController().signal,
      onProgress: () => undefined,
      footprint,
      checkEmbeddings: models.checkEmbeddings,
      batchSize: 7,
      ...overrides,
    };
  }

  async function verify(database: SimpleDbms, deleted = false): Promise<void> {
    expect((await database.getCollections()).sort()).toEqual(Object.keys(expectedCounts).sort());
    for (const [collection, count] of Object.entries(expectedCounts)) {
      const documents: string[] = [];
      for await (const document of database.cursor(collection, 'id')) documents.push(document);
      const removed = deleted && ['articles', 'photos'].includes(collection) ? 1 : 0;
      expect(documents).toHaveLength(count - removed);
    }
    const articleId = deleted ? 'article-0002' : 'article-0001';
    const original = generateShowcaseCollections(counts).find((collection) => collection.name === 'articles')!
      .documents[deleted ? 1 : 0];
    expect(await database.getDocumentObjectById('articles', articleId)).toEqual(original);
    expect(String(original['body']).split(/\s+/u).length).toBeGreaterThanOrEqual(500);
    const encoded = JSON.parse(await database.getDocumentById('articles', articleId, { encoded: true })) as Record<
      string,
      { compression: string }
    >;
    expect(encoded['body'].compression).toBe('gzip');
    expect(database.getFieldCompressionDefaults('articles')).toEqual({ body: 'gzip' });
    expect(database.getFieldIndexConfig('articles')['body']).toBe(false);
    expect(database.getFieldIndexConfig('articles')['category']).toBe(true);
    expect(database.getFieldIndexConfig('travel_guides')['body']).toBe(false);
    const guide = JSON.parse(
      await database.getDocumentById('travel_guides', 'guide-0001', { encoded: true }),
    ) as Record<string, { compression: string }>;
    expect(guide['body'].compression).toBe('gzip');

    for (const [index, asset] of assets.photos.entries()) {
      if (deleted && index === 0) continue;
      const photo = await database.getDocumentObjectById('photos', `photo${String(index + 1).padStart(4, '0')}`);
      expect(Buffer.isBuffer(photo['image'])).toBe(true);
      expect(photo['image']).toEqual(await fs.readFile(asset.path));
      expect(photo['filename']).toBe(asset.filename);
      expect(photo['description']).toBe(asset.captions[0]);
      expect(photo['captions']).toBe(asset.captions.join('\n'));
      expect(String(photo['captions']).split('\n')).toHaveLength(5);
      expect(photo['_image_mime']).toBe(asset.mime);
      expect(photo['width']).toBe(3);
      expect(photo['height']).toBe(2);
    }
    const gallery = await database.getDocumentObjectById('gallery', 'gallery0001');
    expect(gallery['image']).toEqual(await fs.readFile(assets.gallery[0].path));
    for (const field of ['title', 'description', 'captions', 'category', 'filename'])
      expect(Object.hasOwn(gallery, field)).toBe(false);
    expect(await database.semanticSearch('gallery', 'dog outdoors', 10)).toEqual([]);
    expect(ids(await database.semanticImageTextSearch('gallery', 'dog outdoors', 10))).toEqual(['gallery0001']);
    expect(ids(await database.semanticImageSearch('gallery', await fs.readFile(assets.gallery[0].path), 10))).toEqual([
      'gallery0001',
    ]);
    const meme = await database.getDocumentObjectById('memes', 'meme0001');
    expect(meme['image']).toEqual(await fs.readFile(assets.memes[0].path));
    expect(meme['title']).toBe('Programming template');
    expect(Object.hasOwn(meme, 'caption')).toBe(false);

    const keys = new Set(database.getHnswIndexKeys());
    const backend = (database as unknown as { dbmsback: DbmsBack }).dbmsback;
    for (const collection of [
      'employees',
      'products',
      'orders',
      'knowledge',
      'articles',
      'travel_guides',
      'support_tickets',
      'photos',
      'memes',
    ]) {
      expect(keys.has(semanticIndexKey(collection, 'text'))).toBe(true);
      expect((await database.semanticSearch(collection, 'example text', 100)).length).toBeGreaterThan(0);
      const nodes = await backend.inspectHnswGraphStructure(collection, 'text');
      expect(nodes.every((node) => node.vector.length === 3)).toBe(true);
      const removed = deleted && ['articles', 'photos'].includes(collection) ? 1 : 0;
      expect(nodes.filter((node) => !node.deleted)).toHaveLength(
        expectedCounts[collection as keyof typeof expectedCounts] - removed,
      );
    }
    for (const collection of ['photos', 'gallery', 'memes'] as const) {
      expect(keys.has(semanticIndexKey(collection, 'image'))).toBe(true);
      const nodes = await backend.inspectHnswGraphStructure(collection, 'image');
      expect(nodes.every((node) => node.vector.length === 5)).toBe(true);
      expect(nodes.filter((node) => !node.deleted)).toHaveLength(
        expectedCounts[collection] - (deleted && collection === 'photos' ? 1 : 0),
      );
    }
    // Vacuum can establish empty companion indexes; no nodes should appear.
    if (keys.has(semanticIndexKey('gallery', 'text')))
      expect(await backend.inspectHnswGraphStructure('gallery', 'text')).toEqual([]);
    if (keys.has(semanticIndexKey('articles', 'image')))
      expect(await backend.inspectHnswGraphStructure('articles', 'image')).toEqual([]);
    const livePhotos = deleted ? ['photo0002'] : ['photo0001', 'photo0002'];
    expect(ids(await database.semanticSearch('photos', 'photographs', 10))).toEqual(livePhotos);
    expect(ids(await database.semanticImageTextSearch('photos', 'photographs', 10))).toEqual(livePhotos);
    expect(ids(await database.semanticImageSearch('photos', await fs.readFile(assets.photos[0].path), 10))).toEqual(
      livePhotos,
    );
    expect(ids(await database.semanticSearch('articles', 'database indexing', 10))).toEqual(
      deleted ? ['article-0002', 'article-0003'] : ['article-0001', 'article-0002', 'article-0003'],
    );

    const language = new QueryLanguage(database);
    const generated = generateShowcaseCollections(counts);
    const orders = generated.find((collection) => collection.name === 'orders')!.documents;
    const products = generated.find((collection) => collection.name === 'products')!.documents;
    for (const order of orders) {
      const product = products.find((candidate) => candidate['id'] === order['productId']);
      expect(product).toBeDefined();
      expect(order['total']).toBe((Math.round(Number(product?.['price']) * 100) * Number(order['quantity'])) / 100);
      expect(await database.getDocumentObjectById('orders', String(order['id']))).toEqual(order);
    }
    const aggregate = await language.execute(
      'SELECT COUNT(*) AS count, SUM(total) AS revenue, AVG(quantity) AS units FROM orders',
    );
    expect(aggregate[0]?.['count']).toBe(7);
    expect(Number(aggregate[0]?.['revenue'])).toBeCloseTo(
      orders.reduce((total, order) => total + Number(order['total']), 0),
      8,
    );
    expect(Number(aggregate[0]?.['units'])).toBeCloseTo(
      orders.reduce((total, order) => total + Number(order['quantity']), 0) / orders.length,
      8,
    );
    expect(
      await language.execute('SELECT id, price FROM products WHERE price > 20 ORDER BY price DESC LIMIT 2'),
    ).toEqual(
      products
        .filter((product) => Number(product['price']) > 20)
        .sort((a, b) => Number(b['price']) - Number(a['price']))
        .slice(0, 2)
        .map((product) => ({ id: product['id'], price: product['price'] })),
    );
    const groups = await language.execute('SELECT category, COUNT(*) AS count FROM articles GROUP BY category');
    expect(groups.reduce((sum, row) => sum + Number(row['count']), 0)).toBe(deleted ? 2 : 3);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'siftwell-demo-seeder-test-'));
    filepath = path.join(root, 'showcase.db');
    models = testModels();
    const flickr = path.join(root, 'Flickr8k_Dataset');
    const metadata = path.join(root, 'Flickr8k_text');
    const memes = path.join(root, 'supplied-memes');
    for (const directory of [flickr, metadata, memes]) await fs.mkdir(directory);
    const captionLines: string[] = [];
    for (const [filename, color, caption] of [
      ['dog.jpg', 40, 'A dog running on grass.'],
      ['bicycle.png', 100, 'A person riding a bicycle.'],
      ['children.png', 160, 'Children playing outdoors.'],
    ] as const) {
      await new RawImage(new Uint8Array(3 * 2 * 3).fill(color), 3, 2, 3).save(path.join(flickr, filename));
      for (let index = 0; index < 5; index++) captionLines.push(`${filename}#${index}\t${caption} View ${index + 1}.`);
    }
    await fs.writeFile(path.join(metadata, 'Flickr8k.token.txt'), captionLines.join('\n'));
    await new RawImage(new Uint8Array(3 * 2 * 3).fill(210), 3, 2, 3).save(path.join(memes, 'Programming_template.png'));
    assets = await discoverDemoAssets(root, { photos: 2, gallery: 1, memes: 1 });
  });

  afterEach(async () => {
    for (const database of openDatabases) await database.close();
    openDatabases.clear();
    const absolute = path.resolve(root);
    if (
      !absolute.startsWith(path.resolve(tmpdir()) + path.sep) ||
      !path.basename(absolute).startsWith('siftwell-demo-seeder-test-')
    )
      throw new Error('Unexpected fixture cleanup path');
    await fs.rm(absolute, { recursive: true, force: true });
  });

  it('persists all collections, compression, indexed SQL fields and separate semantic spaces', async () => {
    const database = await createDatabase();
    const progress: Partial<DemoStatus>[] = [];
    const result = await seedComprehensiveDemo(
      database,
      generateShowcaseCollections(counts),
      assets,
      filepath,
      options({ onProgress: (update) => progress.push(update) }),
    );
    expect(result.counts).toEqual(expectedCounts);
    expect(result.bytes).toBe(await footprint());
    expect(result.bytes).toBeLessThan(2_000_000_000);
    expect(progress.some((update) => update.stage === 'Verifying persisted documents and indexes')).toBe(true);
    expect(progress.filter((update) => update.completed !== undefined).at(-1)?.completed).toBe(58);
    expect(models.text).toHaveBeenCalled();
    expect(models.image).toHaveBeenCalled();
    expect(models.image.mock.calls.every(([bytes]) => Buffer.isBuffer(bytes))).toBe(true);
    expect(models.text.mock.calls.some(([value]) => value.includes('summary:') && value.includes('body:'))).toBe(true);
    await verify(database);
    await database.reopen(new RealFile(filepath), new RealFile(`${filepath}.log`));
    await verify(database);
  });

  it('preserves live contents and semantic results through deletion, compaction, vacuum and reopening', async () => {
    const database = await createDatabase();
    await seedComprehensiveDemo(database, generateShowcaseCollections(counts), assets, filepath, options());
    await database.deleteDocumentById('articles', 'article-0001');
    await database.deleteDocumentById('photos', 'photo0001');
    await database.commit();
    await database.runIncrementalCompactionStep();
    await database.commit();
    await database.reopen(new RealFile(filepath), new RealFile(`${filepath}.log`));
    await verify(database, true);
    const vacuumPath = path.join(root, 'vacuum.db');
    const vacuum = await database.vacuumCompactInto(new RealFile(vacuumPath), new RealFile(`${vacuumPath}.log`));
    openDatabases.add(vacuum);
    await verify(vacuum, true);
    await closeDatabase(vacuum);
    const reopened = await SimpleDbms.open(new RealFile(vacuumPath), new RealFile(`${vacuumPath}.log`), models.config);
    openDatabases.add(reopened);
    await verify(reopened, true);
  });

  it('stops on the runtime footprint budget before claiming successful verification', async () => {
    const database = await createDatabase();
    const progress: Partial<DemoStatus>[] = [];
    await expect(
      seedComprehensiveDemo(
        database,
        generateShowcaseCollections(counts),
        assets,
        filepath,
        options({ maxBytes: 1, batchSize: 1, onProgress: (update) => progress.push(update) }),
      ),
    ).rejects.toThrow(/budget/u);
    expect(progress.some((update) => update.stage === 'Verifying persisted documents and indexes')).toBe(false);
  });

  it('honours cancellation before changing collections or invoking an encoder', async () => {
    const database = await createDatabase();
    const before = await Promise.all([filepath, `${filepath}.log`].map((file) => fs.readFile(file)));
    const controller = new AbortController();
    controller.abort(new Error('Cancelled by test'));
    await expect(
      seedComprehensiveDemo(
        database,
        generateShowcaseCollections(counts),
        assets,
        filepath,
        options({ signal: controller.signal }),
      ),
    ).rejects.toThrow('Cancelled by test');
    expect(await database.getCollections()).toEqual([]);
    expect(models.text).not.toHaveBeenCalled();
    expect(models.image).not.toHaveBeenCalled();
    expect(await Promise.all([filepath, `${filepath}.log`].map((file) => fs.readFile(file)))).toEqual(before);
  });

  it.each(['text', 'image'] as const)(
    'propagates %s model failure without claiming a complete semantically indexed demo',
    async (kind) => {
      const database = await createDatabase();
      const reopen = vi.spyOn(database, 'reopen');
      models[kind].mockRejectedValueOnce(new Error(`${kind} encoder unavailable`));
      const progress: Partial<DemoStatus>[] = [];
      await expect(
        seedComprehensiveDemo(
          database,
          generateShowcaseCollections(counts),
          assets,
          filepath,
          options({ onProgress: (update) => progress.push(update) }),
        ),
      ).rejects.toThrow(`${kind} encoder unavailable`);
      expect(progress.some((update) => update.stage === 'Verifying persisted documents and indexes')).toBe(false);
      expect(reopen).not.toHaveBeenCalled();
      expect(database.isHealthy).toBe(true);
      if (kind === 'text') expect(await database.getCollections()).toEqual([]);
      else {
        expect(models.image).toHaveBeenCalledTimes(1);
        expect((await database.getDocumentObjectById('photos', 'photo0001'))['image']).toEqual(
          await fs.readFile(assets.photos[0].path),
        );
        await expect(database.getDocumentObjectById('photos', 'photo0002')).rejects.toThrow(/not found/u);
      }
    },
  );

  it('rejects invalid image vectors rather than silently omitting the image semantic entry', async () => {
    const database = await createDatabase();
    const reopen = vi.spyOn(database, 'reopen');
    models.image.mockResolvedValueOnce(new Float32Array([1, 0]));
    await expect(
      seedComprehensiveDemo(database, generateShowcaseCollections(counts), assets, filepath, options()),
    ).rejects.toThrow('Required image model returned an invalid embedding.');
    expect(models.image).toHaveBeenCalledTimes(1);
    expect(reopen).not.toHaveBeenCalled();
    await expect(database.getDocumentObjectById('photos', 'photo0002')).rejects.toThrow(/not found/u);
  });
});
