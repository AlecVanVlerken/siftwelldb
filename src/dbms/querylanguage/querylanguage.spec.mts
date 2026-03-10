// author: Matisse De Gauquier

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { RealFile } from '../../core/file.mjs';
import { SimpleDbms } from '../simpledbms.mjs';
import { QueryLanguage } from './querylanguage.mjs';

// ── Setup ─────────────────────────────────────────────────────────────────────

let dbCounter = 0;

async function setupDb(): Promise<QueryLanguage> {
  const id = dbCounter++;
  const dataPath = `/tmp/test_querylang_${id}.data`;
  const logPath = `/tmp/test_querylang_${id}.log`;

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
