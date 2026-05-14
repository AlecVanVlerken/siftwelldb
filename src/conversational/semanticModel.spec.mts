import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RealFile } from '../core/file.mjs';
import { SimpleDbms } from '../dbms/simpledbms.mjs';
import {
  generateSemanticModel,
  modelToSchemaPrompt,
  parseSemanticModel,
  type FieldDefinition,
  type MeasureDefinition,
  type SemanticModel,
} from './semanticModel.mjs';

const validModel: SemanticModel = {
  explores: [
    {
      collection: 'employees',
      label: 'Employees',
      description: 'Employee analytics',
      fields: [
        { name: 'id', type: 'string', label: 'ID', hidden: true },
        {
          name: 'department',
          type: 'string',
          label: 'Department',
          description: 'Department name',
          synonyms: ['team'],
          tags: ['dimension'],
        },
        { name: 'salary', type: 'number', label: 'Salary' },
      ],
      measures: [{ name: 'count', label: 'Count', aggregation: 'COUNT', field: '*' }],
    },
  ],
};

describe('semantic model parsing and prompts', () => {
  it('validates required explore and field shape', () => {
    expect(() => parseSemanticModel(JSON.stringify(validModel))).not.toThrow();
    expect(() => parseSemanticModel(JSON.stringify({ explores: [] }))).toThrow(/at least one explore/i);
    expect(() =>
      parseSemanticModel(
        JSON.stringify({
          explores: [
            {
              collection: 'employees',
              label: 'Employees',
              fields: [{ name: 'salary', type: 'money', label: 'Salary' }],
            },
          ],
        }),
      ),
    ).toThrow(/Invalid field type/i);
  });

  it('renders visible field metadata while excluding hidden fields', () => {
    const prompt = modelToSchemaPrompt(validModel);

    expect(prompt).toContain('Collection "employees"');
    expect(prompt).toContain('department (string, label: "Department")');
    expect(prompt).toContain('Department name');
    expect(prompt).toContain('[synonyms: team]');
    expect(prompt).toContain('[tags: dimension]');
    expect(prompt).toContain('Count: COUNT(*)');
    expect(prompt).not.toContain('id (string');
  });
});

describe('generateSemanticModel', () => {
  it('introspects collections, fields, booleans, and numeric measures', async () => {
    const dataPath = path.join(os.tmpdir(), `test_semantic_model_${Date.now()}.data`);
    const logPath = path.join(os.tmpdir(), `test_semantic_model_${Date.now()}.log`);
    if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath);
    if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
    fs.closeSync(fs.openSync(logPath, 'w'));

    const db = await SimpleDbms.create(new RealFile(dataPath), new RealFile(logPath));
    const rabbitBase64 = fs.readFileSync(path.resolve('rabbit.jpg')).toString('base64');
    await db.insertDocumentObject('employees', {
      id: 'e1',
      name: 'Alice',
      active: true,
      salary: 120000,
      department: 'Engineering',
      city: 'Leuven',
      'photo.jpg': rabbitBase64,
    });
    await db.insertDocumentObject('employees', {
      id: 'e2',
      name: 'Bob',
      active: false,
      salary: 90000,
      department: 'Sales',
      city: 'Gent',
    });
    await db.commit();

    const model = await generateSemanticModel(db);
    const employees = model.explores.find((e) => e.collection === 'employees');
    const prompt = modelToSchemaPrompt(model);
    const departmentField = employees?.fields.find((field): field is FieldDefinition => field.name === 'department');
    const cityField = employees?.fields.find((field): field is FieldDefinition => field.name === 'city');
    const photoField = employees?.fields.find((field): field is FieldDefinition => field.name === 'photo.jpg');
    const avgSalary = employees?.measures?.find(
      (measure): measure is MeasureDefinition => measure.name === 'avg_salary',
    );
    const countMeasure = employees?.measures?.find((measure): measure is MeasureDefinition => measure.name === 'count');

    expect(employees).toBeDefined();
    expect(employees?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'name', type: 'string' }),
        expect.objectContaining({ name: 'active', type: 'boolean' }),
        expect.objectContaining({ name: 'salary', type: 'number' }),
        expect.objectContaining({ name: 'department' }),
        expect.objectContaining({ name: 'city' }),
        expect.objectContaining({ name: 'photo.jpg', type: 'string' }),
      ]),
    );
    expect(departmentField?.synonyms).toContain('team');
    expect(cityField?.synonyms).toContain('location');
    expect(photoField?.synonyms).toContain('image');
    expect(photoField?.tags?.some((tag) => tag.includes('image field'))).toBe(true);
    expect(avgSalary).toMatchObject({ aggregation: 'AVG', field: 'salary' });
    expect(countMeasure).toMatchObject({ aggregation: 'COUNT', field: '*' });
    expect(prompt).toContain('values: Engineering, Sales');
    expect(prompt).toContain('values: Leuven, Gent');
    expect(prompt).toContain('image field: base64-encoded media');
    expect(prompt).not.toContain(rabbitBase64.slice(0, 40));
    await db.close();
  });
});
