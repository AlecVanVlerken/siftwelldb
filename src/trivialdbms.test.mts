import assert from 'node:assert/strict';
import { Database } from './trivialdbms.mjs';
import { MockFile, RealFile } from './mockfile.mjs';

async function testOneCommit(deepEqual: (x: unknown, y: unknown) => void) {
  const file = new MockFile(512);
  const db = await Database.create(file);
  deepEqual(await db.getRecords(), []);
  await db.insertRecord(0, { id: 'Leuven', population: 101032, isProvinceCapital: true });
  deepEqual(await db.getRecords(), [{ id: 'Leuven', population: 101032, isProvinceCapital: true }]);
  await db.insertRecord(0, { id: 'Brussels', population: 196828, isNationalCapital: true });
  deepEqual(await db.getRecords(), [
    { id: 'Brussels', population: 196828, isNationalCapital: true },
    { id: 'Leuven', population: 101032, isProvinceCapital: true },
  ]);
  await db.deleteRecord(0);
  deepEqual(await db.getRecords(), [{ id: 'Leuven', population: 101032, isProvinceCapital: true }]);
  await db.commit();
  await db.close();
}

async function testTwoCommits(deepEqual: (x: unknown, y: unknown) => void) {
  const file = new MockFile(512);
  {
    const db = await Database.create(file);
    deepEqual(await db.getRecords(), []);
    await db.insertRecord(0, { id: 'Leuven', population: 101032, isProvinceCapital: true });
    await db.commit();
    await db.close();
  }
  {
    const db = await Database.open(file);
    deepEqual(await db.getRecords(), [{ id: 'Leuven', population: 101032, isProvinceCapital: true }]);
    await db.insertRecord(0, { id: 'Brussels', population: 196828, isNationalCapital: true });
    deepEqual(await db.getRecords(), [
      { id: 'Brussels', population: 196828, isNationalCapital: true },
      { id: 'Leuven', population: 101032, isProvinceCapital: true },
    ]);
    await db.deleteRecord(0);
    deepEqual(await db.getRecords(), [{ id: 'Leuven', population: 101032, isProvinceCapital: true }]);
    await db.commit();
    await db.close();
  }
}

async function testCrash(deepEqual: (x: unknown, y: unknown) => void) {
  const file = new MockFile(512);
  {
    const db = await Database.create(file);
    deepEqual(await db.getRecords(), []);
    await db.insertRecord(0, { id: 'Leuven', population: 101032, isProvinceCapital: true });
    await db.commit();
    await db.close();
  }
  {
    const db = await Database.open(file);
    deepEqual(await db.getRecords(), [{ id: 'Leuven', population: 101032, isProvinceCapital: true }]);
    await db.insertRecord(0, { id: 'Brussels', population: 196828, isNationalCapital: true });
    deepEqual(await db.getRecords(), [
      { id: 'Brussels', population: 196828, isNationalCapital: true },
      { id: 'Leuven', population: 101032, isProvinceCapital: true },
    ]);
    await db.deleteRecord(0);
    deepEqual(await db.getRecords(), [{ id: 'Leuven', population: 101032, isProvinceCapital: true }]);
    file.crash();
  }
  {
    const db = await Database.open(file);
    deepEqual(await db.getRecords(), [{ id: 'Leuven', population: 101032, isProvinceCapital: true }]);
  }
}

async function testManyCommits(deepEqual: (x: unknown, y: unknown) => void) {
  const file = new MockFile(512);
  {
    const db = await Database.create(file);
    await db.commit();
    await db.close();
  }
  {
    const db = await Database.open(file);
    deepEqual(await db.getRecords(), []);
    await db.close();
  }
  {
    const db = await Database.open(file);
    await db.insertRecord(0, { id: 'Leuven', population: 101032, isProvinceCapital: true });
    await db.commit();
    await db.close();
  }
  {
    const db = await Database.open(file);
    deepEqual(await db.getRecords(), [{ id: 'Leuven', population: 101032, isProvinceCapital: true }]);
    await db.close();
  }
  {
    const db = await Database.open(file);
    await db.insertRecord(0, { id: 'Brussels', population: 196828, isNationalCapital: true });
    await db.commit();
    await db.close();
  }
  {
    const db = await Database.open(file);
    deepEqual(await db.getRecords(), [
      { id: 'Brussels', population: 196828, isNationalCapital: true },
      { id: 'Leuven', population: 101032, isProvinceCapital: true },
    ]);
    await db.close();
  }
  {
    const db = await Database.open(file);
    await db.deleteRecord(0);
    await db.commit();
    await db.close();
  }
  {
    const db = await Database.open(file);
    deepEqual(await db.getRecords(), [{ id: 'Leuven', population: 101032, isProvinceCapital: true }]);
    await db.close();
  }
}

async function testRealFile(deepEqual: (x: unknown, y: unknown) => void) {
  const file = new RealFile('testdb');
  {
    const db = await Database.create(file);
    await db.commit();
    await db.close();
  }
  {
    const db = await Database.open(file);
    deepEqual(await db.getRecords(), []);
    await db.close();
  }
  {
    const db = await Database.open(file);
    await db.insertRecord(0, { id: 'Leuven', population: 101032, isProvinceCapital: true });
    await db.commit();
    await db.close();
  }
  {
    const db = await Database.open(file);
    deepEqual(await db.getRecords(), [{ id: 'Leuven', population: 101032, isProvinceCapital: true }]);
    await db.close();
  }
  {
    const db = await Database.open(file);
    await db.insertRecord(0, { id: 'Brussels', population: 196828, isNationalCapital: true });
    await db.commit();
    await db.close();
  }
  {
    const db = await Database.open(file);
    deepEqual(await db.getRecords(), [
      { id: 'Brussels', population: 196828, isNationalCapital: true },
      { id: 'Leuven', population: 101032, isProvinceCapital: true },
    ]);
    await db.close();
  }
  {
    const db = await Database.open(file);
    await db.deleteRecord(0);
    await db.commit();
    await db.close();
  }
  {
    const db = await Database.open(file);
    deepEqual(await db.getRecords(), [{ id: 'Leuven', population: 101032, isProvinceCapital: true }]);
    await db.close();
  }
}

if (process.env['VITEST']) {
  const { describe, it, expect } = await import('vitest');
  describe('Test trivialdbms', () => {
    it('Correctly inserts, deletes, and retrieves records (one commit)', () =>
      testOneCommit((x, y) => expect(x).toEqual(y)));
    it('Correctly inserts, deletes, and retrieves records (two commits)', () =>
      testTwoCommits((x, y) => expect(x).toEqual(y)));
    it('Correctly deals with crashes', () => testCrash((x, y) => expect(x).toEqual(y)));
    it('Correctly inserts, deletes, and retrieves records (many commits)', () =>
      testManyCommits((x, y) => expect(x).toEqual(y)));
    it('Correctly inserts, deletes, and retrieves records (real file)', () =>
      testRealFile((x, y) => expect(x).toEqual(y)));
  });
} else {
  // Wrap your toplevel code in process.nextTick to work around https://github.com/nodejs/node/issues/50430
  process.nextTick(async () => {
    await testOneCommit((x, y) => assert.deepEqual(x, y));
    await testTwoCommits((x, y) => assert.deepEqual(x, y));
    await testCrash((x, y) => assert.deepEqual(x, y));
    await testManyCommits((x, y) => assert.deepEqual(x, y));
    await testRealFile((x, y) => assert.deepEqual(x, y));
    console.log('All tests passed!');
  });
}
