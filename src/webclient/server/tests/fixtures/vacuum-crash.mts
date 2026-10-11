import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SimpleDbms } from '../../../../database/simpledbms.mjs';
import { RealFile } from '../../../../storage/file.mjs';
import {
  finishVacuumReplacement,
  installVacuumReplacement,
  prepareVacuumReplacement,
  recoverVacuumReplacement,
  vacuumPaths,
} from '../../vacuum-recovery.mjs';

const [mode, filepath, stop] = process.argv.slice(2);
const checkpoint = async (phase: string): Promise<void> => {
  if (phase !== stop) return;
  process.stdout.write(`checkpoint:${phase}\n`);
  // The parent terminates this actual process while all files remain exactly
  // as the protocol left them. No exception unwinding or finally cleanup runs.
  setInterval(() => undefined, 1000);
  await new Promise<void>(() => undefined);
};
const open = () => SimpleDbms.open(new RealFile(filepath), new RealFile(`${filepath}.log`));
const verify = async () => {
  const database = await open();
  try {
    const documents: Array<{ id: string; _payload: string }> = [];
    for await (const raw of database.cursor('books', 'id'))
      documents.push(JSON.parse(raw) as { id: string; _payload: string });
    assert.deepEqual(
      documents.map((document) => document.id),
      ['b08', 'b09', 'b10', 'b11'],
    );
    assert(documents.every((document) => document._payload.length === 8000));
    const titles = [];
    for await (const raw of database.cursor('books', 'title', 'second'))
      titles.push((JSON.parse(raw) as { id: string }).id);
    assert.deepEqual(titles, ['b09', 'b11']);
    assert.equal(database.getFieldIndexConfig('books')['_payload'], false);
  } finally {
    await database.close();
  }
};

if (mode === 'recover') {
  await recoverVacuumReplacement(filepath, verify, checkpoint);
} else {
  const source = await SimpleDbms.create(new RealFile(filepath), new RealFile(`${filepath}.log`));
  await source.setFieldIndexed('books', '_payload', false);
  for (let i = 0; i < 12; i++) {
    await source.insertDocumentObject('books', {
      id: `b${i.toString().padStart(2, '0')}`,
      title: i % 2 ? 'second' : 'first',
      _payload: 'x'.repeat(8000),
    });
  }
  for (let i = 0; i < 8; i++) await source.deleteDocumentById('books', `b${i.toString().padStart(2, '0')}`);
  await source.commit();
  const paths = vacuumPaths(filepath);
  const target = await source.vacuumCompactInto(new RealFile(paths.tempData), new RealFile(paths.tempLog));
  await target.close();
  await source.close();
  const manifest = await prepareVacuumReplacement(paths);
  await fs.writeFile(path.join(path.dirname(filepath), 'expected.json'), JSON.stringify(manifest));
  await installVacuumReplacement(paths, checkpoint);
  await verify();
  await finishVacuumReplacement(paths, manifest, checkpoint);
}
