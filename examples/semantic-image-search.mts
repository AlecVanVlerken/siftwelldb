/**
 * Interactive Semantic **Image** Search Demo — SimpleDbms + CLIP
 *
 * Uses OpenAI's CLIP model (Xenova/clip-vit-base-patch32) to embed images
 * and text into the **same** 512-dimensional vector space.  This means you
 * can describe what you are looking for in plain English and the database
 * returns the most visually relevant images.
 *
 * Run with:
 *   npm run demo:images
 *
 * On first launch the demo:
 *   1. Downloads the CLIP model (~340 MB, cached after first run).
 *   2. Reads the six bundled CC0 photographs in examples/assets/images/.
 *   3. Inserts them into a SimpleDbms collection and commits to disk.
 *
 * Commands at the prompt:
 *   <query text>   — text-to-image semantic search (top 5 results)
 *   1-6            — use a numbered suggestion
 *   rebuild        — reset the demo database (next run rebuilds)
 *   exit / quit    — close and exit
 */

import {
  AutoTokenizer,
  AutoProcessor,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  RawImage,
} from '@huggingface/transformers';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { RealFile } from '../src/storage/file.mjs';
import { SimpleDbms, type HnswConfig } from '../src/database/simpledbms.mjs';

// ── CLIP model ────────────────────────────────────────────────────────────────

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const CLIP_DIM = 512;

// ── ANSI colours ──────────────────────────────────────────────────────────────

const R = '\x1b[0m';
const B = '\x1b[1m';
const DIM = '\x1b[2m';
const C = '\x1b[36m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const M = '\x1b[35m';
const BLU = '\x1b[34m';

// ── Suggestions ───────────────────────────────────────────────────────────────

const SUGGESTIONS = [
  'a cute fluffy pet',
  'a large elephant with tusks',
  'penguins standing beside water',
  'a dog resting on a sandy beach',
  'a cat sleeping in the sunlight',
  'a butterfly on a flower',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function sep(len = 70) {
  return '─'.repeat(len);
}

function printHeader(title: string) {
  console.log(`\n${B}${C}${sep()}${R}`);
  console.log(`${B}${C}  ${title}${R}`);
  console.log(`${B}${C}${sep()}${R}`);
}

/** Build a clickable file:// hyperlink using the OSC 8 terminal escape. */
function fileLink(absPath: string, label?: string): string {
  const uri = `file:///${absPath.replace(/\\/g, '/')}`;
  const text = label ?? path.basename(absPath);
  // OSC 8 ;; URI ST  text  OSC 8 ;; ST
  return `\x1b]8;;${uri}\x07${text}\x1b]8;;\x07`;
}

/** L2-normalise a vector in-place (returns same buffer for convenience). */
function l2Normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (const val of v) norm += val * val;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

function printImageTable(imageDir: string, files: string[]) {
  printHeader(`Image database — ${files.length} images`);
  console.log();
  const COL = 5;
  for (let i = 0; i < files.length; i += COL) {
    const row = files.slice(i, i + COL).map((f) => {
      const absPath = path.join(imageDir, f);
      return `  ${fileLink(absPath, f)}`;
    });
    console.log(row.join(''));
  }
  console.log(`\n  ${DIM}Images are stored in:${R} ${fileLink(imageDir, imageDir)}`);
}

type ResultDoc = { id: string; 'image.jpeg'?: string };

function printResults(results: string[], query: string, imageDir: string) {
  if (results.length === 0) {
    console.log(`  ${Y}No results found.${R}`);
    return;
  }
  console.log(`\n  ${DIM}Top ${results.length} results for${R}  ${B}"${query}"${R}\n`);
  results.forEach((json, i) => {
    const d = JSON.parse(json) as ResultDoc;
    const absPath = path.join(imageDir, d.id);
    const exists = fs.existsSync(absPath);
    const imgSize = d['image.jpeg'] ? `${(Buffer.from(d['image.jpeg'], 'base64').length / 1024).toFixed(1)} KB` : '?';
    const link = exists ? fileLink(absPath, d.id) : d.id;
    console.log(`  ${B}${Y}${i + 1}.${R}  ${B}${link}${R}  ${DIM}(${imgSize})${R}`);
  });
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, '../demo-db');
const IMAGE_DIR = path.join(__dirname, 'assets/images');
const DATA_PATH = path.join(DB_DIR, 'image-demo.data');
const WAL_PATH = path.join(DB_DIR, 'image-demo.wal');

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.clear();
  printHeader('SimpleDbms  —  Interactive Image Semantic Search Demo');
  console.log(`\n  ${DIM}Model : ${MODEL_ID} (${CLIP_DIM}-dim float32 vectors)`);
  console.log(`  ${DIM}Loading… first run downloads ~340 MB and caches locally.${R}\n`);

  // ── Load CLIP text & vision models ────────────────────────────────────────
  // CLIP is a dual-encoder model with separate text_model.onnx and
  // vision_model.onnx.  We load the dedicated projection classes rather
  // than the generic pipeline() API (which expects a single model.onnx).

  process.stdout.write(`  ${DIM}Loading CLIP tokenizer & text model…${R}`);
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  const textModel = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'fp32' });
  process.stdout.write(`  ${G}✓${R}\n`);

  process.stdout.write(`  ${DIM}Loading CLIP processor & vision model…${R}`);
  const processor = await AutoProcessor.from_pretrained(MODEL_ID);
  const visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'fp32' });
  process.stdout.write(`  ${G}✓${R}\n`);

  // ── Embedding functions ───────────────────────────────────────────────────

  const embeddingFn = async (text: string): Promise<Float32Array> => {
    const inputs = tokenizer(text, { padding: true, truncation: true });
    const { text_embeds } = (await textModel(inputs)) as { text_embeds: { data: ArrayLike<number> } };
    return l2Normalize(new Float32Array(text_embeds.data));
  };

  const imageEmbeddingFn = async (imageData: Buffer): Promise<Float32Array> => {
    const blob = new Blob([new Uint8Array(imageData)]);
    const image = await RawImage.fromBlob(blob);
    const inputs = await processor(image);
    const { image_embeds } = (await visionModel(inputs)) as { image_embeds: { data: ArrayLike<number> } };
    return l2Normalize(new Float32Array(image_embeds.data));
  };

  const hnswConfig: HnswConfig = {
    dimension: CLIP_DIM,
    embeddingFn,
    imageEmbeddingFn,
    M: 16,
    efConstruction: 100,
    efSearch: 50,
  };

  // ── Ensure sample images exist ────────────────────────────────────────────

  // Bundled photos have per-file provenance in assets/images/sources.json.
  // No external image downloads are performed by this example.
  const imageFiles = fs
    .readdirSync(IMAGE_DIR)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort();

  if (imageFiles.length === 0) {
    console.error(`\n  ${Y}No images available. Add .jpg/.png/.webp files to ${IMAGE_DIR} and rerun.${R}\n`);
    process.exit(1);
  }

  // ── Build or reopen the database ──────────────────────────────────────────

  // Rebuild the disposable demo database when fixture names or bytes change.
  fs.mkdirSync(DB_DIR, { recursive: true });
  const currentImages = new Map(
    imageFiles.map((file) => [file, fs.readFileSync(path.join(IMAGE_DIR, file)).toString('base64')]),
  );
  if (fs.existsSync(DATA_PATH)) {
    let tempDb: SimpleDbms | undefined;
    try {
      tempDb = await SimpleDbms.open(new RealFile(DATA_PATH), new RealFile(WAL_PATH), hnswConfig);
      let storedCount = 0;
      let imagesMatch = true;
      for await (const json of tempDb.cursor('photos', 'id')) {
        const stored = JSON.parse(json) as ResultDoc;
        if (currentImages.get(stored.id) !== stored['image.jpeg']) imagesMatch = false;
        storedCount++;
      }
      await tempDb.close();
      tempDb = undefined;
      if (!imagesMatch || storedCount !== imageFiles.length) {
        console.log(`\n  ${Y}The bundled image set changed; rebuilding the demo database.${R}`);
        fs.unlinkSync(DATA_PATH);
        if (fs.existsSync(WAL_PATH)) fs.unlinkSync(WAL_PATH);
      }
    } catch {
      await tempDb?.close().catch(() => {});
      fs.unlinkSync(DATA_PATH);
      if (fs.existsSync(WAL_PATH)) fs.unlinkSync(WAL_PATH);
    }
  }

  let db: SimpleDbms;

  if (!fs.existsSync(DATA_PATH)) {
    process.stdout.write(`\n  Building database: embedding ${imageFiles.length} images `);
    db = await SimpleDbms.create(new RealFile(DATA_PATH), new RealFile(WAL_PATH), hnswConfig);
    for (const file of imageFiles) {
      const doc = {
        id: file,
        'image.jpeg': currentImages.get(file)!,
      };
      await db.insertDocument('photos', JSON.stringify(doc));
      process.stdout.write('.');
    }
    await db.commit();
    console.log(`  ${G}done${R}`);
    console.log(`  ${G}✓${R} Persisted to disk — records + HNSW vectors committed atomically.`);
  } else {
    db = await SimpleDbms.open(new RealFile(DATA_PATH), new RealFile(WAL_PATH), hnswConfig);
    console.log(`\n  ${G}✓${R} Opened existing image database from disk.`);
  }

  // ── Show stored images ────────────────────────────────────────────────────

  printImageTable(IMAGE_DIR, imageFiles);

  // ── Suggestions ───────────────────────────────────────────────────────────

  printHeader('Suggested queries — or type your own');
  console.log();
  SUGGESTIONS.forEach((s, i) => console.log(`  ${B}${BLU}${i + 1}${R}  ${s}`));
  console.log(
    `\n  ${DIM}Enter a number (1-${SUGGESTIONS.length}), a free-form query, ${B}rebuild${R}${DIM}, or ${B}exit${R}${DIM}.${R}\n`,
  );

  // ── Interactive REPL ──────────────────────────────────────────────────────

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => {
    rl.question(`${B}${M}image search ›${R} `, (raw) => {
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
      console.log(`  ${Y}Demo database reset. Run${R} npm run demo:images ${Y}again to rebuild.${R}\n`);
      rl.close();
      return;
    }

    const num = parseInt(input, 10);
    const query = !isNaN(num) && num >= 1 && num <= SUGGESTIONS.length ? SUGGESTIONS[num - 1] : input;

    process.stdout.write(`  ${DIM}searching…${R}`);
    const results = await db.semanticSearch('photos', query, 5);
    process.stdout.write('\r                  \r');
    printResults(results, query, IMAGE_DIR);
    console.log();
    ask();
  };

  ask();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
