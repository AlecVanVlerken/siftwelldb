# Query Language

`src/dbms/querylanguage/` ships a SQL-flavoured query language tailored to
SimpleDBMS. The same parser, planner, and executor power three entry points:

- the CLI (`npm run cli -- "<query>"`)
- the **Query Language** tab in the browser UI
- the `QueryLanguage` class for programmatic use

This document is the single source of truth for what the language accepts,
how it executes, and where its limits are.

## Contents

1. [Quick start](#quick-start)
2. [Data model](#data-model)
3. [Statements](#statements)
   - [SELECT](#select)
   - [INSERT](#insert)
   - [UPDATE](#update)
   - [DELETE](#delete)
   - [EXPLAIN](#explain)
4. [Expressions in `WHERE` and `HAVING`](#expressions-in-where-and-having)
5. [Aggregates and `GROUP BY` / `HAVING`](#aggregates-and-group-by--having)
6. [`SELECT DISTINCT`](#select-distinct)
7. [`ORDER BY`, `LIMIT`, `OFFSET`](#order-by-limit-offset)
8. [Type semantics](#type-semantics)
9. [Execution model and the planner](#execution-model-and-the-planner)
10. [Errors](#errors)
11. [What is intentionally out of scope](#what-is-intentionally-out-of-scope)
12. [Programmatic API](#programmatic-api)

---

## Quick start

The CLI accepts a single quoted statement:

```bash
npm run cli -- "SELECT * FROM cities"
npm run cli -- --data my.db --log my.db.log \
  "SELECT country, COUNT(*) AS n FROM cities GROUP BY country ORDER BY n DESC"
```

The same statements work in the browser UI (`Query Language` tab) once a
database is open, and through the HTTP API:

```bash
curl -sX POST http://localhost:8000/api/query \
  -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT country, COUNT(*) AS n FROM cities GROUP BY country ORDER BY n DESC"}'
```

The HTTP response shape is `{ rows, rowCount, kind, elapsedMs }`. `kind` is
one of `select | insert | update | delete | explain`.

Statements are case-insensitive (`SELECT`, `select`, and `SeLeCt` parse the
same). Trailing semicolons are accepted but optional. Only **one statement
per call** is supported.

---

## Data model

SimpleDBMS stores documents (JSON objects) in named **collections**. Every
document has a primary `id` field (string or number); other fields are
free-form JSON scalars (`string`, `number`, `boolean`, `null`). Image
fields are stored as base64 sidecars and are not directly queryable.

Collections do not have a fixed schema — different documents may use
different fields. The query engine treats a missing field as `null` for
the purposes of `IS NULL`, comparisons, and aggregates.

A small set of fields is **indexed** in a secondary B+ tree at insert
time. The planner uses these indexes when it can (see
[Execution model and the planner](#execution-model-and-the-planner)),
and silently falls back to a full scan otherwise.

---

## Statements

### SELECT

```text
SELECT [DISTINCT] <fields|*> FROM <collection>
  [WHERE <conditions>]
  [GROUP BY <fields>]
  [HAVING <aggregate conditions>]
  [ORDER BY <field> [ASC|DESC] [, <field> [ASC|DESC] ...]]
  [LIMIT n]
  [OFFSET k]
```

- `<fields>` is a comma-separated list of column names, aggregate
  expressions, or `expr AS alias`. `*` projects every field of every
  matching document.
- `<collection>` is a single bare identifier (`[A-Za-z_][A-Za-z0-9_]*`).
  No joins, no cross products, no subqueries.

Examples:

```sql
SELECT * FROM cities;
SELECT name, population FROM cities WHERE country = 'BE';
SELECT country, COUNT(*) AS n FROM cities GROUP BY country ORDER BY n DESC;
SELECT DISTINCT country FROM cities ORDER BY country ASC;
SELECT name FROM cities WHERE name LIKE 'A%' ORDER BY name ASC LIMIT 5;
SELECT COUNT(DISTINCT country) AS n_countries FROM cities;
```

### INSERT

```text
INSERT INTO <collection> VALUES { id: '<value>', <field>: <value>, ... }
```

The body is a JavaScript-style object literal (not strict JSON), so keys
may be unquoted and string values can use single quotes. The `id` field
is **required** and must be unique within the collection.

```sql
INSERT INTO cities VALUES { id: 'antwerp', name: 'Antwerp', country: 'BE', population: 530000 };
INSERT INTO partial VALUES { id: 'p1', tag: 'a' };
```

INSERT returns one `{ id }` row in the result set per inserted document
so `rowCount` matches the affected-row count consistently across all
mutating statements.

### UPDATE

```text
UPDATE <collection> SET <field> = <value> [, <field> = <value> ...] [WHERE <conditions>]
```

- Every `<value>` must be a literal (number, boolean, or quoted string).
  Field-to-field or computed RHS expressions (`salary = salary * 1.1`)
  are **not** supported — perform the read, then issue the write.
- Without a `WHERE` clause every row in the collection is updated.
- Updating the primary key (`SET id = ...`) is rejected to keep secondary
  indexes consistent.

```sql
UPDATE cities SET population = 999 WHERE country = 'BE';
UPDATE cities SET population = 1, country = 'ZZ' WHERE name = 'Gent';
UPDATE cities SET population = 1 WHERE country IN ('BE', 'NL');
```

UPDATE returns one `{ id }` row per modified document.

### DELETE

```text
DELETE FROM <collection>
  [WHERE <conditions>]
  [ORDER BY <field> [ASC|DESC] [, ...]]
  [LIMIT n]
  [OFFSET k]
```

- Without a `WHERE` clause **every row** in the collection is deleted —
  the language does not require an explicit `WHERE TRUE`.
- `ORDER BY` + `LIMIT`/`OFFSET` let you trim a bounded slice of matches,
  which is the only safe way to delete a "top-N" subset.

```sql
DELETE FROM cities WHERE id = 'gent';
DELETE FROM cities WHERE country = 'BE' ORDER BY population ASC LIMIT 1;
DELETE FROM cities;            -- removes every row
```

DELETE returns one `{ id }` row per removed document.

### EXPLAIN

```text
EXPLAIN SELECT ...
```

Prints the (very small) plan the executor will follow: which scan it
opens, which post-load stages run, and what slice is taken. Only
applies to `SELECT`.

```sql
EXPLAIN SELECT id FROM cities WHERE country = 'BE' ORDER BY id ASC LIMIT 2;
-- stage   detail
-- collection   cities
-- scan         secondary index equality on country (BE)
-- filter       row predicate evaluation
-- sort         in memory by id ASC
-- slice        offset 0, limit 2
```

---

## Expressions in `WHERE` and `HAVING`

The `WHERE` (and `HAVING`) clause uses a small hand-written recursive
descent expression parser, so parentheses, precedence, and nesting all
behave like standard SQL.

### Operators

| Form                                  | Meaning                                            |
| ------------------------------------- | -------------------------------------------------- |
| `field = value`                       | Equality (strict, no type coercion).               |
| `field != value`                      | Inequality.                                        |
| `field >  value`, `>=`, `<`, `<=`     | Numeric or string range comparison.                |
| `field LIKE 'pat'`                    | SQL pattern match (`%` = any chars, `_` = one).    |
| `field NOT LIKE 'pat'`                | Negated SQL pattern match.                         |
| `field CONTAINS 'sub'`                | Case-insensitive substring search.                 |
| `field IS NULL`                       | True if the field is missing or `null`.            |
| `field IS NOT NULL`                   | Inverse of `IS NULL`.                              |
| `field IN (v1, v2, ...)`              | Set membership. Empty list is rejected.            |
| `field NOT IN (v1, v2, ...)`          | Inverse of `IN`.                                   |
| `field BETWEEN low AND high`          | Inclusive range; works on numbers **and** strings. |
| `field NOT BETWEEN low AND high`      | Inverse of `BETWEEN`.                              |
| `NOT (expr)`                          | Logical negation; can wrap any sub-expression.     |
| `expr AND expr`, `expr OR expr`       | Conjunction / disjunction.                         |
| `(expr)`                              | Parentheses to override precedence.                |

`LIKE`/`CONTAINS` are **case-insensitive**. All other string comparisons
are case-sensitive and use deterministic Unicode code-point order
(see [Type semantics](#type-semantics)).

### Literals

Values are parsed from the source text:

- **Strings** in single or double quotes: `'BE'`, `"Antwerp"`.
- **Numbers** (decimal allowed, leading `-` allowed): `42`, `-3.14`.
- **Booleans**: `true` / `false`, case-insensitive.
- **NULL semantics** are expressed via `IS NULL` / `IS NOT NULL`; you
  cannot write `field = NULL`.

Unknown tokens are rejected at parse time. The engine never silently
coerces between types.

### Precedence and parentheses

`AND` binds tighter than `OR`. Use parentheses to override:

```sql
SELECT id FROM cities
WHERE (country = 'BE' OR country = 'NL') AND population > 500000;
```

`NOT (expr)` can wrap any expression, including another `NOT`. Two
nested `NOT`s cancel out exactly:

```sql
WHERE NOT (NOT (country = 'BE'))   -- same as: country = 'BE'
```

### Examples

```sql
SELECT * FROM cities WHERE country = 'BE' AND population > 500000;
SELECT * FROM cities WHERE country IN ('BE', 'NL') AND population NOT BETWEEN 200000 AND 400000;
SELECT * FROM cities WHERE name LIKE 'A%';
SELECT * FROM cities WHERE name CONTAINS 'dam';
SELECT * FROM partial WHERE tag IS NULL;
SELECT * FROM cities WHERE NOT (country = 'BE' OR country = 'FR');
```

---

## Aggregates and `GROUP BY` / `HAVING`

### Functions

| Function            | Notes                                                                |
| ------------------- | -------------------------------------------------------------------- |
| `COUNT(*)`          | Counts every row, nulls included.                                    |
| `COUNT(field)`      | Counts rows where `field` is not `null`/`undefined`.                 |
| `COUNT(DISTINCT f)` | Counts unique non-null values of `f`.                                |
| `SUM(field)`        | Sums numeric values. Non-numbers are ignored, not zero-coerced.      |
| `SUM(DISTINCT f)`   | Sums unique numeric values of `f`.                                   |
| `AVG(field)`        | Arithmetic mean of numeric values.                                   |
| `AVG(DISTINCT f)`   | Mean of unique numeric values.                                       |
| `MIN(field)`        | Smallest comparable value (string, number, boolean).                 |
| `MAX(field)`        | Largest comparable value.                                            |

Empty input (`SUM`/`AVG`/`MIN`/`MAX` over zero rows) returns `null`
(rendered as `undefined` in the projected row), matching standard SQL.
This is deliberate so an actual zero can be distinguished from "no
rows".

`MIN`/`MAX` walk the input in O(n) rather than spreading into
`Math.min`/`Math.max`, so they are safe over groups of arbitrary size.

### `GROUP BY`

Aggregate without `GROUP BY` produces a single result row over the
whole collection:

```sql
SELECT COUNT(*) FROM cities;
SELECT AVG(population) FROM cities;
SELECT MIN(name), MAX(name) FROM cities;
```

`GROUP BY` partitions rows by one or more fields. The `SELECT` list may
only contain grouped fields and aggregate functions — projecting a
non-grouped, non-aggregated field is rejected at parse time.

```sql
SELECT country, COUNT(*) AS n FROM cities GROUP BY country;
SELECT country, AVG(population), MIN(population), MAX(population)
FROM cities GROUP BY country;
SELECT country, COUNT(DISTINCT population) FROM cities GROUP BY country;
```

### `HAVING`

`HAVING` filters whole groups (or the single global aggregate row) by
their aggregate values. The same operator surface as `WHERE` applies,
plus you can reference aggregates by their canonical name or alias.

```sql
SELECT country, COUNT(*) AS n FROM cities GROUP BY country HAVING n > 2;
SELECT country, AVG(population) FROM cities GROUP BY country
HAVING AVG(population) >= 500000;
SELECT team, MIN(score) FROM matches GROUP BY team HAVING MIN(score) IS NULL;
```

`HAVING` without `GROUP BY` or any aggregate in the `SELECT` list is a
parse error.

---

## `SELECT DISTINCT`

`SELECT DISTINCT` dedupes the projected rows after `WHERE` runs and
before `LIMIT`/`OFFSET`. Dedup compares the full column tuple, not just
the first column:

```sql
SELECT DISTINCT country FROM cities;
SELECT DISTINCT country, name FROM cities;
SELECT DISTINCT country FROM cities ORDER BY country ASC LIMIT 2;
```

`DISTINCT` interacts with `ORDER BY` strictly: when using `DISTINCT`,
`ORDER BY` may only reference columns or aliases that appear in the
`SELECT` list. This avoids the ambiguity of "sort by a column the user
asked to drop".

---

## `ORDER BY`, `LIMIT`, `OFFSET`

`ORDER BY` accepts one or more `<field> [ASC|DESC]` keys; `ASC` is the
default. Sorting is stable and uses the deterministic comparator
described in [Type semantics](#type-semantics).

`ORDER BY` may reference column aliases declared earlier in the
`SELECT` list:

```sql
SELECT name, population AS pop FROM cities ORDER BY pop DESC;
SELECT country, COUNT(*) AS n FROM cities GROUP BY country ORDER BY n DESC;
```

In a non-`DISTINCT`, non-`GROUP BY` select, `ORDER BY` may also
reference fields that aren't in the projection.

`LIMIT n` and `OFFSET k` must be non-negative integers. `LIMIT 0`
returns an empty result; `OFFSET k` beyond the row count returns an
empty result.

---

## Type semantics

### Strict equality

`=` and `!=` compare without coercion. `42 = '42'` is **false**.
Comparing different scalar types with `>` / `<` is a runtime error:

```text
SELECT * FROM cities WHERE population > '30';
-- Error: Cannot compare values of different types: number and string
```

### Deterministic string order

String comparisons (`<`/`>`/`>=`/`<=`, `ORDER BY`, `MIN`/`MAX`) use
**Unicode code-point order**, not `localeCompare`. This makes results
reproducible across operating systems, ICU versions, and locales — a
query run in a Dutch locale produces the same row order as one run in
`en_US`. (As a side-effect, `'M'` (`0x4D`) sorts before `'R'` (`0x52`),
so `MAX(name)` over `{Amsterdam, München, Rotterdam}` returns
`Rotterdam`.)

### Booleans

In comparisons booleans sort as `false < true`. In aggregates,
booleans are ignored by `SUM`/`AVG` (they are not numeric) but
participate in `MIN`/`MAX`. Equality (`field = true`) and `IN`
membership work as expected.

### Nulls

A missing field, an explicit `null`, and `undefined` are all treated as
"absent". They are matched by `IS NULL`, skipped by `IS NOT NULL`, never
match `=` / `!=` / `>` / `<` (those return `false`), and are ignored by
all aggregates other than `COUNT(*)`.

---

## Execution model and the planner

For each query the engine runs a small pipeline:

```
plan cursor → open cursor → load rows → WHERE → GROUP BY → project → ORDER BY → OFFSET/LIMIT
```

The **planner** (`planner.mts`) looks at the top-level AND-chain of the
`WHERE` clause and picks one of three cursor shapes:

1. **Point lookup** — when `WHERE id = X` is present. Uses the primary
   index for an O(log N) seek.
2. **Secondary-index equality seek** — when `WHERE f = X` is present and
   `f` is indexed. Seeks the secondary B+ tree and stops as soon as the
   leaf value changes. Best case O(log N + matches).
3. **Full scan** — anything else. The collection is walked in `id`
   order and `WHERE` filters per row.

The planner refuses to peek through `OR`, because the other branch
could match values you would otherwise skip. Everything after the
cursor is correctness-preserving regardless of which plan is chosen —
the planner only changes the constant in front of `O(...)`.

You can inspect the chosen plan with `EXPLAIN SELECT ...`.

---

## Errors

The parser and executor throw on:

- syntactically invalid statements;
- unsupported features (`JOIN`, subqueries, `UNION`);
- comparisons between different scalar types;
- unrecognised literals (`field = banana`, `field = NULL`);
- empty `IN ()` lists;
- non-integer or negative `LIMIT`/`OFFSET`;
- `HAVING` without `GROUP BY` and no aggregates;
- non-aggregated, non-grouped columns next to aggregates;
- `ORDER BY` referencing a column dropped by `SELECT DISTINCT`;
- `UPDATE SET id = ...`;
- DELETE/UPDATE clauses other than the ones documented above.

Through the HTTP API, parse and runtime errors come back as
`{ "error": "<message>" }` with HTTP 400.

---

## What is intentionally out of scope

The language is deliberately small. The following are **not** supported
and will throw at parse time:

- `JOIN` (any flavour) — query one collection per statement; build
  composite documents at write time instead.
- Subqueries (`WHERE x IN (SELECT ...)`).
- `UNION` / `UNION ALL`.
- Computed-column SELECT expressions (`SELECT population * 1.1 FROM ...`).
- Field-to-field references on the RHS of `UPDATE SET`.
- Window functions, CTEs, recursive queries, transactions.
- Type casts (`CAST(... AS ...)`).

If you need these in the conversational/analytics path, the API surface
`QueryLanguage.executeOnRows(preloadedRows, parsedSelect)` lets you
inject derived/computed fields **before** running the in-memory tail of
the pipeline.

---

## Programmatic API

```ts
import { SimpleDbms } from './dbms/simpledbms.mjs';
import { QueryLanguage } from './dbms/querylanguage/querylanguage.mjs';

const db = await SimpleDbms.open(/* ... */);
const ql = new QueryLanguage(db);

const rows = await ql.execute("SELECT country, COUNT(*) AS n FROM cities GROUP BY country");

const parsed = ql.parse("SELECT name FROM cities WHERE country = 'BE'");
// parsed is a ParsedQuery: { kind: 'select', collection, fields, where, ... }

// Run the in-memory tail of a SELECT against rows you already loaded
// (e.g. rows enriched with derived fields by the conversational engine).
const filtered = ql.executeOnRows(rows, parsedSelect);
```

Every parser/AST/executor type is re-exported from `querylanguage.mts`
so external callers don't need to reach into individual files.
