# Code Review — team-03 SimpleDBMS

---

## 1. Project Structure — Needs Work

The layering within `src/` is logical: `atomic/` → `freeblockfile/` → `btree/` / `hnsw/` → `dbms/` → `webclient/`. The dependency graph flows cleanly in one direction at the storage layer.

**Issues:**

- **No top-level `README.md`** — the only entry point for orientation is `implementation_plan.md`, which is a planning document, not documentation. There is no record of prerequisites, setup steps, how to run either server, or what the project is.
- **`atomicfile_old.mts`** is 217 lines of dead code committed directly beside the live implementation with no explanation of why it exists.
- **Binary files committed**: `src/hnsw/hnsw_native.dll` and `src/hnsw/libhnsw_native.so` are in version control. Compiled artifacts belong in `.gitignore` with a documented build step.
- **Noise at the repo root**: `map.html`, `rabbit.jpg`, `implementation_plan.md`, and `PERFORMANCE_REVIEW.txt` are committed there. None of them belong at root.
- **`src/trivialdbms.mts` and `src/trivialdbms.test.mts`** are dangling at the `src/` root level instead of living under `src/dbms/` with everything else.
- **Mixed `.ts` / `.mts` in `webclient/`**: `api.ts`, `app.ts`, `doc-view.ts`, `state.ts`, `table.ts`, `utils.ts` use `.ts` while the server files use `.mts`. With `"module": "NodeNext"` this causes resolution inconsistencies.
- **Benchmarking** mixes Python plotting scripts and TypeScript benchmark specs in the same directory with no separation.

---

## 2. Architecture & Design — Needs Work

The storage stack is the highlight: `File → AtomicFile (WAL) → FreeBlockFile → RecordStore → DbmsBack → SimpleDbms`. This is clean and the WAL protocol is well-thought-out.

**Issues:**

- **`DbmsBack` is a god class.** At 1053 lines it simultaneously manages B+ tree caching, HNSW index lifecycle, meta block serialization, compression configuration, and WAL interaction. It should be split: a `MetaManager`, an `HnswManager`, and the core CRUD logic could each be their own class.

- **`metaReadJSON` / `metaWriteJSON` are ad-hoc block managers inside a class that already delegates storage to `FreeBlockFile`.** The implementation manually allocates/frees blocks, parses JSON twice, and accesses `freeblockFile._getBlockSize()` — a friend-style backdoor using the underscore convention. This bypasses the abstraction it sits on top of.

- **`deleteCollection` permanently leaks storage.** When a collection is deleted, all B+ tree nodes, HNSW graph data, vector data, and record store blocks are orphaned. The comment acknowledges this ("collectible if a compactor is ever added") but there is no compactor and no plan for one. Every deleted collection leaves unreclaimable disk space.

- **`ConversationalEngine` reimplements the query engine.** `applyGroupBy`, `computeAgg`, `applyProjection`, `applyOrderBy`, and `evalWhere` in `conversationalEngine.mts` are manual reimplementations of the corresponding logic in `querylanguage.mts`. The duplication is ~200 lines and the two implementations diverge in subtle ways (e.g., `applyGroupBy` uses `\x00` as separator; `executeGroupBy` in QL uses `|`). The root cause is that `ParsedSelect` is private to `querylanguage.mts` — exporting it would let the engine reuse it.

- **`getDocument(encoded = false)` changes return type at runtime.** The signature returns `Promise<Document | EncodedDocument>` and the caller must cast. This bypasses TypeScript's type system.

- **The "vorm" type system** is an informal string-tag encoding (`'N'`, `'S'`, `'NN'`, `'SN'`, etc.) that drives the key comparison and serialization logic. It is completely undiscoverable without reading the code, has no type alias, and is scattered across `dbmsback.mts` with Dutch variable names (`vorm = 'N'`). A union type and a proper dispatch table would make this maintainable.

---

## 3. Code Quality — Needs Work

- **Dutch comments mixed with English** throughout `dbmsback.mts` and `querylanguage.mts`. Examples: `"maak nieuwe B+ tree voor id aan"`, `"voeg document-pointer toe aan id B+ tree"`, `"Stap 1: Groepeer rijen"`, `"Bereken aggregaten per groep"`. The codebase should pick one language.

- **`getCompareFunction` and `toBuffer`** at the bottom of `dbmsback.mts` are 180 lines of if-else chains on a string tag. A `Record<string, ...>` dispatch object would be far more readable and would eliminate the need for a `throw` at the end.

- **`Document.getFields()`** allocates a new `Object.fromEntries([...iterableEntries, ...nonIterableEntries])` on every call. It is called in tight loops (inside `insertDocument`, cursor iteration, `extractText`, `extractImageData`, etc.).

- **The SELECT regex in `querylanguage.mts` line 156** is one expression spanning the entire clause chain. It will silently fail to capture parts of complex queries and is impossible to debug or extend. A token-stream parser would be ~50 lines more code and eliminate the entire class of edge-case misparses.

- **`// constant time` comments** appear 10+ times in `insertDocument` on lines like `const collectionName = document.getCollectionName(); //constant time`. These describe what the compiler can infer and add no information.

- **Author credits** (`@author` headers, `// author:` lines) are inconsistent in format and, in `hnswGraphStorage.mts`, include `// @author: Thomas Dumon with usage of Claude sonnet 4.6`.

- **`eslint-disable-next-line @typescript-eslint/require-await`** on `deleteCollection` signals that the async signature is a lie — the method does no I/O. The contract is also inconsistent: `SimpleDbms.deleteCollection` commits, `DbmsBack.deleteCollection` does not, and neither frees any blocks.

---

## 4. Error Handling — Needs Work

- **`recover()` silently drops corrupted WAL** with an empty `catch {}`. No logging, no metric, no way to know a crash-recovery was attempted and discarded. This is an intentional design decision but it should at minimum log a warning.

- **`atomicWrite` returns `boolean` on failure.** `commit.mts` checks it and throws, which is correct. But the pattern invites future callers to ignore the return value silently. Throwing directly in `atomicWrite` is more defensive.

- **Empty catch blocks in `ConversationalEngine`**: `generateInsight` and `generateDidYouMean` fall back silently with no logging. If the LLM API is failing, there is no signal in any log.

- **`evalDerivedExpr`** returns `''` on any exception with an empty `catch {}`. Expression evaluation errors are invisible.

- **`api.mts` (webclient)** exposes `String(error)` directly in 500 responses, which may include stack traces or internal paths.

- **No request body size limit** in either HTTP server (`readBody` in `server.mts`, `parseBody` in `api.mts`). A large POST body will buffer entirely in memory before being rejected.

---

## 5. Testing — Needs Work

The core storage stack is well tested. `simpledbms.spec.mts` at 1822 lines is thorough, `atomicfile.spec.mts` properly exercises crash recovery and multi-block WAL, and `hnsw.spec.mts` is comprehensive.

**Gaps:**

- **`src/conversational/` has zero tests.** The LLM query generation pipeline, the semantic model builder, the derived-field evaluator, and the REST server are entirely untested. This is the most recently added code and the highest-risk code (external API calls, `new Function()` eval, JSON parsing from LLM responses).

- **`src/webclient/` has zero tests.** The HTTP API router has non-trivial routing logic and no test.

- **Benchmarking specs are excluded from CI** (`--exclude '**/benchmarking/**'`). If a benchmark spec contains a correctness assertion, it silently passes CI without being run.

- **The `trivialdbms.test` npm script** runs `src/trivialdbms.test.mts` directly via `tsx` outside of Vitest. It uses `VITEST` env checks to branch behaviour. This is two parallel testing systems for one file.

- **`querylanguage.spec.mts`** doesn't test JOIN behaviour, NATURAL JOIN, malformed queries, or numeric-only IDs in DELETE.

---

## 6. Documentation & Comments — Needs Work

`simpledbms.mts` has excellent JSDoc with multi-scenario usage examples and an HTML table. `dbmsback.mts` and `freeblockfile/README.md` are solid.

**Issues:**

- No `README.md` at the repo root. A new developer has no starting point.
- No `.env.example`. The project requires `GEMINI_API_KEY` but there is no template.
- Dutch comments throughout (see §3).
- `atomicfile_old.mts` is 217 lines of dead code with no explanation (historical artifact? reference for diff?).
- The `// constant time` narration comments in `insertDocument` describe semantics that should be obvious and add noise.

---

## 7. Security — Poor

- **RCE via unauthenticated `PUT /api/model` + `evalDerivedExpr`.** The conversational server exposes `PUT /api/model`, which accepts a JSON body containing a `SemanticModel`. That model can contain `derivedFields` with arbitrary JavaScript expression strings. `ConversationalEngine.executeWithDerived` evaluates them via `new Function(...)`. There is **no authentication on any endpoint**. Anyone who can reach port 3000 can write a model with `"salary": "process.exit(1)"` or worse. The comment "Expressions come from the server-side model JSON — not from user input" is technically true after the model is saved, but the model is saved from user input with no sanitisation.

- **No authentication or authorisation on any endpoint** — either server (port 8000 or 3000). Every operation (read, write, delete, reset, model update) is open.

- **Error details leaked in 500 responses.** `sendError(res, 500, \`Internal server error: ${String(error)}\`)` in `api.mts` may expose file paths, stack traces, or internal state.

- **No request body size limit.** Both servers buffer the entire request body in memory before validation.

- **The `.env` file is gitignored** — correct — but rotate `GEMINI_API_KEY` if it has been exposed in any shared context.

---

## 8. Performance — Needs Work

- **JOIN loads both collections fully into memory** (`loadCollection` does a full cursor scan). For large collections this is unbounded memory usage and O(n·m) for cartesian joins.

- **`DELETE FROM collection WHERE ...`** scans the whole collection, collects all matching IDs into an array, then deletes them in a second pass. This is neither atomic nor indexed.

- **`executeWithDerived`** always fetches all rows with `SELECT * FROM collection` before applying derived field filtering — even if the WHERE clause could narrow things significantly with an index.

- **`Document.getFields()`** creates a new `Object.fromEntries` allocation on every call in write-path loops.

- **`metaWriteJSON`** calls `getClientArea()` to read current block IDs, parses them, and rewrites on every `commit()`. For a database with many collections this scales poorly.

- **HNSW indices for all collections are eagerly reopened** at `DbmsBack.open()` time. For a database with many collections, startup will be slow even if only one collection is accessed.

---

## 9. Dependencies — Needs Work

- **`@google/genai` is installed in `node_modules/` but absent from `package.json`** (neither `dependencies` nor `devDependencies`). `npm ci` — used in CI — will **not** install it. The conversational module will fail to build in CI. Fix: run `npm install @google/genai` and commit the updated `package.json` and `package-lock.json`.

- `@huggingface/transformers`, `koffi`, and the Rust `hnsw-native` crate are all justified.

- **`@napi-rs/cli` is a devDependency** used to build the native HNSW binding — fine in principle, but the compiled `.dll` and `.so` are also committed, making the build step optional and allowing the committed binaries and the Rust source to diverge silently.

---

## 10. Developer Experience — Needs Work

- **No README.** Cannot onboard without reverse-engineering the codebase.
- **No `.env.example`.** The `GEMINI_API_KEY` requirement is invisible to a new developer.
- **Hardcoded port 8000** in `daemon.mts` with no CLI flag or env variable override (unlike the conversational server which accepts `--port`).
- **`@google/genai` missing from `package.json`** breaks `npm ci` in CI.
- **Binary files committed** to the repo bloat clone size and break reproducibility.
- **CI stages are strictly sequential** (build → test → coverage → lint → prettier). Coverage reruns the full test suite instead of reusing results. Lint and prettier checks could run in parallel with tests.
- **`trivialdbms.test` npm script** runs outside Vitest, is not included in `npm test`, and is not in CI. It is an orphaned script.
- **`atomicfile_old.mts`** left in the repo will confuse any new contributor.

---

## Top 5 Things to Fix First

### 1. `@google/genai` missing from `package.json` — Breaks CI

The conversational module imports `@google/genai` but it is not listed in `package.json`. `npm ci` in CI does not install unlisted packages. The entire conversational feature — all newly added files — is effectively dead in the CI pipeline right now.

**Fix:** `npm install @google/genai`, commit the updated `package.json` and `package-lock.json`.

---

### 2. RCE via unauthenticated model endpoint + `new Function()` — Security critical

`PUT /api/model` is unauthenticated and accepts derived-field expressions that are executed via `new Function()` on every query involving derived fields. If this server is reachable from any network outside `localhost`, this is remote code execution.

**Fix (in priority order):**
1. Add middleware that rejects all mutation requests without a shared secret or session token.
2. Remove `new Function()` and replace derived field evaluation with a safe expression grammar (e.g. a restricted arithmetic evaluator or a field-path mapper).
3. Validate model JSON strictly before saving to disk.

---

### 3. `deleteCollection` permanently leaks all storage blocks — Correctness

Deleting a collection orphans every B+ tree node, HNSW node, vector page, and record store block it used. The blocks are never returned to the free list. A database that creates and deletes collections will grow indefinitely on disk with no way to reclaim space.

**Fix:** Implement recursive tree-freeing (`freeTree` that walks internal nodes → leaf nodes → frees each block) and a `freeHnswIndex` path. Call both from `deleteCollection` before removing the metadata entry.

---

### 4. Extract `MetaManager` from `DbmsBack` — Maintainability

`metaReadJSON` / `metaWriteJSON` are 80+ lines of raw block management inside a class that already has five other concerns. The `_getBlockSize()` backdoor and the manual two-level JSON-inside-blocks scheme are fragile and bypass the abstraction.

**Fix:** Extract a `MetaManager` class that owns block allocation for the metadata, exposes a clean `read(): MetaCache` / `write(MetaCache): Promise<void>` API, and hides the block-management internals. This also removes the `_getBlockSize()` accessor leak.

---

### 5. Add `README.md` and `.env.example` — Developer experience

There is no way to set up or run this project without reverse-engineering it from source.

**Fix — minimum viable `README.md`:**
- What the project is
- Prerequisites: Node 24, optional Rust toolchain for native HNSW, Gemini API key for conversational analytics
- `npm install && npm run build && npm test`
- How to start each server: `src/webclient/daemon.mts` on port 8000 and `src/conversational/server.mts` on port 3000
- Pointer to `.env.example`

**Fix — `.env.example`:**
```
GEMINI_API_KEY=your_key_here
```
