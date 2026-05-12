/**
 * One-off test seed: creates data.db in the project root with 200 employees.
 * Run once with: npx tsx src/conversational/seed-main-db.mts
 * Delete data.db + data.db.log when done testing.
 */
import { RealFile } from '../core/file.mjs';
import { SimpleDbms } from '../dbms/simpledbms.mjs';
import { generateEmployees } from './seedData.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../');
const DB = path.join(root, 'data.db');
const LOG = path.join(root, 'data.db.log');

if (fs.existsSync(DB)) {
  console.log('data.db already exists — delete it first if you want to re-seed.');
  process.exit(0);
}

const employees = generateEmployees(200);
const db = await SimpleDbms.create(new RealFile(DB), new RealFile(LOG));
for (const emp of employees) {
  await db.insertDocument('employees', JSON.stringify(emp));
}
await db.commit();
await db.close();
console.log(`Seeded ${employees.length} employees into ${DB}`);
