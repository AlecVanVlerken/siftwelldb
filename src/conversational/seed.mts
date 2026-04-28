#!/usr/bin/env node
/**
 * Seeds a test database with employee data, auto-generates a semantic model
 * from the DB schema, and launches the conversational analytics CLI.
 *
 * Usage:
 *   npx tsx src/conversational/seed.mts
 *
 * Requires GEMINI_API_KEY in .env or environment.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RealFile } from '../core/file.mjs';
import { SimpleDbms } from '../dbms/simpledbms.mjs';
import { generateSemanticModel } from './semanticModel.mjs';
import { GeminiProvider } from './llmProvider.mjs';
import { ConversationalEngine } from './conversationalEngine.mjs';
import { generateEmployees } from './seedData.mjs';
import readline from 'node:readline';

const R = '\x1b[0m';
const B = '\x1b[1m';
const DIM = '\x1b[2m';
const C = '\x1b[36m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const RED = '\x1b[31m';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, '../../converse-db');
const DATA_PATH = path.join(DB_DIR, 'employees.data');
const LOG_PATH = path.join(DB_DIR, 'employees.log');
const MODEL_PATH = path.join(DB_DIR, 'model.json');

function loadEnv() {
  const envPath = path.join(__dirname, '../../.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

async function main() {
  loadEnv();

  const apiKey = process.env['GEMINI_API_KEY'] ?? '';
  if (!apiKey) {
    console.error(`${RED}Error: Set GEMINI_API_KEY in .env or environment.${R}`);
    process.exit(1);
  }

  console.log(`\n${B}${C}${'─'.repeat(60)}${R}`);
  console.log(`${B}${C}  Conversational Analytics — Setup & Demo${R}`);
  console.log(`${B}${C}${'─'.repeat(60)}${R}\n`);

  // ── Step 1: Seed the database ──────────────────────────────────────────────
  fs.mkdirSync(DB_DIR, { recursive: true });
  const needsSeed = !fs.existsSync(DATA_PATH);

  let db: SimpleDbms;
  if (needsSeed) {
    const employees = generateEmployees(200);
    console.log(`  ${DIM}Creating database with ${employees.length} employees...${R}`);
    db = await SimpleDbms.create(new RealFile(DATA_PATH), new RealFile(LOG_PATH));
    for (const emp of employees) {
      await db.insertDocument('employees', JSON.stringify(emp));
    }
    await db.commit();
    console.log(`  ${G}✓${R} Inserted ${employees.length} employees`);
  } else {
    console.log(`  ${DIM}Opening existing database...${R}`);
    if (!fs.existsSync(LOG_PATH)) fs.closeSync(fs.openSync(LOG_PATH, 'w'));
    db = await SimpleDbms.open(new RealFile(DATA_PATH), new RealFile(LOG_PATH));
    console.log(`  ${G}✓${R} Database opened`);
  }

  // ── Step 2: Auto-generate the semantic model ──────────────────────────────
  console.log(`  ${DIM}Auto-generating semantic model from DB schema...${R}`);
  const model = await generateSemanticModel(db);

  // Enrich with descriptions and synonyms for better LLM understanding
  const empExplore = model.explores.find((e) => e.collection === 'employees');
  if (empExplore) {
    empExplore.description = 'Employee records including salary, department, seniority, gender, and location data';
    const enrichments: Record<string, { description?: string; synonyms?: string[] }> = {
      salary: { description: 'Gross annual salary in EUR', synonyms: ['pay', 'wage', 'compensation', 'income', 'earnings'] },
      department: { description: 'Department the employee belongs to', synonyms: ['dept', 'team', 'division'] },
      name: { description: "Employee's full name", synonyms: ['employee', 'person', 'worker'] },
      city: { description: 'City where the employee is based', synonyms: ['location', 'office'] },
      age: { description: "Employee's age in years" },
      gender: { description: "Employee's gender (M or F)", synonyms: ['sex'] },
      seniority: { description: 'Seniority level: Junior, Mid, Senior, Lead, or Principal', synonyms: ['level', 'rank', 'experience'] },
      yearsAtCompany: { description: 'Number of years employed at the company', synonyms: ['tenure', 'experience', 'years employed'] },
    };
    for (const f of empExplore.fields) {
      const e = enrichments[f.name];
      if (e) {
        if (e.description) f.description = e.description;
        if (e.synonyms) f.synonyms = e.synonyms;
      }
    }
  }

  fs.writeFileSync(MODEL_PATH, JSON.stringify(model, null, 2));
  console.log(`  ${G}✓${R} Semantic model saved to ${path.relative(process.cwd(), MODEL_PATH)}`);
  console.log(`  ${DIM}  Collections: ${model.explores.map((e) => e.collection).join(', ')}${R}`);
  for (const explore of model.explores) {
    console.log(`  ${DIM}  ${explore.collection}: ${explore.fields.map((f) => f.name).join(', ')}${R}`);
  }

  // ── Step 3: Launch conversational REPL ─────────────────────────────────────
  const llmProvider = new GeminiProvider(apiKey);
  const engine = new ConversationalEngine({
    dbms: db,
    llmProvider,
    semanticModel: model,
  });

  console.log(`\n  ${G}✓${R} Gemini connected`);
  console.log(`\n  ${DIM}Ask any question about the employee data. Type ${B}exit${R}${DIM} to quit.${R}`);
  console.log(`  ${DIM}Examples:${R}`);
  console.log(`    ${Y}• What is the average salary?${R}`);
  console.log(`    ${Y}• Which department has the most employees?${R}`);
  console.log(`    ${Y}• Who earns the most in Engineering?${R}`);
  console.log(`    ${Y}• Show me all employees in Leuven${R}`);
  console.log(`    ${Y}• What is the total salary cost per department?${R}`);
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on('close', () => { closed = true; });

  const ask = () => {
    if (closed) return;
    rl.question(`${B}${C}ask ›${R} `, (raw) => {
      void handleInput(raw);
    });
  };

  const handleInput = async (raw: string) => {
    const input = raw.trim();
    if (!input) { ask(); return; }
    if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      await db.close();
      console.log(`\n  ${DIM}Goodbye!${R}\n`);
      rl.close();
      return;
    }

    process.stdout.write(`  ${DIM}thinking...${R}`);
    const response = await engine.ask(input);
    process.stdout.write('\r                  \r');

    if (response.error) {
      console.log(`  ${RED}Error: ${response.error}${R}`);
      if (response.query) console.log(`  ${DIM}Query: ${response.query}${R}`);
    } else {
      console.log(`  ${DIM}Query: ${response.query}${R}\n`);

      if (response.data.length > 0) {
        const preview = response.data.slice(0, 15);
        const columns = Object.keys(preview[0]);
        const colWidths = columns.map((col) =>
          Math.max(col.length, ...preview.map((row) => String(row[col] ?? '').length)),
        );

        const header = columns.map((col, i) => col.padEnd(colWidths[i])).join('  ');
        const separator = colWidths.map((w) => '─'.repeat(w)).join('──');

        console.log(`  ${B}${header}${R}`);
        console.log(`  ${DIM}${separator}${R}`);
        for (const row of preview) {
          const line = columns.map((col, i) => String(row[col] ?? '').padEnd(colWidths[i])).join('  ');
          console.log(`  ${line}`);
        }
        if (response.data.length > 15) {
          console.log(`  ${DIM}... and ${response.data.length - 15} more rows${R}`);
        }
      }

      if (response.summary) {
        console.log(`\n  ${Y}${response.summary}${R}`);
      }
    }
    console.log();
    ask();
  };

  ask();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
