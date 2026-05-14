// author: Conversational Analytics Module

import fs from 'node:fs';
import type { SimpleDbms } from '../dbms/simpledbms.mjs';
import type { FieldValue } from '../dbms/document.mjs';
import type { LLMProvider } from './llmProvider.mjs';

export type FieldType = 'string' | 'number' | 'boolean';

export type FieldDefinition = {
  name: string;
  type: FieldType;
  label: string;
  description?: string;
  synonyms?: string[];
  /** When true, excluded from the LLM schema prompt (use for internal/join keys). */
  hidden?: boolean;
  /** Free-form tags injected into the schema prompt to improve LLM discoverability. */
  tags?: string[];
};

export type MeasureDefinition = {
  name: string;
  label: string;
  aggregation: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
  field: string;
  description?: string;
};

export type ExploreDefinition = {
  collection: string;
  label: string;
  description?: string;
  fields: FieldDefinition[];
  measures?: MeasureDefinition[];
};

export type SemanticModel = {
  explores: ExploreDefinition[];
};

/**
 * Load a semantic model from a JSON config file.
 */
export function loadSemanticModel(configPath: string): SemanticModel {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as SemanticModel;
  validateModel(parsed);
  return parsed;
}

/**
 * Parse a semantic model from a JSON string.
 */
export function parseSemanticModel(json: string): SemanticModel {
  const parsed = JSON.parse(json) as SemanticModel;
  validateModel(parsed);
  return parsed;
}

function validateModel(model: SemanticModel): void {
  if (!model.explores || !Array.isArray(model.explores) || model.explores.length === 0) {
    throw new Error('Semantic model must have at least one explore');
  }

  for (const explore of model.explores) {
    if (!explore.collection || typeof explore.collection !== 'string') {
      throw new Error('Each explore must have a collection name');
    }
    if (!explore.label || typeof explore.label !== 'string') {
      throw new Error(`Explore "${explore.collection}" must have a label`);
    }
    if (!explore.fields || !Array.isArray(explore.fields) || explore.fields.length === 0) {
      throw new Error(`Explore "${explore.collection}" must have at least one field`);
    }

    for (const field of explore.fields) {
      if (!field.name || !field.type || !field.label) {
        throw new Error(`Fields in "${explore.collection}" must have name, type, and label`);
      }
      if (!['string', 'number', 'boolean'].includes(field.type)) {
        throw new Error(`Invalid field type "${field.type}" for field "${field.name}" in "${explore.collection}"`);
      }
    }

    if (explore.measures) {
      const validAggs = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
      for (const measure of explore.measures) {
        if (!measure.name || !measure.aggregation || !measure.field || !measure.label) {
          throw new Error(`Measures in "${explore.collection}" must have name, aggregation, field, and label`);
        }
        if (!validAggs.has(measure.aggregation)) {
          throw new Error(`Invalid aggregation "${measure.aggregation}" for measure "${measure.name}"`);
        }
      }
    }
  }
}

/**
 * Build a schema description string from the semantic model, suitable for
 * injecting into an LLM prompt so it knows what data is available.
 */
export function modelToSchemaPrompt(model: SemanticModel): string {
  const parts: string[] = [];

  for (const explore of model.explores) {
    const header = explore.description
      ? `Collection "${explore.collection}" (${explore.label}): ${explore.description}`
      : `Collection "${explore.collection}" (${explore.label})`;
    parts.push(header);

      const fieldDescs = explore.fields
      .filter((f) => !f.hidden)
      .map((f) => {
        let desc = `  - ${f.name} (${f.type}, label: "${f.label}")`;
        if (f.description) desc += ` — ${f.description}`;
        if (f.synonyms && f.synonyms.length > 0) desc += ` [synonyms: ${f.synonyms.join(', ')}]`;
        if (f.tags && f.tags.length > 0) desc += ` [tags: ${f.tags.join(', ')}]`;
        return desc;
      });
    parts.push('  Fields:');
    parts.push(...fieldDescs);

    if (explore.measures && explore.measures.length > 0) {
      const measureDescs = explore.measures.map((m) => {
        let desc = `  - ${m.label}: ${m.aggregation}(${m.field})`;
        if (m.description) desc += ` — ${m.description}`;
        return desc;
      });
      parts.push('  Measures:');
      parts.push(...measureDescs);
    }

    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Auto-generate a semantic model by introspecting the database.
 *
 * For each collection it reads the B+ tree metadata to discover indexed
 * fields and their types, then samples a few documents to pick up
 * non-indexed fields, refine booleans (which are stored as numbers in
 * the index metadata), and add lightweight value hints.
 *
 * The result is a usable-but-basic model — labels are derived from field
 * names and numeric fields automatically get standard aggregation measures.
 * You can save the output to JSON and enrich it with descriptions and
 * synonyms by hand.
 */
export async function generateSemanticModel(dbms: SimpleDbms): Promise<SemanticModel> {
  const collections = dbms.listCollections();
  const explores: ExploreDefinition[] = [];

  for (const collection of collections) {
    const metaFields = dbms.describeCollection(collection);
    const samples = await sampleDocuments(dbms, collection);

    const fieldMap = new Map<string, FieldDefinition>();

    for (const mf of metaFields) {
      let type: FieldType = mf.type;
      if (samples.some((sample) => mf.name in sample && typeof sample[mf.name] === 'boolean')) {
        type = 'boolean';
      }
      fieldMap.set(mf.name, {
        name: mf.name,
        type,
        label: humanize(mf.name),
      });
    }

    for (const sample of samples) {
      for (const [key, value] of Object.entries(sample)) {
        if (fieldMap.has(key)) continue;
        const type = inferType(value);
        if (type) {
          fieldMap.set(key, { name: key, type, label: humanize(key) });
        }
      }
    }

    const fields = Array.from(fieldMap.values()).map((field) => enrichGeneratedField(field, samples));

    const measures: MeasureDefinition[] = [];
    for (const field of fields) {
      if (field.type !== 'number') continue;
      if (field.name === 'id') continue;
      for (const agg of ['AVG', 'SUM', 'MIN', 'MAX'] as const) {
        measures.push({
          name: `${agg.toLowerCase()}_${field.name}`,
          label: `${agg.charAt(0) + agg.slice(1).toLowerCase()} ${field.label}`,
          aggregation: agg,
          field: field.name,
        });
      }
    }
    measures.push({
      name: 'count',
      label: 'Count',
      aggregation: 'COUNT',
      field: '*',
    });

    explores.push({
      collection,
      label: humanize(collection),
      fields,
      measures,
    });
  }

  return { explores };
}

const SAMPLE_ROW_LIMIT = 10;
const VALUE_HINT_LIMIT = 8;

async function sampleDocuments(dbms: SimpleDbms, collection: string): Promise<Record<string, FieldValue>[]> {
  const samples: Record<string, FieldValue>[] = [];
  try {
    const cursor = dbms.cursor(collection, 'id', undefined);
    for await (const json of cursor) {
      samples.push(JSON.parse(json) as Record<string, FieldValue>);
      if (samples.length >= SAMPLE_ROW_LIMIT) break;
    }
  } catch {
    // collection might be empty or missing an 'id' index
  }
  return samples;
}

function inferType(value: unknown): FieldType | null {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return null;
}

function humanize(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function deterministicSynonyms(fieldName: string): string[] {
  const normalized = fieldName.replace(/[_-]/g, '').toLowerCase();
  const synonyms = new Set<string>();
  const add = (...values: string[]) => values.forEach((v) => synonyms.add(v));

  if (normalized.includes('salary') || normalized.includes('wage') || normalized.includes('pay')) {
    add('pay', 'wage', 'compensation', 'income', 'earnings');
  }
  if (normalized.includes('department') || normalized.includes('dept')) {
    add('team', 'division', 'business unit');
  }
  if (normalized.includes('city') || normalized.includes('location') || normalized.includes('office')) {
    add('location', 'office', 'place');
  }
  if (normalized.includes('yearsatcompany') || normalized.includes('tenure')) {
    add('tenure', 'years employed', 'experience');
  }
  if (normalized.includes('seniority') || normalized.includes('level')) {
    add('level', 'rank', 'experience level');
  }
  if (normalized.includes('gender') || normalized.includes('sex')) {
    add('sex');
  }
  if (normalized === 'name' || normalized.endsWith('name')) {
    add('person', 'employee', 'record name');
  }

  return [...synonyms];
}

function sampledValueHint(field: FieldDefinition, samples: Record<string, FieldValue>[]): string | undefined {
  if (field.type !== 'string' && field.type !== 'boolean') return undefined;
  const values = new Set<string>();
  for (const sample of samples) {
    const value = sample[field.name];
    if (typeof value === 'string' || typeof value === 'boolean') {
      values.add(String(value));
      if (values.size > VALUE_HINT_LIMIT) return undefined;
    }
  }
  if (values.size === 0) return undefined;
  return `values: ${[...values].join(', ')}`;
}

function enrichGeneratedField(field: FieldDefinition, samples: Record<string, FieldValue>[]): FieldDefinition {
  const synonyms = deterministicSynonyms(field.name);
  const valueHint = sampledValueHint(field, samples);
  return {
    ...field,
    synonyms: synonyms.length > 0 ? synonyms : field.synonyms,
    tags: valueHint ? [...(field.tags ?? []), valueHint] : field.tags,
  };
}

// ── LLM-powered model enrichment ─────────────────────────────────────────────

type FieldStats = {
  sampleRows: Record<string, FieldValue>[];
  /** All distinct values for string fields (capped at 30 to limit prompt size). */
  distinctStringValues: Record<string, string[]>;
  /** min / max / avg for numeric fields, computed over all rows. */
  numericStats: Record<string, { min: number; max: number; avg: number }>;
  rowCount: number;
};

async function collectFieldStats(dbms: SimpleDbms, collection: string, fields: FieldDefinition[]): Promise<FieldStats> {
  const stringFieldNames = new Set(fields.filter((f) => f.type === 'string').map((f) => f.name));
  const numericFieldNames = new Set(fields.filter((f) => f.type === 'number').map((f) => f.name));

  const sampleRows: Record<string, FieldValue>[] = [];
  const distinctSets: Record<string, Set<string>> = {};
  const numAccum: Record<string, { sum: number; min: number; max: number; count: number }> = {};

  for (const n of stringFieldNames) distinctSets[n] = new Set();
  for (const n of numericFieldNames) numAccum[n] = { sum: 0, min: Infinity, max: -Infinity, count: 0 };

  let rowCount = 0;
  try {
    const cursor = dbms.cursor(collection, 'id', undefined);
    for await (const json of cursor) {
      const doc = JSON.parse(json) as Record<string, FieldValue>;
      if (sampleRows.length < 10) sampleRows.push(doc);
      rowCount++;
      for (const n of stringFieldNames) {
        const v = doc[n];
        if (typeof v === 'string' && distinctSets[n].size < 30) distinctSets[n].add(v);
      }
      for (const n of numericFieldNames) {
        const v = doc[n];
        if (typeof v === 'number') {
          const a = numAccum[n];
          a.sum += v; a.min = Math.min(a.min, v); a.max = Math.max(a.max, v); a.count++;
        }
      }
    }
  } catch { /* empty collection or no id index */ }

  const distinctStringValues: Record<string, string[]> = {};
  for (const [k, s] of Object.entries(distinctSets)) distinctStringValues[k] = [...s].sort();

  const numericStats: Record<string, { min: number; max: number; avg: number }> = {};
  for (const [k, a] of Object.entries(numAccum)) {
    if (a.count > 0) numericStats[k] = { min: a.min, max: a.max, avg: Math.round(a.sum / a.count) };
  }

  return { sampleRows, distinctStringValues, numericStats, rowCount };
}

function buildEnrichmentPrompt(model: SemanticModel, stats: Record<string, FieldStats>): string {
  let schemaDesc = '';
  for (const explore of model.explores) {
    const s = stats[explore.collection];
    schemaDesc += `\n=== Collection: "${explore.collection}" (${s.rowCount} rows) ===\nFields:\n`;
    for (const f of explore.fields) {
      schemaDesc += `  - ${f.name} (${f.type})\n`;
      const sv = s.distinctStringValues[f.name];
      if (sv?.length) schemaDesc += `    Distinct values (${sv.length}): ${sv.join(', ')}\n`;
      const ns = s.numericStats[f.name];
      if (ns) schemaDesc += `    Range: min=${ns.min}, max=${ns.max}, avg=${ns.avg}\n`;
    }
    schemaDesc += `\nSample rows:\n${JSON.stringify(s.sampleRows.slice(0, 5), null, 2)}\n`;
  }

  return `You are enriching a semantic model for a conversational analytics system.

Current model (needs enrichment):
${JSON.stringify(model, null, 2)}

Schema and data statistics:
${schemaDesc}

Return an enriched version of the model JSON following these rules:
1. Keep all existing field names exactly — do NOT rename them.
2. Add a meaningful "description" to each field and to the collection itself.
3. Add "synonyms" arrays for fields that have common business aliases.
4. Set "hidden": true for ID/internal fields not useful for analytics.
5. Do NOT remove any existing fields or measures.
6. You MAY add useful measures beyond the auto-generated ones (e.g. headcount measure using COUNT(*)).
7. Each explore is single-collection. Do NOT propose join, relationship, or foreign-key information — joins are not part of this model.
8. Output ONLY the enriched model JSON — no explanation, no markdown fences.`;
}

/**
 * Merge the LLM's enriched model onto the original, applying only additive/safe changes.
 * Never removes existing fields, measures, or explores.
 * Only updates field metadata (description, synonyms, hidden, tags) and adds new measures.
 * The LLM cannot invent new base fields or cross-collection joins.
 */
function mergeEnrichedModel(original: SemanticModel, llmOutput: string): SemanticModel {
  let text = llmOutput.trim();
  const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i);
  if (fence) text = fence[1].trim();

  let enriched: SemanticModel;
  try {
    enriched = JSON.parse(text) as SemanticModel;
  } catch {
    console.warn('[enrichModel] LLM returned invalid JSON, keeping original model');
    return original;
  }

  for (const origExplore of original.explores) {
    const enrichedExplore = enriched.explores?.find((e) => e.collection === origExplore.collection);
    if (!enrichedExplore) continue;

    if (typeof enrichedExplore.description === 'string') origExplore.description = enrichedExplore.description;

    // Update existing fields (description, synonyms, hidden, tags only — no new fields)
    for (const origField of origExplore.fields) {
      const ef = enrichedExplore.fields?.find((f) => f.name === origField.name);
      if (!ef) continue;
      if (typeof ef.description === 'string') origField.description = ef.description;
      if (Array.isArray(ef.synonyms) && ef.synonyms.length > 0) origField.synonyms = ef.synonyms as string[];
      if (ef.hidden === true) origField.hidden = true;
      if (Array.isArray(ef.tags) && ef.tags.length > 0) origField.tags = ef.tags as string[];
    }

    // Add new measures
    origExplore.measures = origExplore.measures ?? [];
    for (const em of enrichedExplore.measures ?? []) {
      if (origExplore.measures.some((m) => m.name === em.name)) continue;
      if (!em.name || !em.aggregation || !em.field || !em.label) continue;
      const validAggs = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
      if (!validAggs.has(em.aggregation)) continue;
      origExplore.measures.push(em);
    }

    // Joins intentionally not supported in the schema model.
    // If the LLM tries to inject them, silently drop.
  }

  return original;
}

/**
 * LLM-powered model enrichment.
 *
 * Collects field statistics (distinct string values, numeric ranges, sample rows)
 * for every collection, then asks the LLM to add descriptions, synonyms, hidden
 * flags, and optional analytics measures.
 *
 * The merge step is strictly additive: existing fields/measures are never removed,
 * and the LLM cannot invent new base fields or join relationships. Each explore is
 * single-collection by design; cross-collection analytics is a SQL-tab feature.
 */
export async function enrichModelWithLLM(model: SemanticModel, dbms: SimpleDbms, llm: LLMProvider): Promise<SemanticModel> {
  const stats: Record<string, FieldStats> = {};
  for (const explore of model.explores) {
    stats[explore.collection] = await collectFieldStats(dbms, explore.collection, explore.fields);
  }

  const prompt = buildEnrichmentPrompt(model, stats);
  const systemPrompt =
    'You are a data modeling expert. Enrich the given semantic model JSON using the provided schema and data statistics. Output ONLY valid JSON matching the exact SemanticModel structure.';

  try {
    const response = await llm.generate(systemPrompt, prompt);
    return mergeEnrichedModel(model, response.text);
  } catch (err) {
    console.warn('[enrichModel] LLM enrichment failed, using unenriched model:', err instanceof Error ? err.message : err);
    return model;
  }
}

