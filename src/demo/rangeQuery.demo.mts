/**
 * Range Query Demo — B+ Tree vs R*-Tree
 *
 * A cloud of static 2D points grows over time.
 * Each tick both indexes answer the same circular range query.
 * The latency difference between them is broadcast live.
 *
 * Run:  npx tsx src/demo/rangeQuery.demo.mts
 * Open: http://localhost:3000
 */

import { createServer } from 'node:http';
import { readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ServerResponse } from 'node:http';

import { RealFile } from '../core/file.mjs';
import { SimpleDbms } from '../dbms/simpledbms.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { RStarIndex } from '../rstar/rstarIndex.mjs';
import { Rectangle } from '../rstar/rstarRectangle.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants ───────────────────────────────────────────────────────────────

const WORLD       = 400;   // coordinate space: [-WORLD, +WORLD]
const QUERY_R     = 150;   // radius of the circular range query
const TICK_MS     = 500;   // ms between ticks
const ADD_EVERY   = 3;     // add points every N ticks
const ADD_COUNT   = 40;    // points added per batch
const START_COUNT = 100;   // initial points
const BENCH_RUNS  = 5;     // query repetitions per tick (averaged for stable ms)

// ─── State ───────────────────────────────────────────────────────────────────

interface Point { id: number; x: number; y: number; }

const points: Point[] = [];
let db: SimpleDbms;
let rstar: RStarIndex;
let fbf: FreeBlockFile;
const sseClients = new Set<ServerResponse>();

// ─── Setup ───────────────────────────────────────────────────────────────────

async function setupDb(): Promise<void> {
  for (const f of ['rq.data', 'rq.wal', 'rqstar.data', 'rqstar.wal']) {
    try { unlinkSync(f); } catch { /* first run */ }
  }
  db = await SimpleDbms.create(new RealFile('rq.data'), new RealFile('rq.wal'));
  const af = new AtomicFile(new RealFile('rqstar.data'), new RealFile('rqstar.wal'));
  fbf = new FreeBlockFile(af, 4096);
  await fbf.create();
  rstar = await RStarIndex.create(fbf, 50);
}

async function addPoints(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const id = points.length;
    const x = (Math.random() * 2 - 1) * WORLD;
    const y = (Math.random() * 2 - 1) * WORLD;
    points.push({ id, x, y });
    await db.insertDocument('points', JSON.stringify({ id: String(id), x, y }));
    await rstar.insert(new Rectangle(x, y, x, y), id);
  }
  await db.commit();
  await fbf.commit();
}

// ─── Benchmark ───────────────────────────────────────────────────────────────

async function benchmark(): Promise<{ btreeMs: number; rstarMs: number }> {
  // B+ tree: sorted scan on x, then filter by circle
  let btreeTotal = 0;
  for (let r = 0; r < BENCH_RUNS; r++) {
    const t = performance.now();
    for await (const raw of db.cursor('points', 'x')) {
      const doc = JSON.parse(raw) as { id: string; x: number; y: number };
      if (doc.x > QUERY_R) break;
      if (doc.x < -QUERY_R) continue;
      void (doc.x * doc.x + doc.y * doc.y <= QUERY_R * QUERY_R);
    }
    btreeTotal += performance.now() - t;
  }

  // R*-tree: bounding box prune, then refine to circle
  let rstarTotal = 0;
  for (let r = 0; r < BENCH_RUNS; r++) {
    const t = performance.now();
    for (const id of await rstar.search(new Rectangle(-QUERY_R, -QUERY_R, QUERY_R, QUERY_R))) {
      const p = points[id];
      void (p && p.x * p.x + p.y * p.y <= QUERY_R * QUERY_R);
    }
    rstarTotal += performance.now() - t;
  }

  return {
    btreeMs: +(btreeTotal / BENCH_RUNS).toFixed(3),
    rstarMs: +(rstarTotal / BENCH_RUNS).toFixed(3),
  };
}

// ─── Tick ────────────────────────────────────────────────────────────────────

let tickCount = 0;

async function tick(): Promise<void> {
  tickCount++;
  if (tickCount % ADD_EVERY === 0) {
    await addPoints(ADD_COUNT);
  }

  const { btreeMs, rstarMs } = await benchmark();

  const payload = JSON.stringify({
    points: points.map(p => ({ id: p.id, x: p.x, y: p.y })),
    btreeMs,
    rstarMs,
    total: points.length,
    queryR: QUERY_R,
    world:  WORLD,
  });

  const msg = `data: ${payload}\n\n`;
  for (const client of sseClients) client.write(msg);
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await setupDb();
  await addPoints(START_COUNT);

  let ticker: ReturnType<typeof setInterval> | undefined;

  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(readFileSync(join(__dirname, 'rangeQuery.html'), 'utf8'));
      return;
    }

    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('retry: 1000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.url === '/reset' && req.method === 'POST') {
      res.writeHead(200); res.end('Restarting…');
      clearInterval(ticker);
      process.exit(0);
      return;
    }

    res.writeHead(404); res.end();
  });

  server.listen(3000, () => {
    console.log('Range query demo → http://localhost:3000');
    console.log(`${points.length} points | adding ${ADD_COUNT} every ${ADD_EVERY} ticks | query R=${QUERY_R}`);
  });

  let ticking = false;
  ticker = setInterval(() => {
    if (ticking) return;
    ticking = true;
    tick()
      .catch((e: unknown) => console.error('tick error:', e))
      .finally(() => { ticking = false; });
  }, TICK_MS);
}

process.nextTick(() => {
  main().catch((e: unknown) => { console.error(e); process.exit(1); });
});
