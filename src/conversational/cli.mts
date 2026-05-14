#!/usr/bin/env node
// author: Conversational Analytics Module

import fs from 'node:fs';
import readline from 'node:readline';
import { RealFile } from '../core/file.mjs';
import { SimpleDbms } from '../dbms/simpledbms.mjs';
import { GeminiProvider } from './llmProvider.mjs';
import { loadSemanticModel } from './semanticModel.mjs';
import { ConversationalEngine } from './conversationalEngine.mjs';

const R = '\x1b[0m';
const B = '\x1b[1m';
const DIM = '\x1b[2m';
const C = '\x1b[36m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const RED = '\x1b[31m';

function parseArgs(argv: string[]) {
  const args = { data: '', log: '', model: '', apiKey: '' };
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--data' && argv[i + 1]) args.data = argv[++i];
    else if (token === '--log' && argv[i + 1]) args.log = argv[++i];
    else if (token === '--model' && argv[i + 1]) args.model = argv[++i];
    else if (token === '--api-key' && argv[i + 1]) args.apiKey = argv[++i];
    else if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (!args.data || !args.model) {
    printHelp();
    process.exit(1);
  }

  if (!args.log) args.log = args.data.replace(/\.data$/, '') + '.log';
  if (!args.apiKey) args.apiKey = process.env['GEMINI_API_KEY'] ?? '';

  if (!args.apiKey) {
    console.error(`${RED}Error: Gemini API key required. Use --api-key or set GEMINI_API_KEY env var.${R}`);
    process.exit(1);
  }

  return args;
}

function printHelp() {
  console.log(`${B}Conversational Analytics CLI${R}

${B}Usage:${R}
  npx tsx src/conversational/cli.mts --data <db-file> --model <model.json> [options]

${B}Required:${R}
  --data <path>       Path to the database data file
  --model <path>      Path to the semantic model JSON config

${B}Options:${R}
  --log <path>        Path to the WAL log file (default: <data>.log)
  --api-key <key>     Gemini API key (or set GEMINI_API_KEY env var)
  -h, --help          Show this help

${B}Commands during chat:${R}
  Type any question in natural language
  exit / quit         Close and exit`);
}

async function main() {
  const args = parseArgs(process.argv);

  console.log(`\n${B}${C}${'─'.repeat(60)}${R}`);
  console.log(`${B}${C}  Conversational Analytics${R}`);
  console.log(`${B}${C}${'─'.repeat(60)}${R}\n`);

  // Load semantic model
  console.log(`  ${DIM}Loading semantic model from ${args.model}...${R}`);
  const semanticModel = loadSemanticModel(args.model);
  console.log(`  ${G}✓${R} Loaded ${semanticModel.explores.length} explore(s)`);

  // Open database
  console.log(`  ${DIM}Opening database ${args.data}...${R}`);
  const dataFileExists = fs.existsSync(args.data);
  let db: SimpleDbms;
  if (!dataFileExists) {
    if (!fs.existsSync(args.log)) fs.closeSync(fs.openSync(args.log, 'w'));
    db = await SimpleDbms.create(new RealFile(args.data), new RealFile(args.log));
    await db.commit();
  } else {
    if (!fs.existsSync(args.log)) fs.closeSync(fs.openSync(args.log, 'w'));
    db = await SimpleDbms.open(new RealFile(args.data), new RealFile(args.log));
  }
  console.log(`  ${G}✓${R} Database ready`);

  // Create engine
  const llmProvider = new GeminiProvider(args.apiKey);
  const engine = new ConversationalEngine({
    dbms: db,
    llmProvider,
    semanticModel,
  });

  console.log(`  ${G}✓${R} Gemini connected\n`);
  console.log(`  ${DIM}Ask any question about your data. Type ${B}exit${R}${DIM} to quit.${R}\n`);

  // Interactive REPL
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });

  const ask = () => {
    if (closed) return;
    rl.question(`${B}${C}ask ›${R} `, (raw) => {
      void handleInput(raw);
    });
  };

  const handleInput = async (raw: string) => {
    const input = raw.trim();
    if (!input) {
      ask();
      return;
    }

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
      if (response.query) {
        console.log(`  ${DIM}Generated query: ${response.query}${R}`);
      }
    } else {
      console.log(`  ${DIM}Query: ${response.query}${R}`);
      console.log();

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
