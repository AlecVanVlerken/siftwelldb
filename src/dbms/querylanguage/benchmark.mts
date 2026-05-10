// author: benchmark script for QueryLanguage
// Gebruik: npm run benchmark
// Vergelijkt: index lookup vs full scan vs JOIN vs aggregaten
// Genereert automatisch een HTML rapport met grafiek in benchmark-results.html

import fs from 'node:fs';
import path from 'node:path';
import { RealFile } from '../../core/file.mjs';
import { SimpleDbms } from '../simpledbms.mjs';
import { QueryLanguage } from '../querylanguage/querylanguage.mjs';

// ── Config ────────────────────────────────────────────────────────────────────

const DATASET_SIZE = 10_000; // aantal steden in de benchmark dataset
const WARMUP_RUNS = 3; // opwarmen vóór meting (JIT)
const MEASURE_RUNS = 5; // aantal herhalingen per benchmark

// ── Types ─────────────────────────────────────────────────────────────────────

type BenchmarkResult = {
  label: string;
  query: string;
  complexity: string;
  category: 'index' | 'scan' | 'join' | 'aggregate' | 'complex';
  avg: number;
  min: number;
  max: number;
  rows: number;
};

// ── Setup ─────────────────────────────────────────────────────────────────────

const dataPath = '/tmp/benchmark.data';
const logPath = '/tmp/benchmark.log';

function cleanup() {
  if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath);
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
}

async function setup(): Promise<QueryLanguage> {
  cleanup();
  fs.closeSync(fs.openSync(logPath, 'w'));

  const db = await SimpleDbms.create(new RealFile(dataPath), new RealFile(logPath));
  await db.commit();
  const ql = new QueryLanguage(db);

  console.log(`\nDataset aanmaken met ${DATASET_SIZE.toLocaleString()} steden...`);

  const countries = ['BE', 'NL', 'FR', 'DE', 'UK', 'ES', 'IT', 'PL', 'PT', 'SE'];
  const continents: Record<string, string> = {
    BE: 'Europa',
    NL: 'Europa',
    FR: 'Europa',
    DE: 'Europa',
    UK: 'Europa',
    ES: 'Europa',
    IT: 'Europa',
    PL: 'Europa',
    PT: 'Europa',
    SE: 'Europa',
  };

  for (const c of countries) {
    await ql.execute(`INSERT INTO countries VALUES {id: '${c}', name: '${c}', continent: '${continents[c]}'}`);
  }

  for (let i = 0; i < DATASET_SIZE; i++) {
    const country = countries[i % countries.length];
    const population = 50_000 + Math.floor(Math.random() * 5_000_000);
    await ql.execute(
      `INSERT INTO cities VALUES {id: 'city_${i}', name: 'Stad ${i}', country: '${country}', population: ${population}}`,
    );
  }

  await db.commit();
  console.log(`Dataset klaar.\n`);
  return ql;
}

// ── Benchmark runner ──────────────────────────────────────────────────────────

async function measure(
  label: string,
  query: string,
  complexity: string,
  category: BenchmarkResult['category'],
  fn: () => Promise<unknown>,
): Promise<BenchmarkResult> {
  process.stdout.write(`  ${label} (${complexity} - ${category})\n  Query: ${query}\n`);

  for (let i = 0; i < WARMUP_RUNS; i++) {
    await fn();
  }

  const times: number[] = [];
  let rowCount = 0;

  for (let i = 0; i < MEASURE_RUNS; i++) {
    const start = performance.now();
    const result = await fn();
    const end = performance.now();
    times.push(end - start);
    if (i === 0 && Array.isArray(result)) {
      rowCount = result.length;
    }
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  console.log(
    `  → ${rowCount} rijen | gem: ${avg.toFixed(2)} ms | min: ${min.toFixed(2)} ms | max: ${max.toFixed(2)} ms\n`,
  );

  return { label, query, complexity, category, avg, min, max, rows: rowCount };
}

// ── Benchmarks ────────────────────────────────────────────────────────────────

async function run() {
  const ql = await setup();

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  QueryLanguage Benchmark');
  console.log(`  Dataset: ${DATASET_SIZE.toLocaleString()} steden | ${MEASURE_RUNS} runs per test`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const results: BenchmarkResult[] = [];

  results.push(
    await measure('Index Lookup', "SELECT * FROM cities WHERE id = 'city_5000'", 'O(log n)', 'index', () =>
      ql.execute("SELECT * FROM cities WHERE id = 'city_5000'"),
    ),
  );

  results.push(
    await measure('Full Scan', 'SELECT * FROM cities', 'O(n)', 'scan', () => ql.execute('SELECT * FROM cities')),
  );

  results.push(
    await measure('Full Scan + Filter', 'SELECT * FROM cities WHERE population > 1000000', 'O(n)', 'scan', () =>
      ql.execute('SELECT * FROM cities WHERE population > 1000000'),
    ),
  );

  results.push(
    await measure(
      "Index Scan (country = 'BE')",
      "SELECT * FROM cities WHERE country = 'BE'",
      'O(log n + k)',
      'index',
      () => ql.execute("SELECT * FROM cities WHERE country = 'BE'"),
    ),
  );

  results.push(
    await measure('JOIN', 'SELECT * FROM cities JOIN countries ON cities.country = countries.id', 'O(n)', 'join', () =>
      ql.execute('SELECT * FROM cities JOIN countries ON cities.country = countries.id'),
    ),
  );

  results.push(
    await measure(
      'JOIN + WHERE',
      'SELECT * FROM cities JOIN countries ON ... WHERE population > 1000000',
      'O(n)',
      'join',
      () =>
        ql.execute('SELECT * FROM cities JOIN countries ON cities.country = countries.id WHERE population > 1000000'),
    ),
  );

  results.push(
    await measure('GROUP BY COUNT', 'SELECT country, COUNT(*) FROM cities GROUP BY country', 'O(n)', 'aggregate', () =>
      ql.execute('SELECT country, COUNT(*) FROM cities GROUP BY country'),
    ),
  );

  results.push(
    await measure(
      'GROUP BY 5 aggregaten',
      'SELECT country, COUNT(*), SUM, AVG, MIN, MAX FROM cities GROUP BY country',
      'O(n)',
      'aggregate',
      () =>
        ql.execute(
          'SELECT country, COUNT(*), SUM(population), AVG(population), MIN(population), MAX(population) FROM cities GROUP BY country',
        ),
    ),
  );

  results.push(
    await measure(
      'ORDER BY + LIMIT (top 10)',
      'SELECT name, population FROM cities ORDER BY population DESC LIMIT 10',
      'O(n log n)',
      'scan',
      () => ql.execute('SELECT name, population FROM cities ORDER BY population DESC LIMIT 10'),
    ),
  );

  results.push(
    await measure(
      'Complexe Query',
      'WHERE + JOIN + GROUP BY + HAVING + ORDER BY + LIMIT',
      'O(n log n)',
      'complex',
      () =>
        ql.execute(
          'SELECT countries.id, COUNT(*), AVG(population) FROM cities JOIN countries ON cities.country = countries.id WHERE population > 500000 GROUP BY countries.id HAVING COUNT(*) > 100 ORDER BY AVG(population) DESC LIMIT 5',
        ),
    ),
  );

  cleanup();
}

run().catch((err) => {
  console.error('Benchmark mislukt:', err);
  cleanup();
  process.exit(1);
});
