/**
 * Interactive Semantic Search Demo — SimpleDbms
 *
 * Builds a real on-disk database, shows all stored documents, then enters an
 * interactive query loop so you can type any natural-language query live.
 *
 * Run with:
 *   npm run demo
 *
 * Commands at the prompt:
 *   <query text>   — semantic search (returns top 4 results)
 *   1-6            — use a numbered suggestion
 *   rebuild        — wipe the database and exit (next run rebuilds)
 *   exit / quit    — close and exit
 */

import { pipeline } from '@huggingface/transformers';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { RealFile } from '../src/storage/file.mjs';
import { SimpleDbms, type HnswConfig } from '../src/database/simpledbms.mjs';

// ── ANSI colours ──────────────────────────────────────────────────────────────

const R = '\x1b[0m'; // reset
const B = '\x1b[1m'; // bold
const DIM = '\x1b[2m'; // dim
const C = '\x1b[36m'; // cyan
const G = '\x1b[32m'; // green
const Y = '\x1b[33m'; // yellow
const M = '\x1b[35m'; // magenta
const BLU = '\x1b[34m'; // blue

// ── Documents ─────────────────────────────────────────────────────────────────

type Doc = { id: string; category: string; title: string; body: string };

const DOCUMENTS: Doc[] = [
  // ── Machine Learning (8) ───────────────────────────────────────────────────
  {
    id: 'ml-01',
    category: 'Machine Learning',
    title: 'Backpropagation',
    body: 'Backpropagation computes gradients layer-by-layer using the chain rule to train deep neural networks.',
  },
  {
    id: 'ml-02',
    category: 'Machine Learning',
    title: 'Gradient Descent',
    body: 'Gradient descent minimises the loss function by iteratively moving parameters in the direction of steepest descent.',
  },
  {
    id: 'ml-03',
    category: 'Machine Learning',
    title: 'Overfitting',
    body: 'Overfitting occurs when a model memorises training examples instead of learning generalisable patterns.',
  },
  {
    id: 'ml-04',
    category: 'Machine Learning',
    title: 'Convolutional Networks',
    body: 'CNNs apply learnable filters that slide over images to extract hierarchical visual features for classification.',
  },
  {
    id: 'ml-05',
    category: 'Machine Learning',
    title: 'Transformer Architecture',
    body: 'Transformers rely entirely on self-attention to model long-range dependencies, replacing recurrent networks.',
  },
  {
    id: 'ml-06',
    category: 'Machine Learning',
    title: 'Reinforcement Learning',
    body: 'RL agents learn optimal behaviour by maximising cumulative reward through trial and error in an environment.',
  },
  {
    id: 'ml-07',
    category: 'Machine Learning',
    title: 'Random Forests',
    body: 'Random forests combine many decision trees trained on random data subsets, reducing overfitting through ensemble averaging.',
  },
  {
    id: 'ml-08',
    category: 'Machine Learning',
    title: 'Attention Mechanism',
    body: 'Attention allows models to dynamically weight different parts of the input sequence when producing each output token.',
  },
  // ── French History (6) ────────────────────────────────────────────────────
  {
    id: 'fr-01',
    category: 'French History',
    title: 'French Revolution',
    body: 'The French Revolution began in 1789 with the storming of the Bastille, overthrowing the monarchy.',
  },
  {
    id: 'fr-02',
    category: 'French History',
    title: 'Eiffel Tower',
    body: "Built in 1889 for the Paris World's Fair, the Eiffel Tower stands 330 metres tall on the Champ de Mars.",
  },
  {
    id: 'fr-03',
    category: 'French History',
    title: 'Battle of Waterloo',
    body: "The Battle of Waterloo in 1815 ended Napoleon Bonaparte's rule and reshaped the map of Europe.",
  },
  {
    id: 'fr-04',
    category: 'French History',
    title: 'The Louvre',
    body: "The Louvre in Paris is the world's largest art museum, home to the Mona Lisa and Venus de Milo.",
  },
  {
    id: 'fr-05',
    category: 'French History',
    title: 'Napoleon Bonaparte',
    body: 'Napoleon rose from military general to Emperor of France, conquering much of Europe before his final exile after Waterloo.',
  },
  {
    id: 'fr-06',
    category: 'French History',
    title: 'Palace of Versailles',
    body: 'The Palace of Versailles was the royal residence of French kings from Louis XIV, symbolising absolute monarchy and Baroque architecture.',
  },
  // ── Biology (5) ───────────────────────────────────────────────────────────
  {
    id: 'bio-01',
    category: 'Biology',
    title: 'DNA Double Helix',
    body: 'DNA is a double-helix polymer encoding genetic instructions in four nucleotide bases: A, T, C and G.',
  },
  {
    id: 'bio-02',
    category: 'Biology',
    title: 'CRISPR-Cas9',
    body: 'CRISPR-Cas9 enables precise in-vivo editing of DNA sequences, revolutionising genetic medicine and research.',
  },
  {
    id: 'bio-03',
    category: 'Biology',
    title: 'Photosynthesis',
    body: 'Plants convert sunlight, water and CO2 into glucose and oxygen through light-dependent reactions and the Calvin cycle.',
  },
  {
    id: 'bio-04',
    category: 'Biology',
    title: 'Natural Selection',
    body: 'Natural selection favours organisms with traits that improve survival and reproduction, driving evolutionary change across generations.',
  },
  {
    id: 'bio-05',
    category: 'Biology',
    title: 'Mitosis',
    body: 'Mitosis is the cell division process where one cell splits into two genetically identical daughter cells, enabling growth and tissue repair.',
  },
  // ── Databases (4) ─────────────────────────────────────────────────────────
  {
    id: 'db-01',
    category: 'Databases',
    title: 'B+ Tree Indexes',
    body: 'B+ trees store sorted keys in linked leaf nodes, providing O(log n) point lookups and efficient range scans.',
  },
  {
    id: 'db-02',
    category: 'Databases',
    title: 'Write-Ahead Logging',
    body: 'WAL writes every change to a log before touching data pages, guaranteeing atomicity and crash recovery.',
  },
  {
    id: 'db-03',
    category: 'Databases',
    title: 'HNSW Vector Index',
    body: 'HNSW builds a hierarchical navigable small world graph of embeddings, enabling approximate nearest-neighbour search in sub-linear time.',
  },
  {
    id: 'db-04',
    category: 'Databases',
    title: 'ACID Transactions',
    body: 'ACID guarantees atomicity, consistency, isolation and durability, ensuring database transactions are reliably processed even after failures.',
  },
  // ── Space & Astronomy (4) ─────────────────────────────────────────────────
  {
    id: 'space-01',
    category: 'Space & Astronomy',
    title: 'Black Holes',
    body: 'Black holes are regions where gravity is so extreme that not even light can escape, forming when massive stars collapse at the end of their life.',
  },
  {
    id: 'space-02',
    category: 'Space & Astronomy',
    title: 'The Big Bang',
    body: 'The Big Bang describes the rapid expansion of the universe from an ultra-dense singularity approximately 13.8 billion years ago.',
  },
  {
    id: 'space-03',
    category: 'Space & Astronomy',
    title: 'Mars Exploration',
    body: 'NASA rovers Curiosity and Perseverance study Martian geology and atmosphere, searching for signs of ancient microbial life.',
  },
  {
    id: 'space-04',
    category: 'Space & Astronomy',
    title: 'Exoplanets',
    body: 'Exoplanets orbit stars outside our solar system; the James Webb Space Telescope analyses their atmospheres for potential biosignatures.',
  },
  // ── Sports (4) ────────────────────────────────────────────────────────────
  {
    id: 'sport-01',
    category: 'Sports',
    title: 'Formula 1',
    body: 'Formula 1 cars reach over 350 km/h using hybrid power units, advanced aerodynamic downforce and ultra-grippy slick tyres.',
  },
  {
    id: 'sport-02',
    category: 'Sports',
    title: 'Football',
    body: 'Football is the most popular sport in the world, played by two teams of eleven players each aiming to kick the ball into the opposing goal.',
  },
  {
    id: 'sport-03',
    category: 'Sports',
    title: 'Olympic Games',
    body: 'The Olympic Games unite athletes from over 200 nations every four years to compete across dozens of summer and winter sport disciplines.',
  },
  {
    id: 'sport-04',
    category: 'Sports',
    title: 'Tennis',
    body: 'Tennis players score points by hitting a ball over a net so the opponent cannot return it, competing in Grand Slam tournaments worldwide.',
  },
];

// ── Suggestions ───────────────────────────────────────────────────────────────

const SUGGESTIONS = [
  'How do neural networks learn from data?',
  'French history, monuments and famous battles',
  'DNA editing and genetic technology',
  'crash recovery and database indexing',
  'optimisation algorithms for training models',
  'art museums and landmarks in Paris',
  'space exploration and the universe',
  'competitive team sports and athletics',
];

// ── Display helpers ───────────────────────────────────────────────────────────

const CAT_COLOUR: Record<string, string> = {
  'Machine Learning': M,
  'French History': Y,
  Biology: G,
  Databases: C,
  'Space & Astronomy': BLU,
  Sports: '\x1b[91m',
};

function sep(len = 70) {
  return '─'.repeat(len);
}

function printHeader(title: string) {
  console.log(`\n${B}${C}${sep()}${R}`);
  console.log(`${B}${C}  ${title}${R}`);
  console.log(`${B}${C}${sep()}${R}`);
}

function printDocTable() {
  const numCategories = new Set(DOCUMENTS.map((d) => d.category)).size;
  printHeader(`Database — ${DOCUMENTS.length} documents across ${numCategories} categories`);
  let lastCat = '';
  for (const d of DOCUMENTS) {
    if (d.category !== lastCat) {
      lastCat = d.category;
      const cc = CAT_COLOUR[d.category] ?? '';
      console.log(`\n  ${B}${cc}${d.category}${R}`);
      console.log(`  ${DIM}${sep(50)}${R}`);
    }
    console.log(`  ${DIM}[${d['id']}]${R}  ${B}${d['title']}${R}`);
    console.log(`         ${DIM}${d['body']}${R}`);
  }
}

function printResults(results: string[], query: string) {
  if (results.length === 0) {
    console.log(`  ${Y}No results found.${R}`);
    return;
  }
  console.log(`\n  ${DIM}Top ${results.length} results for${R}  ${B}"${query}"${R}\n`);
  results.forEach((json, i) => {
    const d = JSON.parse(json) as Doc;
    const cat = d['category'] ?? '';
    const cc = cat ? (CAT_COLOUR[cat] ?? '') : DIM;
    const catLabel = cat ? `  ${cc}${cat}${R}` : '';
    console.log(`  ${B}${Y}${i + 1}.${R}  ${B}${d['title']}${R}   ${DIM}[${d['id']}]${R}${catLabel}`);
    console.log(`      ${DIM}${d['body']}${R}`);
  });
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, '../demo-db');
const DATA_PATH = path.join(DB_DIR, 'demo.data');
const WAL_PATH = path.join(DB_DIR, 'demo.wal');

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.clear();
  printHeader('SimpleDbms  —  Interactive Semantic Search Demo');
  console.log(`\n  ${DIM}Model: Xenova/all-MiniLM-L6-v2 (384-dim float32 vectors)`);
  console.log(`  Loading… first run downloads ~23 MB and caches locally.${R}\n`);

  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' });
  const embeddingFn = async (text: string): Promise<Float32Array> => {
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    return new Float32Array(out.data);
  };

  const hnswConfig: HnswConfig = { dimension: 384, embeddingFn, M: 16, efConstruction: 100, efSearch: 50 };

  // Build or reopen ────────────────────────────────────────────────────────────
  fs.mkdirSync(DB_DIR, { recursive: true });
  let db: SimpleDbms;

  if (!fs.existsSync(DATA_PATH)) {
    process.stdout.write(`  Building database: embedding ${DOCUMENTS.length} documents `);
    db = await SimpleDbms.create(new RealFile(DATA_PATH), new RealFile(WAL_PATH), hnswConfig);
    for (const doc of DOCUMENTS) {
      await db.insertDocument('knowledge', JSON.stringify(doc));
      process.stdout.write('.');
    }
    await db.commit();
    console.log(`  ${G}done${R}`);
    console.log(`  ${G}✓${R} Persisted to disk with a single WAL commit (records + HNSW vectors).`);
  } else {
    db = await SimpleDbms.open(new RealFile(DATA_PATH), new RealFile(WAL_PATH), hnswConfig);
    console.log(`  ${G}✓${R} Opened existing database from disk.`);
  }

  // Show data ──────────────────────────────────────────────────────────────────
  printDocTable();

  // Suggestions ────────────────────────────────────────────────────────────────
  printHeader('Suggested queries — or type your own');
  console.log();
  SUGGESTIONS.forEach((s, i) => console.log(`  ${B}${BLU}${i + 1}${R}  ${s}`));
  console.log(
    `\n  ${DIM}Enter a number (1-${SUGGESTIONS.length}), a free-form query, ${B}rebuild${R}${DIM}, or ${B}exit${R}${DIM}.${R}\n`,
  );

  // Interactive REPL ───────────────────────────────────────────────────────────
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => {
    rl.question(`${B}${C}search ›${R} `, (raw) => {
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
      console.log(`\n  ${DIM}Closed. Goodbye!${R}\n`);
      rl.close();
      return;
    }

    if (input.toLowerCase() === 'rebuild') {
      await db.close();
      for (const p of [DATA_PATH, WAL_PATH]) if (fs.existsSync(p)) fs.unlinkSync(p);
      console.log(`  ${Y}Database wiped. Run${R} npm run demo ${Y}again to rebuild.${R}\n`);
      rl.close();
      return;
    }

    const num = parseInt(input, 10);
    const query = !isNaN(num) && num >= 1 && num <= SUGGESTIONS.length ? SUGGESTIONS[num - 1] : input;

    process.stdout.write(`  ${DIM}searching…${R}`);
    const results = await db.semanticSearch('knowledge', query, 4);
    process.stdout.write('\r                  \r');
    printResults(results, query);
    console.log();
    ask();
  };

  ask();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
