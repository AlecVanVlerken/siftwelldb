// author: Conversational Analytics Module

import fs from 'node:fs';
import type { SimpleDbms } from '../dbms/simpledbms.mjs';
import type { FieldValue } from '../dbms/document.mjs';

export type FieldType = 'string' | 'number' | 'boolean';

export type FieldDefinition = {
  name: string;
  type: FieldType;
  label: string;
  description?: string;
  synonyms?: string[];
};

export type MeasureDefinition = {
  name: string;
  label: string;
  aggregation: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
  field: string;
  description?: string;
};

export type JoinDefinition = {
  collection: string;
  leftField: string;
  rightField: string;
  relationship: string;
};

export type ExploreDefinition = {
  collection: string;
  label: string;
  description?: string;
  fields: FieldDefinition[];
  measures?: MeasureDefinition[];
  joins?: JoinDefinition[];
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

    const fieldDescs = explore.fields.map((f) => {
      let desc = `  - ${f.name} (${f.type}, label: "${f.label}")`;
      if (f.description) desc += ` — ${f.description}`;
      if (f.synonyms && f.synonyms.length > 0) desc += ` [synonyms: ${f.synonyms.join(', ')}]`;
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

    if (explore.joins && explore.joins.length > 0) {
      const joinDescs = explore.joins.map(
        (j) => `  - JOIN ${j.collection} ON ${j.leftField} = ${j.rightField} (${j.relationship})`,
      );
      parts.push('  Joins:');
      parts.push(...joinDescs);
    }

    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Auto-generate a semantic model by introspecting the database.
 *
 * For each collection it reads the B+ tree metadata to discover indexed
 * fields and their types, then samples the first document to pick up any
 * non-indexed fields and to refine booleans (which are stored as numbers
 * in the index metadata).
 *
 * The result is a usable-but-basic model — labels are derived from field
 * names and numeric fields automatically get standard aggregation measures.
 * You can save the output to JSON and enrich it with descriptions, synonyms,
 * and join definitions by hand.
 */
export async function generateSemanticModel(dbms: SimpleDbms): Promise<SemanticModel> {
  const collections = dbms.listCollections();
  const explores: ExploreDefinition[] = [];

  for (const collection of collections) {
    const metaFields = dbms.describeCollection(collection);
    const sample = await sampleDocument(dbms, collection);

    const fieldMap = new Map<string, FieldDefinition>();

    for (const mf of metaFields) {
      let type: FieldType = mf.type;
      if (sample && mf.name in sample && typeof sample[mf.name] === 'boolean') {
        type = 'boolean';
      }
      fieldMap.set(mf.name, {
        name: mf.name,
        type,
        label: humanize(mf.name),
      });
    }

    if (sample) {
      for (const [key, value] of Object.entries(sample)) {
        if (fieldMap.has(key)) continue;
        const type = inferType(value);
        if (type) {
          fieldMap.set(key, { name: key, type, label: humanize(key) });
        }
      }
    }

    const fields = Array.from(fieldMap.values());

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

async function sampleDocument(dbms: SimpleDbms, collection: string): Promise<Record<string, FieldValue> | null> {
  try {
    const cursor = dbms.cursor(collection, 'id', undefined);
    for await (const json of cursor) {
      return JSON.parse(json) as Record<string, FieldValue>;
    }
  } catch {
    // collection might be empty or missing an 'id' index
  }
  return null;
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
