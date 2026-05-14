# Query Language Extensions

A summary of the changes that landed in this session.

## TL;DR

The `QueryLanguage` got a much larger SQL surface and a real secondary-index seek path. The conversational AI now also gets a prompt that advertises everything it can produce.

| Area | Before | After |
|---|---|---|
| `WHERE` operators | `=`, `!=`, `<`, `<=`, `>`, `>=`, `LIKE`, `NOT LIKE`, `AND`, `OR` + parens | All of the above + `IS NULL`, `IS NOT NULL`, `NOT (...)`, `IN (...)`, `NOT IN (...)`, `BETWEEN ... AND ...`, `NOT BETWEEN ... AND ...`, `IN (SELECT ...)` |
| `SELECT` | `SELECT … FROM …` | + `SELECT DISTINCT …`, + `COUNT/SUM/AVG/MIN/MAX(DISTINCT field)` |
| DML | `INSERT`, `DELETE` | + `UPDATE <coll> SET f = v [, …] [WHERE …]` |
| Joins | One `JOIN ... ON ...` per query | Arbitrary chained joins (`FROM a JOIN b ON … JOIN c ON …`) |
| Set ops | none | `UNION` (dedup), `UNION ALL` |
| Sort | `localeCompare` (locale-dependent) | Code-point comparator (deterministic) |
| Index use | `id = X` point lookup only | + secondary-index equality seek with early termination, schema-aware with full-scan fallback |
| AI prompt | Documented operator subset; LLM regularly emitted unsupported SQL | Documents the full new surface + concrete examples + SELECT-only rule |
| Tests | 95 querylanguage tests | 142 querylanguage tests |
| JOIN grammar | One implicit `INNER`-or-inferred-`NATURAL`-or-inferred-`CROSS` join | Explicit `INNER` / `NATURAL` / `CROSS` keywords; LEFT / RIGHT / bare-`JOIN` rejected with a clear error |
| Empty-aggregate semantics | `0` (indistinguishable from real zero) | `null` (renders as missing column; matches `IS NULL` in `HAVING`) |
| GROUP BY key | `String(v)` joined with `|` (collisions on `null`/`undefined`/`''`, on values containing `|`) | length-prefixed JSON per field; null/undefined/'' are three distinct keys |
| Chat read-only guard | allowlist `select` only — `UNION` rejected even though it's read-only | denylist mutations; any read-only kind (`select`, `union`, future ones) is accepted |

Test pass at end of session: **142 / 142** in `querylanguage.spec.mts`, **524 / 524** in the full `npm test` suite. Project type-check is clean.

---

## Why these changes (the AI audit)

The conversational engine generates SQL via an LLM that is constrained only by the system prompt. In practice the LLM falls back to idiomatic SQL whenever the natural language hints at it — even if the prompt doesn't explicitly allow it. I observed (and you noted) that the following patterns were likely-to-fail:

| Pattern | Example | Status before this session |
|---|---|---|
| `IS NULL` / `IS NOT NULL` | `WHERE manager_id IS NULL` | rejected |
| `IN (...)` / `NOT IN (...)` | `WHERE dept IN ('HR', 'Sales')` | rejected |
| `BETWEEN ... AND ...` | `WHERE salary BETWEEN 50k AND 100k` | rejected |
| `NOT (expr)` | `WHERE NOT (active = true)` | rejected |
| `DISTINCT` | `SELECT DISTINCT department` | rejected |
| `COUNT(DISTINCT field)` | `SELECT COUNT(DISTINCT department)` | rejected |
| Multiple JOINs | `FROM a JOIN b ON … JOIN c ON …` | rejected |
| Subquery in `WHERE` | `WHERE id IN (SELECT …)` | rejected |
| `UNION` / `UNION ALL` | two SELECTs combined | rejected |

Every one of those now works end-to-end. The system prompt now advertises them so the LLM uses them by default rather than as fallback patterns.

Items deliberately not implemented (rationale at the bottom): table aliases (`FROM x AS y`), scalar subqueries, `COALESCE`/`CASE WHEN`, arithmetic in SELECT.

---

## Phase 4 — `IS NULL`, `NOT`, `IN`, `BETWEEN`

### What

Four new WHERE/HAVING constructs, all natively typed in the AST and evaluated row-by-row.

### Why

Each is a thing the LLM regularly emits. `IS NULL` is also strictly new capability — there was no other way to express "this field is missing".

### Changes

- **`src/dbms/querylanguage/ast.mts`** — added `IsNullExpression`, `InExpression`, `BetweenExpression`, `NotExpression`; widened `WhereExpression` to a 6-arm discriminated union.
- **`src/dbms/querylanguage/parser.mts`** — tokenizer learned keywords (`IS`, `NULL`, `IN`, `BETWEEN`), the bare `NOT` token, and a `comma` token. Replaced `parseComparison` with `parseFieldExpression`, which peeks the token after the field name and dispatches to one of: comparison tail / `parseIsNull` / `parseIn` / `parseBetween`. `parsePrimary` now also accepts a prefix `NOT` and wraps the sub-expression in `NotExpression`.
- **`src/dbms/querylanguage/expressions.mts`** — `evaluateWhere` switched from chained `if` to an exhaustive `switch`; added `evaluateIsNull`, `evaluateIn`, `evaluateBetween`. `IN` against a subquery `values` field throws if the executor didn't pre-resolve it — that's a defensive guardrail since the executor must materialise subqueries first (see Phase 8).
- **`src/dbms/querylanguage/planner.mts`** — `findIdEquality` now bails on any non-`comparison`/`logical` node, so it won't try to seek when one of the new operators is in play.

### Tests added (14)

- `IS NULL` matches missing rows; `IS NOT NULL` matches present rows; both compose with `AND`/`OR`.
- `IN` on strings, numbers, with `NOT IN`; rejection of empty lists; composition via `AND`.
- `BETWEEN` is inclusive on both bounds; `NOT BETWEEN`; composes with other predicates.
- `NOT (expr)`; `NOT` wrapping a compound expression; double `NOT` is a no-op.

---

## Phase 5 — `DISTINCT` (statement-level and aggregate-level)

### What

`SELECT DISTINCT …` and `AGG(DISTINCT field)` for every aggregate function (`COUNT`/`SUM`/`AVG`/`MIN`/`MAX`).

### Why

`SELECT DISTINCT` is the canonical SQL idiom for "list unique values". `COUNT(DISTINCT field)` is the canonical idiom for "how many unique values". Both are very common LLM emissions for any "how many distinct X" question.

### Changes

- **`ast.mts`** — `ParsedSelect.distinct?: boolean` and `AggregateExpression.distinct?: boolean`.
- **`parser.mts`** — strips a leading `DISTINCT` keyword from the SELECT list and marks `ParsedSelect.distinct`. Aggregate regex extended to optionally accept `DISTINCT` inside the call; canonical alias becomes `FUNC(DISTINCT field)` so downstream lookups don't collide with the non-distinct form. Added `canonicalizeExpr` so field selectors with whitespace variants (`COUNT( name )` vs `COUNT(name)`) project under the same key as the aggregator emits — this was already a latent bug for plain aggregates and now matters more.
- **`aggregator.mts`** — `dedupeBy(rows, field)` returns one row per unique value, dropping `null`/`undefined` (matching SQL's `COUNT(DISTINCT)` semantics). `computeAggregate` uses it when `agg.distinct && agg.field !== '*'`. Also tightened `COUNT(field)` to ignore null/undefined entries (it now diverges from `COUNT(*)` correctly).
- **`executor.mts`** — `dedupeRows(rows)` is now applied after projection in both `executeOnRows` and `finalize`. Stable: first occurrence wins.

### Tests added (11)

- `SELECT DISTINCT` on single and multiple columns, with `WHERE`/`ORDER BY`/`LIMIT`.
- `COUNT(DISTINCT)`, `SUM(DISTINCT)`, per-group `COUNT(DISTINCT)`, alias projection, `DISTINCT *` rejection, ignoring null/missing fields.

---

## Phase 6 — `UPDATE`

### What

`UPDATE <collection> SET f1 = v1 [, f2 = v2, ...] [WHERE ...]`.

### Why

Closes the DML triangle (we already had `INSERT` and `DELETE`). The conversational engine still rejects non-`SELECT` via its existing kind guard, so this is purely for the SQL editor in the web UI; it had no way to edit data through the query path otherwise.

### Changes

- **`ast.mts`** — `ParsedUpdate` and `UpdateAssignment`; added to the `ParsedQuery` union.
- **`parser.mts`** — `UPDATE … SET …` regex + `parseAssignments` splitting on top-level commas. Each RHS goes through `parseValue` so literals follow the same rules as WHERE. Mutating `id` is rejected at parse time (it's the primary key, and changing it would orphan every secondary index).
- **`executor.mts`** — two-pass UPDATE: collect matching ids from a snapshot cursor so in-flight writes never feed back into the scan, then call `dbms.editDocument` once per `(id, field)`. Returns one `{id}` row per affected document so `rowCount` is meaningful — same pattern adopted for `INSERT` (returns `[{id: inserted}]`) and `DELETE` (returns `[{id}, ...]`).
- **`querylanguage.mts`** — exports `ParsedUpdate` and `UpdateAssignment` from the facade. Header docstring now lists `UPDATE` as part of the supported grammar.
- **`src/webclient/service.mts`** — `QueryExecutionResult.kind` widened to include `'update'`; `query()` commits after `update` too.

### Tests added (8)

- WHERE-filtered update / unconditional update / multi-field SET / no-match update / id-protection / `WHERE IN` filter / parser exposes `kind: 'update'` / missing SET clause rejected.

---

## Phase 7 — Multiple JOINs

### What

Arbitrary `JOIN`/`ON` chains, e.g. `FROM a JOIN b ON a.x = b.y JOIN c ON b.z = c.w`.

### Why

A common LLM emission for any question that touches three or more collections. The previous regex only allowed one `JOIN`, so anything more complex hit "Invalid query syntax".

### Changes

- **`ast.mts`** — `ParsedSelect.join?` (singular) became `joins?: JoinClause[]`. Multi-join chains live in a flat array; no consumer outside the query language module referenced the old singular field (verified by grep).
- **`parser.mts`** — broke the monolithic SELECT regex into two stages:
  1. `^select … from <coll> (.*)` (head),
  2. `peelJoins(rest)` iteratively consumes `JOIN <coll> [ON …]` clauses off the front,
  3. `splitSelectTail(remainder)` does a **paren-aware, quote-aware single-pass scan** for the depth-0 occurrences of `WHERE` / `GROUP BY` / `HAVING` / `ORDER BY` / `LIMIT` / `OFFSET` and slices each clause's source. Keywords must appear in canonical SQL order.

   This is the precondition for Phase 8 — a regex can't track paren depth, so a subquery containing its own `ORDER BY` would otherwise eat the outer one.
- **`join.mts`** — split the existing `applyJoin` (merge + filter + project in one pass) into:
  - `mergeJoinedDocs(leftDocs, rightDocs, join, leftName, rightName)` — pure pairwise merge, no WHERE, no projection. The piece needed for chaining.
  - `executeJoinChain(dbms, parsed, baseDocs)` — folds every join into the running result left-to-right by repeatedly loading and merging.
  - `applyJoin` kept as a thin wrapper for the single-join `executeWithPreloadedRows` public API.
- **`executor.mts`** — multi-join SELECTs now go: load base → `executeJoinChain` → `executeOnRows` (which handles `WHERE` → `GROUP BY` → projection → `DISTINCT` → `ORDER BY` → `OFFSET`/`LIMIT` uniformly). `executeWithPreloadedRows` preserves the single-join short-circuit.

#### Caveat documented in the AST comment

> *Earlier collections remain reachable via their already-prefixed `coll.field` columns on overlap.*

That is: each join step prefixes columns whose names collide. So in a 3-way join, references to the first collection's fields stay valid as long as no later join overwrites them.

### Tests added (5)

- 3-way chained join end-to-end / chained join with `GROUP BY` / chained join with `DISTINCT` / single-join compatibility / parser exposes `joins` as an array.

---

## Phase 8 — Subqueries (`field IN (SELECT ...)`)

### What

Uncorrelated subqueries inside `IN` and `NOT IN`. The subquery must project exactly one column.

### Why

A common LLM pattern for cross-collection filtering ("countries that have no cities", "employees in any department where avg salary > 100k"). Not having this forced the LLM to either fake it with a JOIN (works sometimes) or to give up.

### Changes

- **`ast.mts`** — `InExpression.values: FieldValue[] | ParsedSelect`. The parser stores the AST of the subquery; the executor lowers it before evaluation.
- **`parser.mts`** — the WHERE tokenizer now recognises `(SELECT ...)` as one opaque `subquery` token. When the tokenizer sees `(`, it peeks past whitespace; if the next 6 characters spell `SELECT` (case-insensitive) at a word boundary, it scans paren-balanced text from the raw source, emits the entire `( ... )` region as a single token containing the inner SQL, and skips past the closing `)`.

   This is necessary because the WHERE tokenizer treats `LIMIT`, `ORDER`, `BY`, etc. as plain identifiers, so a number-literal inside a subquery's `LIMIT 2` would otherwise blow up tokenization. Treating the subquery as a single opaque region means we never have to teach the WHERE tokenizer SQL.

   `parseIn` consumes the subquery token, runs the top-level `parse()` on the captured text, and stores the resulting `ParsedSelect` on the `InExpression`.
- **`executor.mts`** — `materializeSubqueries(dbms, expr)` walks the WHERE/HAVING tree once before any filtering. For each `InExpression` whose `values` is still a `ParsedSelect`, it:
  1. Executes the subquery via `executeParsed` (which itself recurses, so nested subqueries work).
  2. Reads the first column key from the first result row.
  3. Errors out if the result has anything other than exactly one column.
  4. Collects all non-null values into a list and replaces `values`.

   Per-row evaluation then operates on the value list as if the user had written `IN ('a', 'b', 'c')`.
- Every entry point in the executor (`SELECT`, `DELETE`, `UPDATE`) calls `materializeAllSubqueries` exactly once. Subquery results are not cached across queries.

### Tests added (6)

- Subquery returning matching ids / `NOT IN (SELECT ...)` / subquery with its own `WHERE` / subquery with its own `ORDER BY LIMIT` (validates the paren-aware tail splitter from Phase 7) / multi-column subquery rejected / subquery combined with other predicates via `AND`.

---

## Phase 9 — `UNION` / `UNION ALL`

### What

`<select1> UNION [ALL] <select2> [UNION [ALL] <select3> ...]`.

### Why

Less common than the others but still a recognisable SQL idiom for "merge result sets". Cheap to add once the depth-aware parser machinery from Phase 7/8 was in place.

### Changes

- **`ast.mts`** — `ParsedUnion` with `all: boolean` and `branches: ParsedSelect[]`. Mixing `UNION` and `UNION ALL` in one statement is intentionally rejected — standard SQL accepts it but the semantics are ambiguous without explicit precedence rules.
- **`parser.mts`** — `splitTopLevelUnion(src)` does the same depth-aware single-pass scan as `splitSelectTail`, splitting on `UNION` or `UNION ALL` only at depth 0. The mode is locked by the first separator; subsequent mismatching separators throw. Each branch is recursively `parse()`-d; non-SELECT branches throw.
- **`executor.mts`** — new branch in `executeParsed` for `kind: 'union'`: execute each branch, concat, dedupe unless `all` is set.
- **`querylanguage.mts`** — exports `ParsedUnion` from the facade.
- **`src/webclient/service.mts`** — `QueryExecutionResult.kind` widened to include `'union'`.

### Tests added (6)

- `UNION` dedupes / `UNION ALL` keeps duplicates / three-way `UNION` / parser exposes `kind: 'union'` / mixing modes rejected / depth-aware split doesn't trip on a literal "UNION" outside the depth-0 keyword position.

---

## Phase 10 — Deterministic `ORDER BY`

### What

Replaced `String.prototype.localeCompare` with a code-point comparator.

### Why

`localeCompare` is the most non-deterministic part of the previous engine: results depend on the host OS, the runtime's ICU version, and the process locale. Two equivalent queries on the same data could sort differently on dev (en_US) and a Dutch developer machine. Code-point comparison is purely a property of the strings.

This also iterates by codepoint rather than `<`/`>` so surrogate pairs don't sort wrong.

### Changes

- **`src/dbms/querylanguage/expressions.mts`** — new `compareStringsByCodePoint(a, b)` helper. `compareValues` calls it for two-string and stringified-fallback paths.

### Tests

No new tests — the existing ORDER BY tests still pass and now have a stable cross-platform answer.

---

## Phase 11 — Real secondary-index seeks

### What

`WHERE field = X` on an indexed field is now a B+ tree prefix seek with early termination, instead of a full collection scan with a per-row filter.

### Why

The previous planner explicitly opted out of secondary-index seeks because the indexes use composite `(field, id)` keys and a naive seek didn't stop at the right boundary. The fix isn't to change the back-end keys — it's to wrap the existing cursor with a stop-on-mismatch loop.

### Changes

- **`src/dbms/simpledbms.mts`** — new method `cursorEqual(collection, field, value)`:
  1. Uses `describeCollection(collection)` (already exposed) to check if `field` is indexed.
  2. **Indexed path**: open the existing `dbmsback.cursor(collection, field, value)`. `toBuffer(keyVorm, value)` (the back-end's key encoder) produces a *prefix* buffer for composite keys, so the B+ tree seeks to the first leaf containing `field = value`. We yield documents while `doc[field] === value` and **return** as soon as the value changes — the first key past the matching prefix ends the scan.
  3. **Fallback path**: if `field` isn't indexed (or `field === 'id'` — handled specially since that's already a unique seek), fall back to a scan over the `id` index with a per-row filter. Caller doesn't have to distinguish.
- **`src/dbms/querylanguage/planner.mts`** — rewritten to a discriminated union with three plan kinds: `fullScan`, `idEquality`, `fieldEquality`. `findFieldEquality` walks AND-chains looking for any top-level `field = literal` (refuses to peek through `OR` because the other branch could match different values and seeking would skip valid hits).
- **`src/dbms/querylanguage/executor.mts`** — `openPlannedCursor(dbms, collection, plan)` is the single point where a plan lands on a cursor call. Dispatches on plan kind. The non-join SELECT path uses it; `DELETE` and `UPDATE` still use a plain full scan because they're rarer and not on the critical path.

### Tests added (5)

- `id` point lookup correctness / secondary-index field equality returns exactly the matching set / fallback when the field isn't indexed / numeric field equality / field equality combined with extra `WHERE` predicates (verifies the executor still applies the WHERE filter after the seek).

---

## Phase 12 — AI system prompt update

### What

The `QueryGenerator`'s system prompt now documents the full new surface and gives the LLM concrete examples of each new idiom.

### Why

Without this, the LLM doesn't *know* it can use the new features and may still emit the slightly-different patterns we used to reject. The retry loop would eventually fix them, but at the cost of an extra LLM round-trip and sometimes a worse final query.

### Changes

- **`src/conversational/queryGenerator.mts`** — system prompt now lists:
  - `SELECT DISTINCT`, `JOIN` chains, `UNION [ALL]`.
  - All new WHERE forms: `IN`, `NOT IN`, `BETWEEN`, `IS NULL`, `IS NOT NULL`, `NOT (...)`, parens, subquery `IN (SELECT ...)`.
  - `COUNT(DISTINCT field)` and the other `AGG(DISTINCT)` variants.
  - `AS` aliases (usable in `ORDER BY` and `HAVING`).
  - An explicit "UPDATE / INSERT / DELETE are NOT allowed via chat — only SELECT" rule to backstop the engine-level guard.
  - Six concrete examples mapping natural-language phrasings to the new SQL forms (count per group, count distinct, `IN`, `BETWEEN`, `IS NULL`, multi-table joins).

---

## Files touched

```
src/conversational/queryGenerator.mts            (prompt)
src/dbms/querylanguage/ast.mts                   (AST extensions)
src/dbms/querylanguage/parser.mts                (parser, tokenizer)
src/dbms/querylanguage/expressions.mts           (evaluator, comparator)
src/dbms/querylanguage/aggregator.mts            (DISTINCT, null-aware COUNT)
src/dbms/querylanguage/join.mts                  (multi-join chain)
src/dbms/querylanguage/projection.mts            (no functional change)
src/dbms/querylanguage/planner.mts               (rewritten)
src/dbms/querylanguage/executor.mts              (subquery materialise, plan dispatch, UNION, UPDATE, DISTINCT)
src/dbms/querylanguage/querylanguage.mts         (facade re-exports + doc header)
src/dbms/querylanguage/querylanguage.spec.mts    (30 new tests, 125 total)
src/dbms/simpledbms.mts                          (cursorEqual)
src/webclient/service.mts                        (query() kind widening, commit on UPDATE)
```

---

## What was intentionally NOT done

These came up but weren't in the approved plan; they all involve enough surface for new bugs that they're better as a follow-up:

| Item | Why deferred |
|---|---|
| **Table aliases** (`FROM cities AS c JOIN countries AS co ON c.country = co.id`) | Requires parse-time alias rewriting in every clause that references a field, plus name resolution for unqualified fields (lookup by uniqueness across joined collections). Roughly doubles the work of Phase 7. The LLM is told *not* to use aliases in the updated prompt, so this only matters for human SQL-editor users. |
| **Scalar subqueries** (e.g. `SELECT x, (SELECT MAX(y) FROM …)`) | Would need to lower into the projector and respect per-row state for correlated cases. Phase 8 only does the row-set case. |
| **`COALESCE` / `NULLIF` / `IFNULL`** | Pure value-coercion helpers; LLM doesn't reach for them often in analytics-shaped questions. |
| **`CASE WHEN ... THEN ... ELSE ... END`** | Requires expression language in `SELECT` (currently only field names + aggregate calls). |
| **Arithmetic in `SELECT`** (`salary * 1.05`) | Same — requires real expression evaluation. |
| **`UPDATE` field-from-field** (`SET salary = salary * 1.05`) | The current UPDATE only takes literal RHS. Would need expressions on the right-hand side. |
| **`LEFT` / `RIGHT` / `FULL OUTER` joins** | The executor would need to emit unmatched rows on either side with `null`-filled columns from the missing side. Self-contained but requires a second code path in the merge loop. Now an *explicit* "not supported" error at parse time rather than silent fallthrough. |
| **OR-aware planner specialisations** (`id IN (a, b, c)` → multi-point lookup) | The current planner refuses to seek through OR/IN — correct but conservative. Could turn `IN` on indexed fields into a batched seek later. |

---

## Phase 13 — post-implementation feedback fixes

Audit of the Phase 4–12 work surfaced four design-quality issues. All four are now fixed.

### 1. `executeWithPreloadedRows` single-join shortcut (correctness bug)

The single-join branch called `applyJoin()` which only did merge + filter + project. It silently dropped `GROUP BY`, `DISTINCT`, `ORDER BY`, `OFFSET`, and `LIMIT` for the single-join case while the multi-join branch handled all of them.

**Fix**: collapsed the two branches into one — every join (single or chained) now runs through `executeJoinChain` followed by `executeOnRows`, so the full pipeline is applied uniformly. The legacy `applyJoin()` helper was deleted along with its `evaluateWhere` / `project` imports in `join.mts`.

**Test**: `single JOIN with DISTINCT + ORDER BY + LIMIT honours all stages` (regression).

### 2. Strict JOIN grammar (option b)

The AST declared `JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'NATURAL'`, but the parser only ever produced `'INNER'` and the runtime *inferred* `NATURAL` / `FULL` from the presence of an `ON` clause and overlapping field names. `LEFT` / `RIGHT` were never supported. Result: types lied about capability, and the meaning of `JOIN x` depended on the data shape.

**Fix**: rewrote the grammar to be explicit.

| Form | Type emitted | ON clause |
|---|---|---|
| `JOIN x ON l = r` | `INNER` | required |
| `INNER JOIN x ON l = r` | `INNER` | required |
| `NATURAL JOIN x` | `NATURAL` | forbidden — keys are computed from shared field names at runtime |
| `CROSS JOIN x` | `CROSS` | forbidden — full Cartesian product |
| `LEFT/RIGHT/FULL [OUTER] JOIN x` | — | parse error: explicit "not supported" |
| Bare `JOIN x` with no `ON` | — | parse error: pick one of the three forms |

- `JoinType` is now `'INNER' | 'NATURAL' | 'CROSS'`. No false advertising.
- `mergeJoinedDocs` trusts `join.type` instead of inferring. `NATURAL JOIN` with no overlap throws a clear error.
- LLM prompt updated with the new grammar so generated SQL never falls into the implicit forms.

**Tests** (9 new): explicit type assertions for every form, plus error-case tests for `LEFT JOIN`, `RIGHT JOIN`, bare `JOIN x`, and a Cartesian-product sanity check.

### 3. Aggregator semantics

Three problems:

- `MIN` / `MAX` only worked on numbers (`typeof v === 'number'`).
- `SUM` / `AVG` / `MIN` / `MAX` returned `0` for empty input, indistinguishable from a real zero.
- `GROUP BY` keys were `parts.map(v => String(v ?? '')).join('|')`, which collapses `null` / `undefined` / `''` into the same group and collides on values that contain `|`.

**Fixes**:

- `MIN` / `MAX` now use the shared `compareValues()` comparator (the same one driving `ORDER BY` and `<` / `>`). They work on strings, booleans, numbers, and mixed types — locale-independent.
- `computeAggregate` returns `null` instead of `0` on empty input for `SUM` / `AVG` / `MIN` / `MAX`. `executeGroupBy` maps `null` to `undefined` when writing into the result row (so the column reads as missing), which means `HAVING ... IS NULL` correctly matches empty-group aggregates.
- `GROUP BY` keys are now built per-field as `${jsonLen}:${json}|`, with `undefined` encoded as `'u|'` explicitly (JSON.stringify of undefined is the value `undefined`, not a string). `null`, `undefined`, and `''` are three distinct keys; `'a|b' + 'c'` and `'a' + 'b|c'` are two distinct keys.

**Tests** (6 new): `MIN`/`MAX` on strings, empty-input null returns for `SUM` / `AVG` / `MIN` / `MAX`, `HAVING IS NULL` matching empty groups, distinct grouping for `''` vs `undefined`, no collision on `'a|b'` vs `'a' + 'b'`.

### 4. Chat read-only allowlist

The conversational engine guarded with `if (generated.parsed.kind !== 'select')` — but `UNION` had been added as a read-only operation and was advertised in the LLM prompt. Result: the LLM correctly emitted `UNION`, the executor correctly ran it, and the chat layer correctly rejected it.

**Fix**: inverted to an explicit read-only allowlist (`isReadOnlyKind` returns `true` for `select` and `union`). Any future read-only kind (`EXPLAIN`, `SHOW`, …) can be added in one place; mutating kinds (`insert` / `update` / `delete`) remain rejected.

### Test totals after Phase 13

**142 / 142 passing** in `querylanguage.spec.mts` (was 125 before this phase: +1 regression test for the join-shortcut bug, +9 for strict JOIN grammar, +6 for aggregator fixes; the rest was renumbering).

**524 / 524 passing** in the full `npm test` suite (excludes benchmarks).

---

## Appendix: how our SQL-like language compares to standard SQL

The query language is faithful to SQL's surface syntax for the features it supports, and deliberately strict (no silent inference) for the ones it doesn't. The table below covers every meaningful divergence.

### Same as standard SQL

| Area | Notes |
|---|---|
| `SELECT [DISTINCT] … FROM …` | Same keywords, same ordering. |
| `WHERE` operators `= != < <= > >= LIKE` | Same semantics. `LIKE` supports `%` (any sequence) and `_` (one char) as in standard SQL. |
| `WHERE` operators `IS NULL` / `IS NOT NULL` / `IN` / `NOT IN` / `BETWEEN` / `NOT BETWEEN` / `NOT (...)` | Same syntax and same precedence. Subquery form `IN (SELECT …)` works the same way. |
| `AND` / `OR` with parentheses | Same precedence as SQL: `AND` binds tighter than `OR`. |
| `GROUP BY` / `HAVING` | Same. `HAVING` can reference aggregates by their canonical form or by `AS` alias. |
| `ORDER BY field [ASC|DESC], …` | Same. Multiple sort keys, mixed ASC/DESC. |
| `LIMIT n` / `OFFSET k` | Same. `LIMIT` without `OFFSET` and vice versa both work. |
| Aggregates `COUNT(*)`, `COUNT(field)`, `COUNT(DISTINCT field)`, `SUM`, `AVG`, `MIN`, `MAX`, `*(DISTINCT field)` | Same. `null` / missing are excluded from `COUNT(field)` and `*(DISTINCT)`. After Phase 13, `MIN` / `MAX` work on any comparable scalar and empty aggregates return `null` (mapped to absent column). |
| `UNION` / `UNION ALL` | Same. `UNION` dedupes, `UNION ALL` keeps duplicates. Mixing the two in one statement is rejected (SQL allows it; we don't, for clarity). |
| `AS` aliases | `SELECT expr AS name`. Aliases usable in `ORDER BY` and `HAVING` (same as PostgreSQL; standard SQL technically only allows it in `ORDER BY`). |
| `INSERT` / `UPDATE` / `DELETE` keywords | Familiar. `UPDATE` requires `SET f = literal` and accepts an optional `WHERE`. `DELETE FROM x [WHERE …]` is identical to SQL. |

### Surface-level differences (intentional and small)

| Area | Standard SQL | Ours | Why |
|---|---|---|---|
| `INSERT` body | `INSERT INTO t (a, b) VALUES (1, 2)` | `INSERT INTO t VALUES {id: '…', a: 1, b: 2}` | Documents are objects, not tuples; field name is part of the value. The JSON-ish literal is unambiguous about which value belongs to which field, especially with a schemaless storage layer underneath. `id` must be present (it's the primary index). |
| Column list in `INSERT` | Required (or default order) | Not allowed — fields come from the object literal | Same reason. |
| Single quotes for strings | Yes | Yes — identical | `'…'` always. |
| Identifier quoting | `"…"` for identifiers | Not supported | Field/collection names follow a strict identifier regex. No reserved-word collision today. |
| Schemas / catalogs (`db.schema.table`) | Yes | Not supported | One database per `SimpleDbms` instance. |
| Statement terminator `;` | Required at end of statement, separator between multiple | Optional; one statement per call. The conversational engine strips a trailing `;` before parsing. | One-statement-per-call is simpler and matches the API shape (`query(sql)` returns one result set). |

### Real semantic / capability gaps

These are places where the same SQL keyword exists but our implementation is narrower than standard SQL. None are footguns now — anything unsupported throws at parse time with a descriptive error.

| Area | Standard SQL | Ours | Notes |
|---|---|---|---|
| Outer joins (`LEFT` / `RIGHT` / `FULL OUTER`) | Emit unmatched rows from one or both sides with `NULL` columns from the absent side | **Parse error** — explicit "not supported" | Phase 13 made this explicit. Adding them is a localised executor change. |
| `JOIN` without `ON` | In Postgres-flavoured SQL, `JOIN` requires `ON` / `USING` and is otherwise an error; `NATURAL JOIN` and `CROSS JOIN` are separate keywords. | Same — Phase 13 brought us into alignment. Before that we silently inferred. | After Phase 13, behaviour matches standard SQL: `JOIN x ON …` = INNER, `NATURAL JOIN x` matches on shared field names, `CROSS JOIN x` is Cartesian. Bare `JOIN x` is an error in both. |
| Table aliases | `FROM t AS a JOIN u AS b ON a.x = b.y` | Not supported | Column references use the *collection name* prefix (`cities.country`). Aliases would require an alias→collection rewriter in every clause; deferred. |
| Expressions in `SELECT` (arithmetic, function calls, `CASE`) | `SELECT salary * 1.05, UPPER(name), CASE WHEN x > 0 THEN 'pos' ELSE 'neg' END` | Not supported — `SELECT` takes field names, `*`, or aggregates only | Same root cause: no expression evaluator in the projector. Deferred. |
| Expressions in `WHERE` | `WHERE salary * 1.05 > 50000` | Not supported on left or right of comparison — both sides are a field or a literal | Same root cause. |
| Expressions in `UPDATE` RHS | `UPDATE t SET salary = salary * 1.05` | Not supported — RHS is a literal | Same root cause. |
| Scalar subqueries | `SELECT id, (SELECT MAX(y) FROM …) FROM x` | Not supported. We do support `WHERE x IN (SELECT …)` (row-set form). | Correlated scalar subqueries would need per-row execution; uncorrelated would need projection-time materialisation. Deferred. |
| `CASE WHEN ... THEN ... ELSE ... END` | Yes | Not supported | Requires expression language. |
| `COALESCE` / `NULLIF` / `IFNULL` | Yes | Not supported | Requires expression language. |
| `NULL` handling in comparisons | `x = NULL` is `UNKNOWN`, never true | `x = NULL` is rejected by the parser; use `IS NULL` | We require the SQL-correct idiom and don't silently match nothing. |
| `NULL` in `ORDER BY` | `NULLS FIRST` / `NULLS LAST` configurable | Not configurable — `null`/`undefined` sort first by code-point comparison | Deterministic but opinionated. |
| String comparison locale | Locale-aware (`COLLATE …`) | Unicode code-point order, locale-independent | Phase 10 chose determinism over linguistic correctness. |
| Index hints / query plans | `EXPLAIN`, `USE INDEX` | None — the planner is internal; you get id-equality, field-equality (via `cursorEqual`), or full scan with no way to override | Adequate for the catalog we have. |
| Multiple statements per call | `BEGIN; INSERT …; COMMIT;` | One statement per `execute()` call. `INSERT` / `UPDATE` / `DELETE` auto-commit. | No multi-statement transactions exposed. |
| Read-only chat surface | n/a | The conversational engine rejects `INSERT` / `UPDATE` / `DELETE` and accepts `SELECT` + `UNION` (Phase 13 fix) | Policy, not capability. |

### How option (b) compares to standard SQL JOIN syntax

The post-Phase 13 join grammar is what most SQL dialects (PostgreSQL, SQLite, MySQL in strict mode) require:

```sql
-- All three of these are valid in our language AND in standard SQL:
SELECT … FROM a JOIN b ON a.x = b.y
SELECT … FROM a INNER JOIN b ON a.x = b.y
SELECT … FROM a NATURAL JOIN b
SELECT … FROM a CROSS JOIN b
```

Three differences from full standard SQL remain after option (b):

1. **No outer joins** — `LEFT` / `RIGHT` / `FULL [OUTER] JOIN` are accepted by standard SQL and are *rejected with a clear error* by ours. PostgreSQL, MySQL, SQLite all support them. This is the largest remaining capability gap in the JOIN surface.
2. **No `USING (col, …)`** — standard SQL accepts `JOIN b USING (country_id)` as an alternative to `ON a.country_id = b.country_id`. Ours doesn't. (`NATURAL JOIN` covers the common case where all shared names should match.)
3. **No table aliases** — `FROM a JOIN b ON a.x = b.y` is OK; `FROM a AS aa JOIN b AS bb ON aa.x = bb.y` is not. Field qualifiers use the *collection name*, not an alias.

What option (b) eliminated, relative to the pre-Phase 13 state:

- The AST no longer lists capabilities (`LEFT`, `RIGHT`, `FULL`) that the engine doesn't implement.
- The runtime no longer silently picks NATURAL or full-Cartesian based on data shape. `NATURAL JOIN` and `CROSS JOIN` are now keywords; the parser sets the type and the runtime trusts it.
- A bare `JOIN x` with no `ON` is a parse error instead of an implicit Cartesian. Standard SQL also rejects it.

Net effect: the grammar is a strict subset of standard SQL (you can take any query our parser accepts and run it in PostgreSQL unchanged, modulo `INSERT` body shape and the absence of `;`), and every divergence is either a clearer error or an opinionated determinism choice.

---

## Verification at end of session

- **Type check**: `npx tsc --noEmit` passes.
- **Full test suite**: `npm test` → **524 / 524 passing**, 17 / 17 files. (`npm test` excludes the `benchmarking/**` perf suites, which can run for many minutes and are gated behind their own script.)
- **Query-language tests**: 142 / 142 passing in `querylanguage.spec.mts`.