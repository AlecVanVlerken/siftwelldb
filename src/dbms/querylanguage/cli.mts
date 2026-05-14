#!/usr/bin/env node
// author: Frederik Caeyman
// date: 2026-02-17

import fs from 'node:fs';
import { RealFile } from '../../core/file.mjs';
import { SimpleDbms } from '../simpledbms.mjs';
import { QueryLanguage } from './querylanguage.mjs';

// Simple CLI for the QueryLanguage that allows executing queries from the command line.
function parseArgs(argv: string[]) {
  const args = { data: 'querylang.data', log: 'querylang.log', query: '' };
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--data' && argv[i + 1]) {
      args.data = argv[++i];
    } else if (token === '--log' && argv[i + 1]) {
      args.log = argv[++i];
    } else if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    } else {
      args.query = argv.slice(i).join(' ');
      break;
    }
  }
  if (!args.query) {
    printHelp();
    process.exit(1);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node cli.mjs [--data path] [--log path] "<QUERY>"

Supported queries:
  SELECT [DISTINCT] <fields|*> FROM <collection>
    [WHERE <conditions>]
    [GROUP BY <fields>]
    [HAVING <aggregate conditions>]
    [ORDER BY <field> [ASC|DESC], ...]
    [LIMIT n]
    [OFFSET k]
  INSERT INTO <collection> VALUES {id: '...', field: ...}
  UPDATE <collection> SET field = value [, ...] [WHERE <conditions>]
  DELETE FROM <collection> [WHERE <conditions>] [ORDER BY <field> [ASC|DESC]] [LIMIT n] [OFFSET k]
  EXPLAIN SELECT ...

WHERE / HAVING:
  - Comparisons:  =, !=, >, >=, <, <=, LIKE, NOT LIKE, CONTAINS
  - Null checks:  IS NULL, IS NOT NULL
  - Sets/ranges:  IN (...), NOT IN (...), BETWEEN, NOT BETWEEN
  - Logical:      AND, OR, NOT (...), with parentheses for precedence
  - Values:       quoted strings, numbers, booleans (true/false)

Aggregates (with or without GROUP BY):
  COUNT(*), COUNT(field), SUM(field), AVG(field), MIN(field), MAX(field)
  Aggregate arguments may use DISTINCT, e.g. COUNT(DISTINCT country)

Examples:
  node cli.mjs "SELECT * FROM cities"
  node cli.mjs --data my.db --log my.log "SELECT name FROM users WHERE age = 18"
  node cli.mjs "SELECT country, COUNT(*) AS n FROM cities GROUP BY country ORDER BY n DESC"
  node cli.mjs "SELECT * FROM cities WHERE (country = 'BE' OR country = 'NL') AND population > 500000"
  node cli.mjs "SELECT name FROM cities WHERE name LIKE 'A%'"
  node cli.mjs "UPDATE cities SET population = 530000 WHERE id = 'antwerp'"
  node cli.mjs "DELETE FROM cities WHERE id = 'gent'"
  node cli.mjs --data my.db --log my.log "INSERT INTO cities VALUES {id: 'Antwerp', population: 530000}"`);
}

function ensureFile(path: string) {
  if (!fs.existsSync(path)) {
    fs.closeSync(fs.openSync(path, 'w'));
  }
}

async function openDb(dataPath: string, logPath: string): Promise<SimpleDbms> {
  const dataFileExists = fs.existsSync(dataPath);
  if (!dataFileExists) {
    ensureFile(logPath);
    const db = await SimpleDbms.create(new RealFile(dataPath), new RealFile(logPath));
    await db.commit();
    return db;
  }
  ensureFile(logPath);
  return SimpleDbms.open(new RealFile(dataPath), new RealFile(logPath));
}

async function main() {
  const { data, log, query } = parseArgs(process.argv);
  const db = await openDb(data, log);
  const ql = new QueryLanguage(db);

  const rows = await ql.execute(query);
  if (rows.length === 0) {
    console.log('OK');
  } else {
    for (const row of rows) {
      console.log(JSON.stringify(row));
    }
  }

  await db.commit();
  await db.close();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);

  console.error(message);
  process.exit(1);
});
