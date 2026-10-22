import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as http from 'node:http';
import { RawImage } from '@huggingface/transformers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../service.mjs';
import { ApiRouter } from '../api.mjs';
import { DemoDirectoryStore } from '../temporary-demo.mjs';
import type { HnswConfig } from '../../../database/simpledbms.mjs';
import { createPersistentShowcase } from '../../../../scripts/seed-test-database.mjs';

const CLIENT = 'client-one';
let root: string;
const services: DatabaseService[] = [];
const config: HnswConfig = {
  dimension: 3,
  M: 4,
  embeddingFn: () => Promise.resolve(new Float32Array([1, 0, 0])),
  textIndex: { dimension: 3, M: 4, embeddingFn: () => Promise.resolve(new Float32Array([1, 0, 0])) },
  imageIndex: {
    dimension: 5,
    M: 4,
    embeddingFn: () => Promise.resolve(new Float32Array([1, 0, 0, 0, 0])),
    imageEmbeddingFn: () => Promise.resolve(new Float32Array([1, 0, 0, 0, 0])),
  },
};

function service(
  hnswConfig = config,
  extra: NonNullable<ConstructorParameters<typeof DatabaseService>[0]>['demo'] = {},
): DatabaseService {
  const result = new DatabaseService({
    hnswConfig,
    demo: {
      assetRoot: path.join(root, 'assets'),
      temporaryRoot: path.join(root, 'owned'),
      counts: { employees: 2, products: 2, orders: 3, articles: 2, travel_guides: 2, support_tickets: 2 },
      assets: { photos: 1, gallery: 1, memes: 1 },
      ...extra,
    },
  });
  services.push(result);
  return result;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'siftwell-demo-lifecycle-test-'));
  const flickr = path.join(root, 'assets', 'Flickr8k images');
  const text = path.join(root, 'assets', 'Flickr8k text');
  const memes = path.join(root, 'assets', 'Memes templates');
  await Promise.all([
    fs.mkdir(flickr, { recursive: true }),
    fs.mkdir(text, { recursive: true }),
    fs.mkdir(memes, { recursive: true }),
  ]);
  const captions: string[] = [];
  for (const [index, name] of ['dog.png', 'bike.png'].entries()) {
    await new RawImage(new Uint8Array(18).fill(40 + index * 80), 3, 2, 3).save(path.join(flickr, name));
    for (let caption = 0; caption < 5; caption++)
      captions.push(`${name}#${caption}\tA ${index ? 'bicycle' : 'dog'} outdoors, view ${caption}.`);
  }
  await new RawImage(new Uint8Array(18).fill(230), 3, 2, 3).save(path.join(memes, 'Template name.png'));
  await fs.writeFile(path.join(text, 'Flickr8k.token.txt'), captions.join('\n'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const current of services.splice(0)) await current.shutdown();
  if (
    path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) ||
    !path.basename(root).startsWith('siftwell-demo-lifecycle-test-')
  )
    throw new Error('Unexpected test cleanup path');
  await fs.rm(root, { recursive: true, force: true });
});

async function createReady(current: DatabaseService): Promise<string> {
  const initial = current.startDemo(CLIENT);
  expect(initial).toMatchObject({ state: 'creating', temporary: true });
  const completed = await current.waitForDemoCreation();
  expect(completed.error).toBeNull();
  expect(completed.state).toBe('ready');
  expect(completed.counts).toMatchObject({
    employees: 2,
    products: 2,
    orders: 3,
    articles: 2,
    travel_guides: 2,
    support_tickets: 2,
    knowledge: 31,
    photos: 1,
    gallery: 1,
    memes: 1,
  });
  return completed.filepath!;
}

describe('temporary comprehensive demo lifecycle', () => {
  it('creates the persistent standalone showcase through shared seeding and closes reopened handles without deleting it', async () => {
    const filepath = path.join(root, 'persistent', 'sample.db');
    const settings = {
      assetRoot: path.join(root, 'assets'),
      assets: { photos: 1, gallery: 1, memes: 1 },
      hnswConfig: config,
      counts: { employees: 2, products: 2, orders: 3, articles: 2, travel_guides: 2, support_tickets: 2 },
    };
    const result = await createPersistentShowcase(filepath, settings);
    expect(result.counts).toMatchObject({ articles: 2, orders: 3, knowledge: 31, photos: 1, gallery: 1, memes: 1 });
    const original = await fs.readFile(filepath);
    await expect(createPersistentShowcase(filepath, settings)).rejects.toThrow('File already exists');
    const current = service();
    await current.connect(filepath);
    expect((await current.getDocuments('photos')).total).toBe(1);
    await current.disconnect();
    await current.shutdown();
    expect(await fs.readFile(filepath)).toEqual(original);
  });

  it('removes only its reserved standalone outputs if required model inference fails', async () => {
    const filepath = path.join(root, 'persistent', 'failed.db');
    const keep = path.join(root, 'source-data.db');
    await fs.writeFile(keep, 'valuable');
    const rejected: HnswConfig = {
      ...config,
      textIndex: { ...config.textIndex!, embeddingFn: () => Promise.reject(new Error('Model unavailable')) },
    };
    await expect(
      createPersistentShowcase(filepath, {
        assetRoot: path.join(root, 'assets'),
        assets: { photos: 1, gallery: 1, memes: 1 },
        hnswConfig: rejected,
        counts: { employees: 1, products: 1, orders: 1, articles: 1, travel_guides: 1, support_tickets: 1 },
      }),
    ).rejects.toThrow('Model unavailable');
    await expect(fs.stat(filepath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(`${filepath}.log`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(keep, 'utf8')).toBe('valuable');
  });
  it('retains failed cleanup ownership, blocks another creation and lets disconnect retry safely', async () => {
    const rejected: HnswConfig = {
      ...config,
      textIndex: { ...config.textIndex!, embeddingFn: () => Promise.reject(new Error('Model unavailable')) },
    };
    const current = service(rejected);
    vi.spyOn(DemoDirectoryStore.prototype, 'remove').mockRejectedValueOnce(new Error('Output still locked'));
    current.startDemo(CLIENT);
    const failed = await current.waitForDemoCreation();
    expect(failed.error).toContain('cleanup must be retried');
    const entries = await fs.readdir(path.join(root, 'owned'));
    expect(entries).toHaveLength(1);
    expect(() => current.startDemo(CLIENT)).toThrow('cleanup is pending');
    expect(current.temporaryDemo?.id).toBe(failed.id);
    await current.disconnect(CLIENT);
    expect(await fs.readdir(path.join(root, 'owned'))).toEqual([]);
    expect((await fs.stat(path.join(root, 'assets', 'Flickr8k images', 'dog.png'))).isFile()).toBe(true);
  });
  it('creates all collections outside the source directory, supports normal operations/reopening/vacuum and deletes on disconnect', async () => {
    const current = service();
    const filepath = await createReady(current);
    expect(path.dirname(path.dirname(filepath))).toBe(path.join(root, 'owned'));
    expect((await current.getStatus()).temporaryDemo?.id).toBe(current.getDemoStatus().id);
    expect(
      (await current.query('SELECT department, AVG(salary) AS mean FROM employees GROUP BY department')).rowCount,
    ).toBeGreaterThan(0);
    const employee = JSON.parse((await current.getDocuments('employees')).documents[0]) as {
      id: string;
      salary: number;
    };
    await current.editDocument('employees', employee.id, 'salary', 123456);
    expect((JSON.parse(await current.getDocumentById('employees', employee.id)) as { salary: number }).salary).toBe(
      123456,
    );
    const bytes = (await current.rawDbms.getDocumentObjectById('photos', 'photo0001'))['image'];
    await current.connect(filepath, CLIENT);
    expect((await current.rawDbms.getDocumentObjectById('photos', 'photo0001'))['image']).toEqual(bytes);
    await current.runIncrementalCompactionStep();
    await current.vacuum();
    expect(current.getDemoStatus().state).toBe('ready');
    expect((await current.rawDbms.getDocumentObjectById('photos', 'photo0001'))['image']).toEqual(bytes);
    expect((await current.semanticImageTextSearch('gallery', 'a bicycle', 3)).length).toBe(1);
    await current.disconnect(CLIENT);
    await expect(fs.stat(path.dirname(filepath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(path.join(root, 'assets', 'Flickr8k images', 'dog.png'))).isFile()).toBe(true);
    expect((await fs.stat(path.join(root, 'assets', 'Memes templates', 'Template name.png'))).isFile()).toBe(true);
  });

  it('switches to a persistent database without deleting its files, and repeated demos use distinct directories', async () => {
    const current = service();
    const persistent = path.join(root, 'user-demo.db');
    await current.create(persistent);
    await current.insertDocument('valuable', { id: 'keep', title: 'permanent' });
    const original = await fs.readFile(persistent);
    const first = await createReady(current);
    await current.connect(persistent, CLIENT);
    await expect(fs.stat(path.dirname(first))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(persistent)).toEqual(original);
    expect(JSON.parse(await current.getDocumentById('valuable', 'keep'))).toEqual({ id: 'keep', title: 'permanent' });
    const second = await createReady(current);
    expect(second).not.toBe(first);
    await current.shutdown();
    await expect(fs.stat(path.dirname(second))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(persistent)).toEqual(original);
  });

  it('protects other active tabs, then expires a released last lease after grace', async () => {
    const current = service();
    const filepath = await createReady(current);
    const id = current.getDemoStatus('client-two').id!;
    await expect(current.disconnect(CLIENT)).rejects.toThrow('another tab');
    await expect(current.connect(path.join(root, 'other.db'), CLIENT)).rejects.toThrow('another tab');
    current.releaseDemo(CLIENT, id);
    await current.expireDemoSessions(Date.now() + 30_000);
    expect(current.isConnected).toBe(true);
    current.releaseDemo('client-two', id);
    await current.expireDemoSessions(Date.now() + 30_000);
    expect(current.isConnected).toBe(true);
    await current.expireDemoSessions(Date.now() + 61_000);
    expect(current.isConnected).toBe(false);
    await expect(fs.stat(path.dirname(filepath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the existing persistent database when required source assets or the preflight budget fail', async () => {
    const current = service(config, { assetRoot: path.join(root, 'missing') });
    const persistent = path.join(root, 'user.db');
    await current.create(persistent);
    await current.insertDocument('docs', { id: 'keep', title: 'unchanged' });
    const original = await fs.readFile(persistent);
    current.startDemo(CLIENT);
    expect((await current.waitForDemoCreation()).state).toBe('failed');
    expect(current.isConnected).toBe(true);
    expect(await fs.readFile(persistent)).toEqual(original);
    await expect(current.cancelDemo(CLIENT, current.getDemoStatus().id!)).rejects.toThrow('no demo creation');
    const budget = service(config, { maxBytes: 100_000 });
    budget.startDemo(CLIENT);
    expect((await budget.waitForDemoCreation()).error).toContain('budget');
    expect(await fs.readdir(path.join(root, 'owned'))).toEqual([]);
  });

  it('cleans a partially written demo when a required encoder fails', async () => {
    const rejected: HnswConfig = {
      ...config,
      textIndex: {
        ...config.textIndex!,
        embeddingFn: () => Promise.reject(new Error('Required text model unavailable')),
      },
    };
    const current = service(rejected);
    current.startDemo(CLIENT);
    const finished = await current.waitForDemoCreation();
    expect(finished).toMatchObject({ state: 'failed', filepath: null });
    expect(finished.error).toContain('Required text model unavailable');
    expect(current.isConnected).toBe(false);
    expect(await fs.readdir(path.join(root, 'owned'))).toEqual([]);
  });

  it('checks actual runtime footprint and removes an oversized partial demo', async () => {
    const current = service(config, { maxBytes: 75_000_000 });
    vi.spyOn(DemoDirectoryStore.prototype, 'footprint').mockResolvedValueOnce(80_000_000);
    current.startDemo(CLIENT);
    expect((await current.waitForDemoCreation()).error).toContain('budget');
    expect(current.isConnected).toBe(false);
    expect(await fs.readdir(path.join(root, 'owned'))).toEqual([]);
  });

  it('cancels in-flight embedding without publishing late completion, while progress remains responsive', async () => {
    let release!: () => void;
    let called = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = {
      ...config,
      textIndex: {
        ...config.textIndex!,
        embeddingFn: async () => {
          called = true;
          await gate;
          return new Float32Array([1, 0, 0]);
        },
      },
    };
    const current = service(delayed);
    const initial = current.startDemo(CLIENT);
    await vi.waitFor(() => expect(called).toBe(true));
    expect(current.getDemoStatus(CLIENT).state).toBe('creating');
    expect((await current.getStatus()).busyOperation).toBe('create-demo');
    await expect(current.insertDocument('wrong-context', { id: 'bad' })).rejects.toThrow('creation is running');
    const cancelled = current.cancelDemo(CLIENT, initial.id!);
    expect(current.getDemoStatus('client-two').clientActive).toBe(false);
    expect(current.getDemoStatus().state).toBe('cancelling');
    release();
    expect((await cancelled).stage).toBe('Demo creation cancelled');
    expect(current.isConnected).toBe(false);
    expect(await fs.readdir(path.join(root, 'owned'))).toEqual([]);
  });

  it('graceful shutdown cancels creation, closes handles and removes its directory', async () => {
    let release!: () => void;
    let called = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = {
      ...config,
      textIndex: {
        ...config.textIndex!,
        embeddingFn: async () => {
          called = true;
          await gate;
          return new Float32Array([1, 0, 0]);
        },
      },
    };
    const current = service(delayed);
    current.startDemo(CLIENT);
    await vi.waitFor(() => expect(called).toBe(true));
    const shuttingDown = current.shutdown();
    release();
    await shuttingDown;
    expect(current.isConnected).toBe(false);
    expect(await fs.readdir(path.join(root, 'owned'))).toEqual([]);
    expect(() => current.startDemo(CLIENT)).toThrow('shutting down');
  });

  it('exposes nonblocking creation/progress/heartbeat through HTTP without accepting a user deletion path', async () => {
    const current = service();
    const router = new ApiRouter(current);
    const server = http.createServer((request, response) => {
      void router.handle(request, response, new URL(request.url!, 'http://localhost'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    const userPath = path.join(root, 'never-delete.db');
    await fs.writeFile(userPath, 'precious');
    try {
      const response = await fetch(`${origin}/api/demo/create`, {
        method: 'POST',
        body: JSON.stringify({ clientId: CLIENT, filepath: userPath }),
      });
      expect(response.status).toBe(202);
      const started = (await response.json()) as { demo: { id: string } };
      expect((await fetch(`${origin}/api/demo/status?clientId=${CLIENT}`)).status).toBe(200);
      const duplicate = await fetch(`${origin}/api/demo/create`, {
        method: 'POST',
        body: JSON.stringify({ clientId: CLIENT }),
      });
      expect(((await duplicate.json()) as { demo: { id: string } }).demo.id).toBe(started.demo.id);
      const ready = await current.waitForDemoCreation();
      expect(ready.state).toBe('ready');
      const status = (await (await fetch(`${origin}/api/status`)).json()) as { temporaryDemo: { id: string } };
      expect(status.temporaryDemo.id).toBe(started.demo.id);
      expect(
        (
          await fetch(`${origin}/api/demo/heartbeat`, {
            method: 'POST',
            body: JSON.stringify({ clientId: CLIENT, demoId: started.demo.id }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${origin}/api/disconnect`, {
            method: 'POST',
            body: JSON.stringify({ clientId: CLIENT, demoId: started.demo.id }),
          })
        ).status,
      ).toBe(200);
      expect(await fs.readFile(userPath, 'utf8')).toBe('precious');
      await expect(fs.stat(path.dirname(ready.filepath!))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
