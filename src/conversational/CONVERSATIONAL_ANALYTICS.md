# Conversational Analytics for SimpleDBMS

## Overview

This module adds **conversational analytics** to SimpleDBMS — a LookerML-inspired feature that lets users ask natural-language questions about their data and receive answers in the form of tables, charts, and plain-English summaries.

Instead of writing SQL-like queries by hand, a user can type *"What is the average salary by department?"* and the system will:

1. Translate the question into a valid query
2. Execute it against the database
3. Summarize the results in natural language
4. Automatically generate an appropriate chart

---

## Architecture

The system is organized into five layers, each with a clear responsibility:

```
┌──────────────────────────────────────────────────────┐
│                    Web UI (Frontend)                  │
│   Chat interface · Database browser · Model editor   │
├──────────────────────────────────────────────────────┤
│                 HTTP Server (server.mts)              │
│          REST API · Static file serving               │
├──────────────────────────────────────────────────────┤
│           Conversational Engine (Orchestrator)        │
│    Coordinates query generation → execution → summary │
├──────────────────────────────────────────────────────┤
│  Query Generator  │  LLM Provider  │  Semantic Model  │
│  NL → SQL-like    │  Gemini API    │  Schema + context │
├──────────────────────────────────────────────────────┤
│                  SimpleDBMS (Storage)                 │
│     B+ Tree indexes · Query Language · Documents     │
└──────────────────────────────────────────────────────┘
```

### Layer-by-layer explanation

#### 1. Semantic Model (`semanticModel.mts`)

This is the **knowledge layer** — inspired by LookerML's semantic modeling. It describes the database schema in terms the LLM can understand:

- **Explores** (collections): e.g., `employees`
- **Fields**: name, type, human-readable label, description, and **synonyms** (e.g., `salary` has synonyms `pay`, `wage`, `compensation`)
- **Measures**: pre-defined aggregations (e.g., `average_salary` = `AVG(salary)`, `headcount` = `COUNT(*)`)

The model can be:
- **Auto-generated** from the database schema via introspection (`generateSemanticModel`)
- **Manually edited** through the web UI's model editor tab
- **Loaded from disk** (`model.json`)

Auto-generation works by:
1. Calling `db.listCollections()` to discover all collections
2. Calling `db.describeCollection()` to get field names and types from the B+ tree metadata
3. Sampling a document to discover fields not in the index and to refine types (e.g., detecting booleans)
4. Generating measures for all numeric fields (AVG, SUM, MIN, MAX) plus a COUNT(*)

The model is then serialized into a prompt string that becomes part of the LLM's system instructions.

#### 2. LLM Provider (`llmProvider.mts`)

An abstraction layer over the LLM API:

- **Interface** `LLMProvider` with two methods:
  - `generate(systemPrompt, userMessage)` — single-turn, used for one-off tasks
  - `chat(systemPrompt, history, userMessage)` — multi-turn, passes conversation context
- **Implementation** `GeminiProvider` — uses Google's Gemini API (`@google/genai` package)

The provider is decoupled from the engine, so swapping to a different LLM (OpenAI, Anthropic, local model) only requires a new class implementing the interface.

#### 3. Query Generator (`queryGenerator.mts`)

Translates natural language into executable queries:

1. Builds a **system prompt** containing the semantic model (schema, fields, synonyms, measures) and the supported query syntax
2. Sends the user's question to the LLM along with **conversation history** for context
3. Extracts the generated query (stripping markdown fences, semicolons, etc.)
4. **Parses** the query using the existing `QueryLanguage` parser to validate it
5. If parsing fails, **retries once** — sends the error message back to the LLM so it can self-correct

The conversation history enables follow-up questions like *"break that down by gender"* — the LLM sees what query was previously generated and understands the reference.

#### 4. Conversational Engine (`conversationalEngine.mts`)

The **orchestrator** that ties everything together:

```
User question
    │
    ├──→ QueryGenerator.generate(question, history)
    │       └──→ LLM produces SQL-like query
    │
    ├──→ QueryLanguage.execute(query)
    │       └──→ Runs against SimpleDBMS, returns rows
    │
    └──→ LLM.chat(summaryPrompt, history, resultsContext)
            └──→ Returns JSON: { summary, chart }
```

Key features:

- **Conversation memory**: Maintains a rolling window of the last 20 messages. The frontend sends its history with each request, and the engine passes it to both the query generator and the summary step.
- **Structured insight response**: Instead of two separate LLM calls (one for summary, one for chart), we make a **single call** that returns a JSON object with both:
  ```json
  {
    "summary": "Engineering has the highest average salary at €82,222...",
    "chart": {
      "type": "bar",
      "title": "Average Salary by Department",
      "xColumn": "department",
      "yColumns": ["AVG(salary)"]
    }
  }
  ```
- **Chart specification**: The LLM decides the chart type (bar, line, pie, doughnut, or none), which columns map to axes, and a title. This is more accurate than frontend heuristics because the LLM understands the user's *intent*.
- **Series/grouping support**: When a query groups by two categorical columns (e.g. seniority AND gender), the LLM sets a `seriesColumn` in the chart spec. The frontend then pivots the flat rows into a grouped chart — one dataset per series value (e.g. one set of bars for M, another for F), with the primary grouping on the x-axis and a legend distinguishing the series.

#### 5. Web Server (`server.mts`)

A Node.js HTTP server using **only built-in modules** (no Express) to avoid CJS/ESM interop issues:

**REST API endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/collections` | List all collections |
| GET | `/api/collections/:name` | Get all documents in a collection |
| POST | `/api/collections/:name` | Insert a document |
| PUT | `/api/collections/:name` | Update a document |
| DELETE | `/api/collections/:name?id=...` | Delete a document |
| POST | `/api/query` | Execute a raw query |
| POST | `/api/ask` | Ask a natural-language question (with optional history) |
| GET | `/api/model` | Get the current semantic model |
| PUT | `/api/model` | Save an edited semantic model |
| POST | `/api/model/generate` | Re-generate the semantic model from the DB |
| GET | `/api/schema` | Get raw schema info for all collections |

On startup, the server:
1. Opens (or creates and seeds) the database with 200 employee records
2. Loads (or auto-generates) the semantic model
3. Builds the conversational engine
4. Starts listening on port 3000

#### 6. Web Frontend (`public/index.html`)

A single-page application with four tabs:

1. **Database Browser** — View collections, browse documents in a table, inline-edit fields, add/delete documents
2. **Chat** — The main conversational interface. Type a question, see the generated query, result table, chart, and summary. Supports follow-up questions with context.
3. **Semantic Model** — JSON editor for the semantic model. Edit field descriptions, synonyms, measures, then save. Can also re-generate from the database.
4. **Query Editor** — Execute raw SQL-like queries directly and see results.

**Chart rendering** uses Chart.js v4 with:
- LLM-decided chart types and axis mappings
- Fallback heuristic detection when the LLM doesn't suggest a chart
- Styled tooltips, legends, grid lines, and rounded bar corners
- Responsive sizing within the chat bubble

**Conversation persistence** uses `sessionStorage` so the chat history survives page refreshes but clears when the browser tab is closed. A "New Chat" button manually resets the conversation.

---

## Data Flow — End to End

Here's what happens when a user asks *"What is the average salary by department?"*:

```
1. Frontend sends POST /api/ask:
   { question: "What is the average salary by department?", history: [...] }

2. ConversationalEngine.ask() is called:
   a. QueryGenerator receives the question + conversation history
   b. LLM system prompt includes the semantic model:
      - "employees" collection with fields: id, name, gender, department,
        seniority, salary (synonyms: pay, wage, compensation), age, city, yearsAtCompany
      - Measures: AVG(salary), SUM(salary), COUNT(*), etc.
   c. LLM generates: "SELECT department, AVG(salary) FROM employees GROUP BY department"
   d. Query is parsed and validated by QueryLanguage.parse()

3. QueryLanguage.execute() runs the query against SimpleDBMS:
   - Scans the employees collection
   - Groups by department
   - Computes AVG(salary) per group
   - Returns 8 rows

4. ConversationalEngine calls LLM again for insight:
   - Sends the question, query, and result data
   - Asks for a JSON response with summary + chart spec
   - LLM returns:
     { summary: "Finance has the highest average salary at €83,825...",
       chart: { type: "bar", title: "Average Salary by Department",
                xColumn: "department", yColumns: ["AVG(salary)"] } }

5. Server returns the full response to the frontend

6. Frontend renders:
   - The SQL query in a code block
   - A data table with the 8 rows
   - A bar chart with departments on x-axis, avg salary on y-axis
   - The summary text below
```

---

## Continuous Chat

The system supports **multi-turn conversations** where follow-up questions reference previous context:

- **"What is the average salary?"** → generates `SELECT AVG(salary) FROM employees`
- **"Break that down by department"** → generates `SELECT department, AVG(salary) FROM employees GROUP BY department`
- **"Now also by gender"** → generates `SELECT department, gender, AVG(salary) FROM employees GROUP BY department, gender`

This works because:
1. The frontend maintains a `conversationHistory` array of `{role, text}` messages
2. Each API call includes this history
3. The LLM receives the full conversation context, so it understands what "that" or "same but" refers to
4. History is capped at 20 messages to stay within context window limits

---

## Semantic Model — The LookerML Analogy

The semantic model serves the same purpose as LookerML's `.lkml` files — it's a **translation layer** between human concepts and database schema:

| LookerML Concept | Our Equivalent | Purpose |
|-------------------|----------------|---------|
| Explore | `explores[].collection` | Maps to a database collection |
| Dimension | `explores[].fields[]` | A field with type, label, description |
| Measure | `explores[].measures[]` | Pre-defined aggregation (AVG, SUM, COUNT...) |
| Label | `fields[].label` | Human-readable name for display |
| Description | `fields[].description` | Helps the LLM understand what the field means |
| - | `fields[].synonyms` | Alternative words that map to this field |

Example: when a user says *"what's the average pay?"*, the LLM sees that `salary` has synonym `pay` and uses `AVG(salary)`.

---

## Seed Data

The `seedData.mts` module generates 200 deterministic employees using a seeded PRNG with:

| Field | Type | Values |
|-------|------|--------|
| `id` | string | `emp001` through `emp200` |
| `name` | string | Realistic Belgian first + last names |
| `gender` | string | `M` or `F` (~48/52 split) |
| `department` | string | Engineering, Marketing, Sales, HR, Finance, Operations, Support, Legal |
| `seniority` | string | Junior, Mid, Senior, Lead, Principal |
| `salary` | number | €37,500 – €130,000 (based on department + seniority + jitter) |
| `age` | number | 22–62 (correlated with seniority) |
| `city` | string | 8 Belgian cities |
| `yearsAtCompany` | number | 0–25 (correlated with age) |

Salary is calculated as: `baseSalary[department] × seniorityMultiplier × randomJitter`, rounded to nearest €500.

---

## Running the System

```bash
# Install dependencies
npm install

# Start the web server (seeds database on first run)
npm run converse:web

# Or use the CLI REPL instead
npm run converse:seed
```

The web UI is available at `http://localhost:3000`.

Requires a `GEMINI_API_KEY` in a `.env` file at the project root.

---

## File Structure

```
src/conversational/
├── CONVERSATIONAL_ANALYTICS.md   ← This file
├── conversationalEngine.mts      ← Orchestrator (query → execute → summarize)
├── llmProvider.mts               ← LLM abstraction (Gemini implementation)
├── queryGenerator.mts            ← NL → SQL-like query translation
├── semanticModel.mts             ← Model types, loader, auto-generator
├── seedData.mts                  ← Deterministic employee data generator
├── seed.mts                      ← CLI: seed DB + launch REPL
├── server.mts                    ← HTTP server + REST API
├── cli.mts                       ← Standalone CLI REPL
├── example-model.json            ← Example semantic model
└── public/
    └── index.html                ← Single-page web application
```

---

## Technology Choices

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| LLM | Google Gemini 2.5 Flash | Fast, good at structured output, generous free tier |
| Backend | Node.js built-in HTTP | Avoids CJS/ESM interop issues with Express |
| Frontend | Vanilla JS + Chart.js | No build step, single HTML file, easy to deploy |
| Charts | Chart.js v4 | Mature, well-documented, supports bar/line/pie/doughnut |
| Database | SimpleDBMS | The project's own DBMS with B+ tree indexes and SQL-like query language |
| API format | JSON REST | Simple, standard, no extra dependencies |

---

## Key Design Decisions

1. **Single LLM call for summary + chart**: Instead of two calls (one for text, one for visualization), we ask Gemini to return a structured JSON with both. This halves latency and reduces API costs.

2. **Frontend-side conversation history**: The server is stateless — the frontend sends the full conversation history with each request. This means multiple browser tabs have independent conversations and the server doesn't need session management.

3. **Semantic model as a prompt**: Rather than a complex query-building pipeline, we serialize the entire semantic model into the LLM's system prompt. This is simple, flexible, and lets the LLM use field descriptions and synonyms naturally.

4. **Auto-generation with manual override**: The semantic model is auto-generated from the database schema for convenience, but can be manually enriched with descriptions, synonyms, and custom measures through the web UI editor.

5. **Query validation with retry**: If the LLM generates an invalid query, the parser error is fed back to the LLM for a second attempt. This self-correction handles most syntax issues without user intervention.
