/**
 * Asteroid Simulation — Dual World Demo
 *
 * Two identical worlds run side by side. Same asteroids, same physics.
 * Each world fires missiles to intercept incoming asteroids.
 *
 * The difference: missile launch delay is proportional to query latency.
 *   - B+ tree: 1D scan on x, O(n) → higher latency → missiles fire late
 *   - R*-tree: 2D spatial prune, O(log n) → lower latency → missiles fire fast
 *
 * As asteroid count grows the B+ world falls behind and Earth gets hit.
 *
 * Run: npx tsx src/demo/asteroidSim.demo.mts
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

const WORLD          = 400;   // space spans [-WORLD, +WORLD]
const DETECTION_R    = 160;   // outer ring: asteroids in here get targeted
const IMPACT_R       = 22;    // inner ring: asteroid reaching here hits Earth
const MISSILE_SPEED  = 14;    // units per tick
const MISSILE_HIT_R  = 18;    // missile detonation radius
const EARTH_HEALTH   = 10;    // starting hit points per world
const TICK_MS        = 200;
// How many ticks of delay each ms of query latency adds to a missile launch
const LATENCY_SCALE  = 60;

// ─── Types ───────────────────────────────────────────────────────────────────

interface Asteroid {
  id: number;
  x: number; y: number;
  vx: number; vy: number;
  radius: number;
}

interface Missile {
  id: number;
  x: number; y: number;
  targetId: number;
}

interface PendingMissile {
  targetId: number;
  delayTicks: number; // ticks remaining before launch
}

interface WorldState {
  health: number;
  aliveIds: Set<number>;
  missiles: Missile[];
  pendingMissiles: PendingMissile[];
  destroyed: number;
  hits: number;
  latencyMs: number;
  latencyHistory: number[];
}

// ─── Shared simulation state ─────────────────────────────────────────────────

const sharedAsteroids: Asteroid[] = [];
let missileIdCtr = 0;
let pendingAsteroidCount = 0;

const worlds = {
  btree: makeWorld(),
  rstar: makeWorld(),
};

function makeWorld(): WorldState {
  return {
    health: EARTH_HEALTH,
    aliveIds: new Set(),
    missiles: [],
    pendingMissiles: [],
    destroyed: 0,
    hits: 0,
    latencyMs: 0,
    latencyHistory: Array(20).fill(0),
  };
}

// ─── DB / index handles ──────────────────────────────────────────────────────

let db: SimpleDbms;
let rstar: RStarIndex;
let fbf: FreeBlockFile;
const sseClients = new Set<ServerResponse>();

// ─── Initialise ──────────────────────────────────────────────────────────────

async function setupDb(): Promise<void> {
  for (const f of ['ast.data', 'ast.wal', 'rstar.data', 'rstar.wal']) {
    try { unlinkSync(f); } catch { /* file may not exist on first run */ }
  }
  db  = await SimpleDbms.create(new RealFile('ast.data'), new RealFile('ast.wal'));
  const af = new AtomicFile(new RealFile('rstar.data'), new RealFile('rstar.wal'));
  fbf = new FreeBlockFile(af, 4096);
  await fbf.create();
  rstar = await RStarIndex.create(fbf, 50);
}

// ─── Add asteroids ───────────────────────────────────────────────────────────

async function addAsteroids(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const id   = sharedAsteroids.length;
    const ang  = Math.random() * 2 * Math.PI;
    const dist = 180 + Math.random() * (WORLD * 0.85 - 180);
    const x    = Math.cos(ang) * dist;
    const y    = Math.sin(ang) * dist;
    // Drift slowly toward Earth so missiles are needed
    const toEarthAngle = Math.atan2(-y, -x) + (Math.random() - 0.5) * 0.8;
    const speed = 2 + Math.random() * 5;
    const vx   = Math.cos(toEarthAngle) * speed;
    const vy   = Math.sin(toEarthAngle) * speed;
    const radius = 3 + Math.random() * 6;

    sharedAsteroids.push({ id, x, y, vx, vy, radius });
    worlds.btree.aliveIds.add(id);
    worlds.rstar.aliveIds.add(id);

    await db.insertDocument(
      'asteroids',
      JSON.stringify({ id: String(id), x, y, _vx: vx, _vy: vy, _r: radius }),
    );
    await rstar.insert(new Rectangle(x, y, x, y), id);
  }
  await db.commit();
  await fbf.commit();
}

// ─── Update one world ────────────────────────────────────────────────────────

function updateWorld(world: WorldState, dangerIds: Set<number>, latencyMs: number): void {
  world.latencyMs = latencyMs;
  world.latencyHistory.push(+latencyMs.toFixed(3));
  if (world.latencyHistory.length > 20) world.latencyHistory.shift();

  if (world.health <= 0) return; // world is dead — stop fighting

  // Build set of already-targeted asteroid IDs
  const targeted = new Set<number>([
    ...world.pendingMissiles.map(p => p.targetId),
    ...world.missiles.map(m => m.targetId),
  ]);

  // Schedule a missile for each newly detected dangerous asteroid
  for (const id of dangerIds) {
    if (!world.aliveIds.has(id)) continue;
    if (targeted.has(id)) continue;
    world.pendingMissiles.push({
      targetId: id,
      delayTicks: Math.max(1, Math.round(latencyMs * LATENCY_SCALE / TICK_MS)),
    });
  }

  // Count down pending missiles and launch when ready
  const stillPending: PendingMissile[] = [];
  for (const pm of world.pendingMissiles) {
    pm.delayTicks--;
    if (pm.delayTicks <= 0 && world.aliveIds.has(pm.targetId)) {
      world.missiles.push({ id: missileIdCtr++, x: 0, y: 0, targetId: pm.targetId });
    } else if (pm.delayTicks > 0 && world.aliveIds.has(pm.targetId)) {
      stillPending.push(pm);
    }
    // Drop pending missiles whose target is already gone
  }
  world.pendingMissiles = stillPending;

  // Move missiles and check for hits
  const activeMissiles: Missile[] = [];
  for (const missile of world.missiles) {
    if (!world.aliveIds.has(missile.targetId)) continue; // target already dead
    const ast = sharedAsteroids[missile.targetId];
    if (!ast) continue;

    const dx = ast.x - missile.x;
    const dy = ast.y - missile.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist <= MISSILE_HIT_R) {
      world.aliveIds.delete(missile.targetId);
      world.destroyed++;
    } else {
      const step = Math.min(MISSILE_SPEED, dist);
      missile.x += (dx / dist) * step;
      missile.y += (dy / dist) * step;
      activeMissiles.push(missile);
    }
  }
  world.missiles = activeMissiles;

  // Check if any asteroid reached Earth
  for (const id of [...world.aliveIds]) {
    const ast = sharedAsteroids[id];
    if (!ast) continue;
    if (ast.x * ast.x + ast.y * ast.y <= IMPACT_R * IMPACT_R) {
      world.aliveIds.delete(id);
      world.hits++;
      world.health = Math.max(0, world.health - 1);
    }
  }
}

// ─── Serialize world state for SSE ───────────────────────────────────────────

function serializeWorld(world: WorldState, latencyMs: number, pendingSet: Set<number>) {
  return {
    aliveIds:       [...world.aliveIds],
    missiles:       world.missiles.map(m => ({ id: m.id, x: m.x, y: m.y, targetId: m.targetId })),
    pendingIds:     [...pendingSet],
    health:         world.health,
    destroyed:      world.destroyed,
    hits:           world.hits,
    latencyMs:      +latencyMs.toFixed(3),
    latencyHistory: world.latencyHistory,
  };
}

// ─── Simulation tick ─────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  // 0. Flush any pending asteroid additions (queued from HTTP handler)
  if (pendingAsteroidCount > 0) {
    const count = pendingAsteroidCount;
    pendingAsteroidCount = 0;
    await addAsteroids(count);
  }

  // 1. Move all asteroids and update DB + R*-tree
  for (const ast of sharedAsteroids) {
    const ox = ast.x, oy = ast.y;
    ast.x += ast.vx;
    ast.y += ast.vy;
    if (ast.x >  WORLD) ast.x -= 2 * WORLD;
    if (ast.x < -WORLD) ast.x += 2 * WORLD;
    if (ast.y >  WORLD) ast.y -= 2 * WORLD;
    if (ast.y < -WORLD) ast.y += 2 * WORLD;

    await db.editDocument('asteroids', String(ast.id), 'x', ast.x);
    await db.editDocument('asteroids', String(ast.id), 'y', ast.y);
    await rstar.delete(new Rectangle(ox, oy, ox, oy), ast.id);
    await rstar.insert(new Rectangle(ast.x, ast.y, ast.x, ast.y), ast.id);
  }
  await db.commit();
  await fbf.commit();

  // 2. B+ tree query — sorted 1D scan on x, filter by distance
  const t0 = performance.now();
  const btreeDanger = new Set<number>();
  for await (const raw of db.cursor('asteroids', 'x')) {
    const doc = JSON.parse(raw) as { id: string; x: number; y: number };
    if (doc.x > DETECTION_R) break;
    if (doc.x < -DETECTION_R) continue;
    const dx = doc.x, dy = doc.y;
    if (dx * dx + dy * dy <= DETECTION_R * DETECTION_R) {
      btreeDanger.add(Number(doc.id));
    }
  }
  const btreeMs = performance.now() - t0;

  // 3. R*-tree query — 2D rectangle search, refine to circle
  const t1 = performance.now();
  const rstarDanger = new Set<number>();
  for (const id of await rstar.search(
    new Rectangle(-DETECTION_R, -DETECTION_R, DETECTION_R, DETECTION_R),
  )) {
    const ast = sharedAsteroids[id];
    if (!ast) continue;
    if (ast.x * ast.x + ast.y * ast.y <= DETECTION_R * DETECTION_R) {
      rstarDanger.add(id);
    }
  }
  const rstarMs = performance.now() - t1;

  // 4. Update each world's defense state
  updateWorld(worlds.btree, btreeDanger, btreeMs);
  updateWorld(worlds.rstar, rstarDanger, rstarMs);

  // 5. Broadcast state
  const aliveUnion = new Set([...worlds.btree.aliveIds, ...worlds.rstar.aliveIds]);

  const payload = JSON.stringify({
    asteroids: sharedAsteroids
      .filter(a => aliveUnion.has(a.id))
      .map(a => ({ id: a.id, x: a.x, y: a.y, radius: a.radius })),
    btree: serializeWorld(worlds.btree, btreeMs, new Set(worlds.btree.pendingMissiles.map(p => p.targetId))),
    rstar: serializeWorld(worlds.rstar, rstarMs, new Set(worlds.rstar.pendingMissiles.map(p => p.targetId))),
    world:          WORLD,
    detectionR:     DETECTION_R,
    impactR:        IMPACT_R,
    maxHealth:      EARTH_HEALTH,
    totalAsteroids: sharedAsteroids.length,
    latencyScale:   LATENCY_SCALE,
  });

  const msg = `data: ${payload}\n\n`;
  for (const client of sseClients) client.write(msg);
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await setupDb();
  await addAsteroids(40);

  let ticker: ReturnType<typeof setInterval> | undefined;

  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(readFileSync(join(__dirname, 'asteroidSim.html'), 'utf8'));
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

    if (req.url === '/add' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const { count } = JSON.parse(body) as { count: number };
        pendingAsteroidCount += count;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ total: sharedAsteroids.length + pendingAsteroidCount }));
      });
      return;
    }

    if (req.url === '/reset' && req.method === 'POST') {
      res.writeHead(200);
      res.end('Restarting…');
      clearInterval(ticker);
      process.exit(0);
      return;
    }

    res.writeHead(404); res.end();
  });

  server.listen(3000, () => {
    console.log('Asteroid simulation → http://localhost:3000');
    console.log(`${sharedAsteroids.length} asteroids | ${TICK_MS}ms/tick | latency scale ×${LATENCY_SCALE}`);
  });

  // Guard: skip a tick if the previous one hasn't finished yet.
  // Without this, concurrent commits hit the WAL's inFlight lock.
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
