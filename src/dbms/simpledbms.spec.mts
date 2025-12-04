import { describe, expect, it } from 'vitest';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { MockFile } from '../core/mockfile.mjs';
import { SimpleDbms } from './simpledbms.mjs';

const createAtomicFile = () => new AtomicFile(new MockFile(512), new MockFile(512));

describe('SimpleDbms', () => {
  it('stores, retrieves and deletes documents', async () => {
    const db = await SimpleDbms.create(createAtomicFile());

    db.insert('cities', { id: 'Leuven', population: 101032, isProvinceCapital: true });
    db.insert('cities', { id: 'Brussels', population: 196828, isNationalCapital: true });

    expect(db.get('cities', 'Leuven')?.['population']).toBe(101032);
    expect(db.listCollections()).toEqual(['cities']);

    expect(db.delete('cities', 'Leuven')).toBe(true);
    expect(db.get('cities', 'Leuven')).toBeNull();
    await db.close();
  });

  it('iterates documents ordered by an indexed field starting from a value', async () => {
    const db = await SimpleDbms.create(createAtomicFile());
    db.insert('universities', { id: 'KU Leuven', city: 'Leuven', studentCount: 65655 });
    db.insert('universities', { id: 'VUB', city: 'Brussels', studentCount: 22313 });
    db.insert('universities', { id: 'UA', city: 'Antwerp', studentCount: 20000 });

    const results = Array.from(db.iterate('universities', 'studentCount', 22000)).map((doc) => doc.id);
    expect(results).toEqual(['VUB', 'KU Leuven']);
    await db.close();
  });

  it('persists data using the backend and reloads correctly', async () => {
    const dataFile = new MockFile(512);
    const logFile = new MockFile(512);

    const db = await SimpleDbms.create(new AtomicFile(dataFile, logFile));
    db.insert('cities', { id: 'Brussels', population: 196828, isNationalCapital: true });
    await db.commit();
    await db.close();

    const reopened = await SimpleDbms.open(new AtomicFile(dataFile, logFile));
    const doc = reopened.get('cities', 'Brussels');
    expect(doc?.['population']).toBe(196828);
    expect(reopened.listDocuments('cities')).toHaveLength(1);
    await reopened.close();
  });
});
