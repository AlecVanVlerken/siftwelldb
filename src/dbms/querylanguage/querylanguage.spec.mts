// author: Matisse De Gauquier

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RealFile } from '../../core/file.mjs';
import { SimpleDbms } from '../simpledbms.mjs';
import { QueryLanguage } from './querylanguage.mjs';

// ── Setup ─────────────────────────────────────────────────────────────────────

let dbCounter = 0;

async function setupDb(): Promise<QueryLanguage> {
  const id = dbCounter++;
  const dataPath = path.join(os.tmpdir(), `test_querylang_${id}.data`);
  const logPath = path.join(os.tmpdir(), `test_querylang_${id}.log`);

  if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath);
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);

  fs.closeSync(fs.openSync(logPath, 'w'));
  const db = await SimpleDbms.create(new RealFile(dataPath), new RealFile(logPath));
  await db.commit();

  const ql = new QueryLanguage(db);

  // ── cities ──
  await ql.execute("INSERT INTO cities VALUES {id: 'gent', name: 'Gent', country: 'BE', population: 260000}");
  await ql.execute("INSERT INTO cities VALUES {id: 'brussel', name: 'Brussel', country: 'BE', population: 1200000}");
  await ql.execute("INSERT INTO cities VALUES {id: 'antwerpen', name: 'Antwerpen', country: 'BE', population: 530000}");
  await ql.execute("INSERT INTO cities VALUES {id: 'amsterdam', name: 'Amsterdam', country: 'NL', population: 900000}");
  await ql.execute("INSERT INTO cities VALUES {id: 'rotterdam', name: 'Rotterdam', country: 'NL', population: 650000}");
  await ql.execute("INSERT INTO cities VALUES {id: 'denhaag', name: 'Den Haag', country: 'NL', population: 550000}");
  await ql.execute("INSERT INTO cities VALUES {id: 'parijs', name: 'Parijs', country: 'FR', population: 2100000}");
  await ql.execute("INSERT INTO cities VALUES {id: 'lyon', name: 'Lyon', country: 'FR', population: 520000}");
  await ql.execute("INSERT INTO cities VALUES {id: 'berlijn', name: 'Berlijn', country: 'DE', population: 3700000}");
  await ql.execute("INSERT INTO cities VALUES {id: 'hamburg', name: 'Hamburg', country: 'DE', population: 1800000}");
  await ql.execute("INSERT INTO cities VALUES {id: 'munchen', name: 'München', country: 'DE', population: 1500000}");

  // ── countries ──
  await ql.execute("INSERT INTO countries VALUES {id: 'BE', name: 'België', continent: 'Europa'}");
  await ql.execute("INSERT INTO countries VALUES {id: 'NL', name: 'Nederland', continent: 'Europa'}");
  await ql.execute("INSERT INTO countries VALUES {id: 'FR', name: 'Frankrijk', continent: 'Europa'}");
  await ql.execute("INSERT INTO countries VALUES {id: 'DE', name: 'Duitsland', continent: 'Europa'}");

  await db.commit();
  return ql;
}

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

// ── SELECT ────────────────────────────────────────────────────────────────────

describe('SELECT', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('SELECT * geeft alle rijen terug', async () => {
    const rows = await ql.execute('SELECT * FROM cities');
    expect(rows).toHaveLength(11);
  });

  it('SELECT specifieke velden', async () => {
    const rows = await ql.execute('SELECT name, population FROM cities');
    expect(rows.every((r) => 'name' in r && 'population' in r && !('id' in r))).toBe(true);
  });

  it('SELECT op lege collectie gooit fout of geeft lege array', async () => {
    try {
      const rows = await ql.execute('SELECT * FROM empty');
      expect(rows).toHaveLength(0);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});

// ── WHERE ─────────────────────────────────────────────────────────────────────

describe('WHERE', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('WHERE met = op string', async () => {
    const rows = await ql.execute("SELECT * FROM cities WHERE country = 'BE'");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r['country'] === 'BE')).toBe(true);
  });

  it('WHERE met != op string', async () => {
    const rows = await ql.execute("SELECT * FROM cities WHERE country != 'BE'");
    expect(rows).toHaveLength(8);
  });

  it('WHERE met > op number', async () => {
    // Berlijn(3700000), Parijs(2100000), Hamburg(1800000), München(1500000), Brussel(1200000) = 5
    const rows = await ql.execute('SELECT * FROM cities WHERE population > 1000000');
    expect(rows).toHaveLength(5);
  });

  it('WHERE met >= op number', async () => {
    const rows = await ql.execute('SELECT * FROM cities WHERE population >= 1200000');
    expect(rows).toHaveLength(5);
  });

  it('WHERE met < op number', async () => {
    const rows = await ql.execute('SELECT * FROM cities WHERE population < 300000');
    expect(rows).toHaveLength(1); // alleen Gent (260000)
  });

  it('WHERE met <= op number', async () => {
    const rows = await ql.execute('SELECT * FROM cities WHERE population <= 260000');
    expect(rows).toHaveLength(1); // alleen Gent
  });

  it('WHERE met AND', async () => {
    const rows = await ql.execute("SELECT * FROM cities WHERE country = 'BE' AND population > 500000");
    expect(rows).toHaveLength(2); // Brussel + Antwerpen
    expect(rows.every((r) => r['country'] === 'BE' && (r['population'] as number) > 500000)).toBe(true);
  });

  it('WHERE met OR', async () => {
    const rows = await ql.execute("SELECT * FROM cities WHERE country = 'BE' OR country = 'FR'");
    expect(rows).toHaveLength(5); // 3 BE + 2 FR
  });

  it('WHERE met AND en OR gecombineerd', async () => {
    // AND bindt sterker: BE (3) + (FR AND pop > 1000000) = Parijs (1) = 4
    const rows = await ql.execute(
      "SELECT * FROM cities WHERE country = 'BE' OR country = 'FR' AND population > 1000000",
    );
    expect(rows).toHaveLength(4);
  });

  it('WHERE geen resultaten', async () => {
    const rows = await ql.execute('SELECT * FROM cities WHERE population > 9999999');
    expect(rows).toHaveLength(0);
  });

  it('WHERE met quoted string met spaties', async () => {
    const rows = await ql.execute("SELECT * FROM cities WHERE name = 'Den Haag'");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['name']).toBe('Den Haag');
  });
});

// ── WHERE op boolean (eigen db want INSERT) ───────────────────────────────────

describe('WHERE op boolean veld', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('WHERE op boolean veld', async () => {
    await ql.execute(
      "INSERT INTO cities VALUES {id: 'teststad', name: 'Teststad', country: 'BE', population: 100, capital: true}",
    );
    const rows = await ql.execute('SELECT * FROM cities WHERE capital = true');
    expect(rows).toHaveLength(1);
  });
});

// ── ORDER BY ──────────────────────────────────────────────────────────────────

describe('ORDER BY', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('ORDER BY ASC', async () => {
    const rows = await ql.execute('SELECT name, population FROM cities ORDER BY population ASC');
    const pops = rows.map((r) => r['population'] as number);
    expect(pops).toEqual([...pops].sort((a, b) => a - b));
  });

  it('ORDER BY DESC', async () => {
    const rows = await ql.execute('SELECT name, population FROM cities ORDER BY population DESC');
    const pops = rows.map((r) => r['population'] as number);
    expect(pops).toEqual([...pops].sort((a, b) => b - a));
  });

  it('ORDER BY meerdere velden', async () => {
    const rows = await ql.execute('SELECT name, country, population FROM cities ORDER BY country ASC, population DESC');
    const be = rows.filter((r) => r['country'] === 'BE').map((r) => r['population'] as number);
    expect(be).toEqual([...be].sort((a, b) => b - a));
  });

  it('ORDER BY standaard richting is ASC', async () => {
    const rows = await ql.execute('SELECT name, population FROM cities ORDER BY population');
    const pops = rows.map((r) => r['population'] as number);
    expect(pops).toEqual([...pops].sort((a, b) => a - b));
  });
});

// ── LIMIT / OFFSET ────────────────────────────────────────────────────────────

describe('LIMIT / OFFSET', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('LIMIT beperkt aantal rijen', async () => {
    const rows = await ql.execute('SELECT * FROM cities LIMIT 3');
    expect(rows).toHaveLength(3);
  });

  it('LIMIT groter dan aantal rijen geeft alle rijen', async () => {
    const rows = await ql.execute('SELECT * FROM cities LIMIT 100');
    expect(rows).toHaveLength(11);
  });

  it('OFFSET slaat rijen over', async () => {
    const all = await ql.execute('SELECT * FROM cities ORDER BY id ASC');
    const offset = await ql.execute('SELECT * FROM cities ORDER BY id ASC OFFSET 2');
    expect(offset).toHaveLength(9);
    expect(offset[0]).toEqual(all[2]);
  });

  it('LIMIT + OFFSET gecombineerd', async () => {
    const all = await ql.execute('SELECT * FROM cities ORDER BY id ASC');
    const page = await ql.execute('SELECT * FROM cities ORDER BY id ASC LIMIT 3 OFFSET 2');
    expect(page).toHaveLength(3);
    expect(page[0]).toEqual(all[2]);
    expect(page[2]).toEqual(all[4]);
  });

  it('OFFSET groter dan aantal rijen geeft lege array', async () => {
    const rows = await ql.execute('SELECT * FROM cities OFFSET 100');
    expect(rows).toHaveLength(0);
  });

  it('LIMIT 0 geeft lege array', async () => {
    const rows = await ql.execute('SELECT * FROM cities LIMIT 0');
    expect(rows).toHaveLength(0);
  });
});

// ── GROUP BY ──────────────────────────────────────────────────────────────────

describe('GROUP BY', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('GROUP BY COUNT(*)', async () => {
    const rows = await ql.execute('SELECT country, COUNT(*) FROM cities GROUP BY country');
    expect(rows).toHaveLength(4);
    const be = rows.find((r) => r['country'] === 'BE');
    expect(be?.['COUNT(*)']).toBe(3);
  });

  it('GROUP BY SUM', async () => {
    const rows = await ql.execute('SELECT country, SUM(population) FROM cities GROUP BY country');
    const be = rows.find((r) => r['country'] === 'BE');
    expect(be?.['SUM(population)']).toBe(260000 + 1200000 + 530000);
  });

  it('GROUP BY AVG', async () => {
    const rows = await ql.execute('SELECT country, AVG(population) FROM cities GROUP BY country');
    const fr = rows.find((r) => r['country'] === 'FR');
    expect(fr?.['AVG(population)']).toBe((2100000 + 520000) / 2);
  });

  it('GROUP BY MIN', async () => {
    const rows = await ql.execute('SELECT country, MIN(population) FROM cities GROUP BY country');
    const be = rows.find((r) => r['country'] === 'BE');
    expect(be?.['MIN(population)']).toBe(260000);
  });

  it('GROUP BY MAX', async () => {
    const rows = await ql.execute('SELECT country, MAX(population) FROM cities GROUP BY country');
    const de = rows.find((r) => r['country'] === 'DE');
    expect(de?.['MAX(population)']).toBe(3700000);
  });

  it('GROUP BY meerdere aggregaten tegelijk', async () => {
    const rows = await ql.execute(
      'SELECT country, COUNT(*), SUM(population), AVG(population), MIN(population), MAX(population) FROM cities GROUP BY country',
    );
    const nl = rows.find((r) => r['country'] === 'NL');
    expect(nl?.['COUNT(*)']).toBe(3);
    expect(nl?.['SUM(population)']).toBe(900000 + 650000 + 550000);
    expect(nl?.['MIN(population)']).toBe(550000);
    expect(nl?.['MAX(population)']).toBe(900000);
  });
});

// ── Aggregaten zonder GROUP BY ────────────────────────────────────────────────

describe('Aggregaten zonder GROUP BY', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('COUNT(*) zonder GROUP BY', async () => {
    const rows = await ql.execute('SELECT COUNT(*) FROM cities');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['COUNT(*)']).toBe(11);
  });

  it('AVG zonder GROUP BY', async () => {
    const rows = await ql.execute('SELECT AVG(population) FROM cities');
    const total = 260000 + 1200000 + 530000 + 900000 + 650000 + 550000 + 2100000 + 520000 + 3700000 + 1800000 + 1500000;
    expect(rows[0]?.['AVG(population)']).toBe(total / 11);
  });

  it('MIN en MAX zonder GROUP BY', async () => {
    const rows = await ql.execute('SELECT MIN(population), MAX(population) FROM cities');
    expect(rows[0]?.['MIN(population)']).toBe(260000);
    expect(rows[0]?.['MAX(population)']).toBe(3700000);
  });
});

// ── HAVING ────────────────────────────────────────────────────────────────────

describe('HAVING', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('HAVING met COUNT', async () => {
    // BE, NL, DE hebben elk 3 steden -> 3 landen
    const rows = await ql.execute('SELECT country, COUNT(*) FROM cities GROUP BY country HAVING COUNT(*) >= 3');
    expect(rows).toHaveLength(3);
  });

  it('HAVING met AVG', async () => {
    // DE: AVG=2333333, FR: AVG=1310000 -> 2 landen boven 1000000
    const rows = await ql.execute(
      'SELECT country, AVG(population) FROM cities GROUP BY country HAVING AVG(population) > 1000000',
    );
    expect(rows).toHaveLength(2);
  });

  it('HAVING met AND', async () => {
    // DE: COUNT=3, AVG=2333333 ✓  FR: COUNT=2, AVG=1310000 ✓
    const rows = await ql.execute(
      'SELECT country, COUNT(*), AVG(population) FROM cities GROUP BY country HAVING COUNT(*) >= 2 AND AVG(population) > 1000000',
    );
    expect(rows).toHaveLength(2);
  });

  it('HAVING met OR', async () => {
    // BE: MIN=260000 < 300000 ✓, DE: COUNT=3 ✓, NL: COUNT=3 ✓
    const rows = await ql.execute(
      'SELECT country, COUNT(*), MIN(population) FROM cities GROUP BY country HAVING MIN(population) < 300000 OR COUNT(*) > 2',
    );
    expect(rows).toHaveLength(3);
  });

  it('HAVING filtert alle groepen weg', async () => {
    const rows = await ql.execute('SELECT country, COUNT(*) FROM cities GROUP BY country HAVING COUNT(*) > 100');
    expect(rows).toHaveLength(0);
  });
});

// ── JOIN ──────────────────────────────────────────────────────────────────────

describe('JOIN', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('JOIN geeft gecombineerde rijen', async () => {
    const rows = await ql.execute('SELECT * FROM cities JOIN countries ON cities.country = countries.id');
    expect(rows).toHaveLength(11);
  });

  it('JOIN met WHERE', async () => {
    // Berlijn, Parijs, Hamburg, München, Brussel = 5 steden > 1000000
    const rows = await ql.execute(
      'SELECT * FROM cities JOIN countries ON cities.country = countries.id WHERE population > 1000000',
    );
    expect(rows).toHaveLength(5);
  });

  it('JOIN met ORDER BY en LIMIT', async () => {
    // name overlapt -> cities.name gebruiken
    const rows = await ql.execute(
      'SELECT cities.name, population FROM cities JOIN countries ON cities.country = countries.id ORDER BY population DESC LIMIT 3',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.['cities.name']).toBe('Berlijn');
  });

  it('JOIN met GROUP BY', async () => {
    const rows = await ql.execute(
      'SELECT continent, COUNT(*) FROM cities JOIN countries ON cities.country = countries.id GROUP BY continent',
    );
    expect(rows).toHaveLength(1); // Alle landen zijn in Europa
    expect(rows[0]?.['COUNT(*)']).toBe(11);
  });
});

// ── DELETE ────────────────────────────────────────────────────────────────────

describe('DELETE', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('DELETE met WHERE verwijdert juiste rijen', async () => {
    await ql.execute("DELETE FROM cities WHERE id = 'gent'");
    const rows = await ql.execute('SELECT * FROM cities');
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r['id'] !== 'gent')).toBe(true);
  });

  it('DELETE zonder WHERE verwijdert alles', async () => {
    await ql.execute('DELETE FROM countries');
    const rows = await ql.execute('SELECT * FROM countries');
    expect(rows).toHaveLength(0);
  });
});

// ── Complexe combinaties ──────────────────────────────────────────────────────

describe('Complexe combinaties', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('WHERE + ORDER BY + LIMIT + OFFSET', async () => {
    // > 500000 DESC: Berlijn(3700000), Parijs(2100000), Hamburg(1800000), München(1500000), Amsterdam(900000)...
    // OFFSET 1, LIMIT 3 -> Parijs, Hamburg, München
    const rows = await ql.execute(
      'SELECT name, population FROM cities WHERE population > 500000 ORDER BY population DESC LIMIT 3 OFFSET 1',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.['name']).toBe('Parijs');
    expect(rows[2]?.['name']).toBe('München');
  });

  it('WHERE + GROUP BY + HAVING + ORDER BY', async () => {
    // Gent(260000) valt weg, Lyon(520000) niet. Alle 4 landen hebben >= 2 steden.
    const rows = await ql.execute(
      'SELECT country, COUNT(*), SUM(population) FROM cities WHERE population > 500000 GROUP BY country HAVING COUNT(*) >= 2 ORDER BY SUM(population) DESC',
    );
    expect(rows).toHaveLength(4);
    expect(rows[0]?.['country']).toBe('DE');
  });

  it('GROUP BY + HAVING + ORDER BY + LIMIT', async () => {
    const rows = await ql.execute(
      'SELECT country, COUNT(*), AVG(population) FROM cities GROUP BY country HAVING COUNT(*) >= 2 ORDER BY AVG(population) DESC LIMIT 2',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.['country']).toBe('DE');
  });

  it('WHERE + GROUP BY + meerdere aggregaten + HAVING met OR + ORDER BY + LIMIT', async () => {
    // Gent valt weg. ORDER BY MAX DESC LIMIT 2: DE(3700000), FR(2100000)
    const rows = await ql.execute(
      'SELECT country, COUNT(*), MIN(population), MAX(population) FROM cities WHERE population != 260000 GROUP BY country HAVING MIN(population) < 600000 OR MAX(population) > 2000000 ORDER BY MAX(population) DESC LIMIT 2',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.['country']).toBe('DE');
    expect(rows[1]?.['country']).toBe('FR');
  });
});

// ── Parseerfouten ─────────────────────────────────────────────────────────────

describe('Parseerfouten', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('Ongeldige query gooit fout', async () => {
    await expect(ql.execute('GIBBERISH query')).rejects.toThrow(/Invalid query syntax/i);
  });

  it('INSERT zonder accolades gooit fout', async () => {
    await expect(ql.execute("INSERT INTO cities VALUES id: 'test'")).rejects.toThrow(/braces/i);
  });

  it('WHERE met ongeldige operator <> gooit fout', async () => {
    await expect(ql.execute('SELECT * FROM cities WHERE population <> 100')).rejects.toThrow(/Invalid|Unsupported/i);
  });

  it('ORDER BY met ongeldige richting gooit fout', async () => {
    await expect(ql.execute('SELECT * FROM cities ORDER BY population UPWARD')).rejects.toThrow(
      /Invalid sort direction/i,
    );
  });

  it('Unsupported waarde in WHERE gooit fout', async () => {
    await expect(ql.execute('SELECT * FROM cities WHERE population = [1,2,3]')).rejects.toThrow(/Unsupported value/i);
  });
});

// ── Randgevallen ──────────────────────────────────────────────────────────────

describe('Randgevallen', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('Query met puntkomma aan het einde werkt', async () => {
    const rows = await ql.execute('SELECT * FROM cities;');
    expect(rows).toHaveLength(11);
  });

  it('Query met extra spaties werkt', async () => {
    const rows = await ql.execute('SELECT  *  FROM  cities');
    expect(rows).toHaveLength(11);
  });

  it('GROUP BY op niet-bestaand veld geeft één groep', async () => {
    const rows = await ql.execute('SELECT nonexistent, COUNT(*) FROM cities GROUP BY nonexistent');
    expect(rows).toHaveLength(1);
  });

  it('INSERT en direct SELECT op zelfde id', async () => {
    await ql.execute("INSERT INTO cities VALUES {id: 'newcity', name: 'Newcity', country: 'BE', population: 999}");
    const rows = await ql.execute("SELECT * FROM cities WHERE id = 'newcity'");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['population']).toBe(999);
  });
});

// ── Parentheses in WHERE ──────────────────────────────────────────────────────

describe('Parentheses in WHERE', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('parens override default AND-over-OR precedence', async () => {
    // Without parens: BE (3) OR (FR AND pop > 1M) = 3 + 1 = 4 (Parijs)
    const noParens = await ql.execute(
      "SELECT * FROM cities WHERE country = 'BE' OR country = 'FR' AND population > 1000000",
    );
    expect(noParens).toHaveLength(4);
    // With parens: (BE OR FR) AND pop > 1M = Brussel + Parijs = 2
    const withParens = await ql.execute(
      "SELECT * FROM cities WHERE (country = 'BE' OR country = 'FR') AND population > 1000000",
    );
    expect(withParens).toHaveLength(2);
    expect(withParens.every((r) => (r['country'] === 'BE' || r['country'] === 'FR') && (r['population'] as number) > 1_000_000)).toBe(true);
  });

  it('nested parens work', async () => {
    const rows = await ql.execute(
      "SELECT * FROM cities WHERE ((country = 'BE' AND population > 500000) OR (country = 'NL' AND population > 700000))",
    );
    // BE > 500k: Brussel, Antwerpen (2). NL > 700k: Amsterdam (1). = 3
    expect(rows).toHaveLength(3);
  });

  it('unmatched paren throws', async () => {
    await expect(ql.execute("SELECT * FROM cities WHERE (country = 'BE'")).rejects.toThrow();
  });
});

// ── AS aliases ────────────────────────────────────────────────────────────────

describe('AS aliases', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('SELECT field AS alias renames the column', async () => {
    const rows = await ql.execute("SELECT name AS city_name FROM cities WHERE id = 'gent'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty('city_name', 'Gent');
    expect(rows[0]).not.toHaveProperty('name');
  });

  it('aggregate AS alias renames the aggregate column', async () => {
    const rows = await ql.execute('SELECT country, COUNT(*) AS n FROM cities GROUP BY country');
    expect(rows).toHaveLength(4);
    const be = rows.find((r) => r['country'] === 'BE');
    expect(be).toHaveProperty('n', 3);
    expect(be).not.toHaveProperty('COUNT(*)');
  });

  it('ORDER BY can reference an aliased column', async () => {
    const rows = await ql.execute('SELECT country, COUNT(*) AS n FROM cities GROUP BY country ORDER BY n DESC');
    const counts = rows.map((r) => r['n'] as number);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});

// ── LIKE / NOT LIKE ───────────────────────────────────────────────────────────

describe('LIKE / NOT LIKE', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('% matches a suffix', async () => {
    const rows = await ql.execute("SELECT name FROM cities WHERE name LIKE 'A%'");
    // Amsterdam, Antwerpen
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => String(r['name']).startsWith('A'))).toBe(true);
  });

  it('% matches a prefix', async () => {
    const rows = await ql.execute("SELECT name FROM cities WHERE name LIKE '%dam'");
    // Amsterdam, Rotterdam
    expect(rows).toHaveLength(2);
  });

  it('_ matches one character', async () => {
    const rows = await ql.execute("SELECT name FROM cities WHERE name LIKE 'Ly__'");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['name']).toBe('Lyon');
  });

  it('NOT LIKE inverts the match', async () => {
    const aMatches = await ql.execute("SELECT name FROM cities WHERE name LIKE 'A%'");
    const aNonMatches = await ql.execute("SELECT name FROM cities WHERE name NOT LIKE 'A%'");
    expect(aMatches.length + aNonMatches.length).toBe(11);
  });

  it('LIKE is case-insensitive', async () => {
    const rows = await ql.execute("SELECT name FROM cities WHERE name LIKE 'gent'");
    expect(rows).toHaveLength(1);
  });
});

// ── MIN/MAX on large groups (no spread overflow) ──────────────────────────────

describe('MIN/MAX on large groups', () => {
  it('handles thousands of values without RangeError', async () => {
    const ql = await setupDb();
    // Insert many rows into a fresh collection so the spread limit would trip.
    const N = 5000;
    for (let i = 0; i < N; i++) {
      await ql.execute(`INSERT INTO bignums VALUES {id: 'r${i}', n: ${i}}`);
    }
    const rows = await ql.execute('SELECT MIN(n), MAX(n) FROM bignums');
    expect(rows[0]?.['MIN(n)']).toBe(0);
    expect(rows[0]?.['MAX(n)']).toBe(N - 1);
  });
});

// ── IS NULL / IS NOT NULL ─────────────────────────────────────────────────────

describe('IS NULL / IS NOT NULL', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
    await ql.execute("INSERT INTO drivers VALUES {id: 'd1', name: 'Alice', license: 'B'}");
    await ql.execute("INSERT INTO drivers VALUES {id: 'd2', name: 'Bob'}");
    await ql.execute("INSERT INTO drivers VALUES {id: 'd3', name: 'Carol', license: 'C'}");
  });

  it('IS NULL matches rows where the field is absent', async () => {
    const rows = await ql.execute('SELECT id FROM drivers WHERE license IS NULL');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['id']).toBe('d2');
  });

  it('IS NOT NULL matches rows where the field has a value', async () => {
    const rows = await ql.execute('SELECT id FROM drivers WHERE license IS NOT NULL');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r['id']))).toEqual(new Set(['d1', 'd3']));
  });

  it('combines with AND/OR', async () => {
    const rows = await ql.execute(
      "SELECT id FROM drivers WHERE license IS NULL OR name = 'Alice'",
    );
    expect(rows).toHaveLength(2);
  });
});

// ── IN / NOT IN ───────────────────────────────────────────────────────────────

describe('IN / NOT IN', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('IN filters by string set', async () => {
    const rows = await ql.execute("SELECT id FROM cities WHERE country IN ('BE', 'NL')");
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => String(r['id']).length > 0)).toBe(true);
  });

  it('IN filters by numeric set', async () => {
    const rows = await ql.execute('SELECT id FROM cities WHERE population IN (260000, 520000, 550000)');
    expect(rows).toHaveLength(3);
  });

  it('NOT IN inverts the set', async () => {
    const beNl = await ql.execute("SELECT id FROM cities WHERE country IN ('BE', 'NL')");
    const other = await ql.execute("SELECT id FROM cities WHERE country NOT IN ('BE', 'NL')");
    expect(beNl.length + other.length).toBe(11);
  });

  it('empty IN list is rejected', async () => {
    await expect(ql.execute('SELECT * FROM cities WHERE country IN ()')).rejects.toThrow();
  });

  it('IN composes with other predicates via AND', async () => {
    const rows = await ql.execute(
      "SELECT id FROM cities WHERE country IN ('BE', 'NL') AND population > 600000",
    );
    // Brussel (1.2M), Amsterdam (900k), Rotterdam (650k)
    expect(rows).toHaveLength(3);
  });
});

// ── BETWEEN / NOT BETWEEN ─────────────────────────────────────────────────────

describe('BETWEEN / NOT BETWEEN', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('BETWEEN is inclusive on both bounds', async () => {
    const rows = await ql.execute('SELECT id FROM cities WHERE population BETWEEN 520000 AND 550000');
    // Lyon 520k, Antwerpen 530k, Den Haag 550k
    expect(rows).toHaveLength(3);
  });

  it('NOT BETWEEN excludes the range', async () => {
    const within = await ql.execute(
      'SELECT id FROM cities WHERE population BETWEEN 500000 AND 1000000',
    );
    const outside = await ql.execute(
      'SELECT id FROM cities WHERE population NOT BETWEEN 500000 AND 1000000',
    );
    expect(within.length + outside.length).toBe(11);
  });

  it('combines with other predicates', async () => {
    const rows = await ql.execute(
      "SELECT id FROM cities WHERE country = 'BE' AND population BETWEEN 200000 AND 600000",
    );
    // Gent 260k, Antwerpen 530k
    expect(rows).toHaveLength(2);
  });
});

// ── NOT (prefix) ──────────────────────────────────────────────────────────────

describe('NOT (prefix negation)', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('NOT (expr) negates a comparison', async () => {
    const beRows = await ql.execute("SELECT id FROM cities WHERE country = 'BE'");
    const notBe = await ql.execute("SELECT id FROM cities WHERE NOT (country = 'BE')");
    expect(beRows.length + notBe.length).toBe(11);
  });

  it('NOT can wrap a compound expression', async () => {
    const rows = await ql.execute(
      "SELECT id FROM cities WHERE NOT (country = 'BE' OR country = 'FR')",
    );
    // NL (3) + DE (3) = 6
    expect(rows).toHaveLength(6);
  });

  it('double NOT is a no-op', async () => {
    const single = await ql.execute("SELECT id FROM cities WHERE country = 'BE'");
    const double = await ql.execute("SELECT id FROM cities WHERE NOT (NOT (country = 'BE'))");
    expect(double).toHaveLength(single.length);
  });
});

// ── SELECT DISTINCT ───────────────────────────────────────────────────────────

describe('SELECT DISTINCT', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('DISTINCT on a single column dedupes', async () => {
    const rows = await ql.execute('SELECT DISTINCT country FROM cities');
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r['country']))).toEqual(new Set(['BE', 'NL', 'FR', 'DE']));
  });

  it('DISTINCT respects WHERE', async () => {
    const rows = await ql.execute("SELECT DISTINCT country FROM cities WHERE population > 500000");
    expect(new Set(rows.map((r) => r['country']))).toEqual(new Set(['BE', 'NL', 'FR', 'DE']));
  });

  it('DISTINCT on multiple columns dedupes by tuple', async () => {
    // Each city is unique so the row count matches the underlying count.
    const rows = await ql.execute('SELECT DISTINCT country, name FROM cities');
    expect(rows).toHaveLength(11);
  });

  it('DISTINCT with ORDER BY sorts the deduped result', async () => {
    const rows = await ql.execute('SELECT DISTINCT country FROM cities ORDER BY country ASC');
    expect(rows.map((r) => r['country'])).toEqual(['BE', 'DE', 'FR', 'NL']);
  });

  it('DISTINCT with LIMIT applies after dedupe', async () => {
    const rows = await ql.execute('SELECT DISTINCT country FROM cities ORDER BY country ASC LIMIT 2');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r['country'])).toEqual(['BE', 'DE']);
  });
});

// ── COUNT(DISTINCT field) ────────────────────────────────────────────────────

describe('AGG(DISTINCT field)', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('COUNT(DISTINCT) counts unique values', async () => {
    const rows = await ql.execute('SELECT COUNT(DISTINCT country) FROM cities');
    expect(rows[0]?.['COUNT(DISTINCT country)']).toBe(4);
  });

  it('COUNT(DISTINCT) ignores missing values', async () => {
    await ql.execute("INSERT INTO partial VALUES {id: 'p1', tag: 'a'}");
    await ql.execute("INSERT INTO partial VALUES {id: 'p2', tag: 'a'}");
    await ql.execute("INSERT INTO partial VALUES {id: 'p3', tag: 'b'}");
    await ql.execute("INSERT INTO partial VALUES {id: 'p4'}");
    const rows = await ql.execute('SELECT COUNT(DISTINCT tag) FROM partial');
    expect(rows[0]?.['COUNT(DISTINCT tag)']).toBe(2);
  });

  it('SUM(DISTINCT) sums unique values only', async () => {
    await ql.execute("INSERT INTO dupes VALUES {id: 'a', n: 10}");
    await ql.execute("INSERT INTO dupes VALUES {id: 'b', n: 10}");
    await ql.execute("INSERT INTO dupes VALUES {id: 'c', n: 20}");
    const rows = await ql.execute('SELECT SUM(DISTINCT n) FROM dupes');
    expect(rows[0]?.['SUM(DISTINCT n)']).toBe(30);
  });

  it('COUNT(DISTINCT) per group', async () => {
    const rows = await ql.execute(
      'SELECT country, COUNT(DISTINCT population) FROM cities GROUP BY country ORDER BY country ASC',
    );
    expect(rows).toHaveLength(4);
    expect(rows[0]?.['country']).toBe('BE');
    expect(rows[0]?.['COUNT(DISTINCT population)']).toBe(3);
  });

  it('DISTINCT * is rejected', async () => {
    await expect(ql.execute('SELECT COUNT(DISTINCT *) FROM cities')).rejects.toThrow();
  });

  it('COUNT(DISTINCT) with AS alias projects under the alias', async () => {
    const rows = await ql.execute(
      'SELECT COUNT(DISTINCT country) AS n_countries FROM cities',
    );
    expect(rows[0]?.['n_countries']).toBe(4);
    expect(rows[0]).not.toHaveProperty('COUNT(DISTINCT country)');
  });
});

// ── UPDATE ────────────────────────────────────────────────────────────────────

describe('UPDATE', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('UPDATE with WHERE updates only matching rows', async () => {
    const result = await ql.execute(
      "UPDATE cities SET population = 999 WHERE country = 'BE'",
    );
    expect(result).toHaveLength(3);
    const after = await ql.execute("SELECT population FROM cities WHERE country = 'BE'");
    expect(after.every((r) => r['population'] === 999)).toBe(true);
    const other = await ql.execute("SELECT population FROM cities WHERE country = 'NL'");
    expect(other.every((r) => r['population'] !== 999)).toBe(true);
  });

  it('UPDATE without WHERE updates every row', async () => {
    const ql2 = await setupDb();
    const result = await ql2.execute("UPDATE cities SET country = 'XX'");
    expect(result).toHaveLength(11);
    const rows = await ql2.execute('SELECT country FROM cities');
    expect(rows.every((r) => r['country'] === 'XX')).toBe(true);
  });

  it('UPDATE supports multiple SET assignments', async () => {
    const ql2 = await setupDb();
    await ql2.execute(
      "UPDATE cities SET population = 1, country = 'ZZ' WHERE name = 'Gent'",
    );
    const row = (await ql2.execute("SELECT * FROM cities WHERE name = 'Gent'"))[0];
    expect(row['population']).toBe(1);
    expect(row['country']).toBe('ZZ');
  });

  it('UPDATE returns 0 rows when WHERE matches nothing', async () => {
    const ql2 = await setupDb();
    const result = await ql2.execute("UPDATE cities SET population = 0 WHERE country = 'ZZ'");
    expect(result).toHaveLength(0);
  });

  it('UPDATE cannot change id', async () => {
    const ql2 = await setupDb();
    await expect(
      ql2.execute("UPDATE cities SET id = 'newgent' WHERE id = 'gent'"),
    ).rejects.toThrow(/cannot change "id"/i);
  });

  it('UPDATE with IN filter', async () => {
    const ql2 = await setupDb();
    const result = await ql2.execute(
      "UPDATE cities SET population = 1 WHERE country IN ('BE', 'NL')",
    );
    expect(result).toHaveLength(6);
  });

  it('UPDATE parses kind as "update"', async () => {
    const parsed = ql.parse("UPDATE cities SET population = 1 WHERE id = 'gent'");
    expect(parsed.kind).toBe('update');
  });

  it('UPDATE with no SET fields is rejected', async () => {
    await expect(ql.execute("UPDATE cities WHERE id = 'gent'")).rejects.toThrow();
  });
});

// ── Multi-JOIN ────────────────────────────────────────────────────────────────

describe('multiple JOINs', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
    // Add a third collection so we can chain joins.
    await ql.execute("INSERT INTO continents VALUES {id: 'Europa', region: 'EMEA'}");
    await ql.execute("INSERT INTO continents VALUES {id: 'Azië', region: 'APAC'}");
  });

  it('chains two INNER JOINs end-to-end', async () => {
    const rows = await ql.execute(
      "SELECT name, region FROM cities " +
        'JOIN countries ON cities.country = countries.id ' +
        'JOIN continents ON countries.continent = continents.id ' +
        "WHERE country = 'BE'",
    );
    // 3 BE cities, all with continent Europa → 3 rows, all region EMEA.
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r['region'] === 'EMEA')).toBe(true);
  });

  it('chained join + GROUP BY', async () => {
    const rows = await ql.execute(
      'SELECT region, COUNT(*) AS n FROM cities ' +
        'JOIN countries ON cities.country = countries.id ' +
        'JOIN continents ON countries.continent = continents.id ' +
        'GROUP BY region',
    );
    // All 11 cities live in Europa → one group, count 11.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['region']).toBe('EMEA');
    expect(rows[0]?.['n']).toBe(11);
  });

  it('chained join supports DISTINCT', async () => {
    const rows = await ql.execute(
      'SELECT DISTINCT region FROM cities ' +
        'JOIN countries ON cities.country = countries.id ' +
        'JOIN continents ON countries.continent = continents.id',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['region']).toBe('EMEA');
  });

  it('single-join queries still work unchanged', async () => {
    const rows = await ql.execute(
      'SELECT name, continent FROM cities JOIN countries ON cities.country = countries.id',
    );
    expect(rows).toHaveLength(11);
    expect(rows.every((r) => r['continent'] === 'Europa')).toBe(true);
  });

  it('parser exposes joins as an array', () => {
    const parsed = ql.parse(
      'SELECT * FROM cities ' +
        'JOIN countries ON cities.country = countries.id ' +
        'JOIN continents ON countries.continent = continents.id',
    );
    expect(parsed.kind).toBe('select');
    if (parsed.kind !== 'select') return;
    expect(parsed.joins).toHaveLength(2);
    expect(parsed.joins?.[0]?.collection).toBe('countries');
    expect(parsed.joins?.[1]?.collection).toBe('continents');
  });
});

// ── Subqueries (IN (SELECT ...)) ──────────────────────────────────────────────

describe('Subqueries', () => {
  let ql: QueryLanguage;
  beforeAll(async () => {
    ql = await setupDb();
  });

  it('field IN (SELECT field FROM ...)', async () => {
    const rows = await ql.execute(
      "SELECT id FROM cities WHERE country IN (SELECT id FROM countries WHERE continent = 'Europa')",
    );
    expect(rows).toHaveLength(11);
  });

  it('NOT IN (SELECT ...) inverts the membership', async () => {
    // Insert a country that has no city.
    const ql2 = await setupDb();
    await ql2.execute("INSERT INTO countries VALUES {id: 'XX', name: 'Mars', continent: 'Sol'}");
    const rows = await ql2.execute(
      'SELECT id FROM countries WHERE id NOT IN (SELECT country FROM cities)',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['id']).toBe('XX');
  });

  it('subquery with its own WHERE works', async () => {
    const rows = await ql.execute(
      'SELECT id FROM cities WHERE country IN ' +
        '(SELECT id FROM countries WHERE name = \'België\')',
    );
    expect(rows).toHaveLength(3);
  });

  it('subquery with ORDER BY / LIMIT inside (paren-aware split)', async () => {
    const rows = await ql.execute(
      'SELECT id FROM cities WHERE country IN ' +
        '(SELECT id FROM countries ORDER BY name ASC LIMIT 2)',
    );
    // The two alphabetically-first countries are BE (België) and DE (Duitsland).
    // Cities in those: BE = 3, DE = 3 = 6 total.
    expect(rows).toHaveLength(6);
  });

  it('subquery that returns multiple columns is rejected', async () => {
    await expect(
      ql.execute('SELECT id FROM cities WHERE country IN (SELECT id, name FROM countries)'),
    ).rejects.toThrow(/exactly one column/i);
  });

  it('combines subquery with other predicates', async () => {
    const rows = await ql.execute(
      "SELECT id FROM cities WHERE country IN (SELECT id FROM countries WHERE name = 'België') AND population > 500000",
    );
    // BE cities > 500k: Brussel, Antwerpen
    expect(rows).toHaveLength(2);
  });
});
