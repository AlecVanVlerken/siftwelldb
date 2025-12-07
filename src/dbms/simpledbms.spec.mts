import { describe, expect, it, beforeEach } from 'vitest';
import { MockFile } from '../core/mockfile.mjs';
import { SimpleDbms } from './simpledbms.mjs';

describe('SimpleDbms', () => {
  let simpleDbms: SimpleDbms;

  beforeEach(async () => {
    const dataFile = new MockFile(4096);
    const logFile = new MockFile(4096);
    simpleDbms = await SimpleDbms.create(dataFile, logFile);
  });

  it('inserts and retrieves a document', async () => {
    const city = { id: 'Leuven', population: 101032, isProvinceCapital: true };

    // Insert the document as a JSON string
    await simpleDbms.insertDocument('cities', JSON.stringify(city));

    // Retrieve by id
    const result = await simpleDbms.getDocumentById('cities', 'Leuven');

    // Compare parsed object
    expect(JSON.parse(result)).toEqual(city);
  });
});
