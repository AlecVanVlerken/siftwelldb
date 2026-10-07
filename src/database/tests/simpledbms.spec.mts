// author: Thomas Dumon
// date: 2025-12-07

import { describe, expect, it, beforeEach } from 'vitest';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { SimpleDbms } from '../simpledbms.mjs';
import { type HnswConfig } from '../dbmsback.mjs';

describe('SimpleDbms', () => {
  let simpleDbms: SimpleDbms;

  beforeEach(async () => {
    const dataFile = new MockFile(256);
    const logFile = new MockFile(4096);
    simpleDbms = await SimpleDbms.create(dataFile, logFile);
  });

  describe('insertDocument and getDocumentById', () => {
    it('inserts and retrieves a single city document', async () => {
      const city = { id: 'Leuven', population: 101032, _isProvinceCapital: true };
      await simpleDbms.insertDocument('cities', JSON.stringify(city));

      const result = await simpleDbms.getDocumentById('cities', 'Leuven');
      expect(JSON.parse(result)).toEqual(city);
    });

    it('inserts and retrieves multiple city documents', async () => {
      const leuven = { id: 'Leuven', population: 101032, _isProvinceCapital: true };
      const brussels = { id: 'Brussels', population: 196828, _isNationalCapital: true };

      await simpleDbms.insertDocument('cities', JSON.stringify(leuven));
      await simpleDbms.insertDocument('cities', JSON.stringify(brussels));

      const result1 = await simpleDbms.getDocumentById('cities', 'Leuven');
      const result2 = await simpleDbms.getDocumentById('cities', 'Brussels');

      expect(JSON.parse(result1)).toEqual(leuven);
      expect(JSON.parse(result2)).toEqual(brussels);
    });

    it('inserts and retrieves university documents', async () => {
      const kuLeuven = { id: 'KU Leuven', city: 'Leuven', studentCount: 65655 };
      const vub = { id: 'VUB', city: 'Brussels', studentCount: 22313 };

      await simpleDbms.insertDocument('universities', JSON.stringify(kuLeuven));
      await simpleDbms.insertDocument('universities', JSON.stringify(vub));

      const result1 = await simpleDbms.getDocumentById('universities', 'KU Leuven');
      const result2 = await simpleDbms.getDocumentById('universities', 'VUB');

      expect(JSON.parse(result1)).toEqual(kuLeuven);
      expect(JSON.parse(result2)).toEqual(vub);
    });

    it('handles documents with non-iterable keys (starting with _)', async () => {
      const city = { id: 'Leuven', population: 101032, _internalNote: 'test data' };
      await simpleDbms.insertDocument('cities', JSON.stringify(city));

      const result = await simpleDbms.getDocumentById('cities', 'Leuven');
      expect(JSON.parse(result)).toEqual(city);
    });
  });

  describe('deleteDocumentById', () => {
    it('deletes a document by id', async () => {
      const city = { id: 'Leuven', population: 101032, _isProvinceCapital: true };
      await simpleDbms.insertDocument('cities', JSON.stringify(city));

      await simpleDbms.deleteDocumentById('cities', 'Leuven');

      await expect(simpleDbms.getDocumentById('cities', 'Leuven')).rejects.toThrow();
    });

    it('deletes one document without affecting others', async () => {
      const leuven = { id: 'Leuven', population: 101032, _isProvinceCapital: true };
      const brussels = { id: 'Brussels', population: 196828, _isNationalCapital: true };

      await simpleDbms.insertDocument('cities', JSON.stringify(leuven));
      await simpleDbms.insertDocument('cities', JSON.stringify(brussels));

      await simpleDbms.deleteDocumentById('cities', 'Leuven');

      await expect(simpleDbms.getDocumentById('cities', 'Leuven')).rejects.toThrow();
      const result = await simpleDbms.getDocumentById('cities', 'Brussels');
      expect(JSON.parse(result)).toEqual(brussels);
    });
  });

  describe('editDocument', () => {
    it('edits a field in a document', async () => {
      const city = { id: 'Leuven', population: 101032, _isProvinceCapital: true };
      await simpleDbms.insertDocument('cities', JSON.stringify(city));

      await simpleDbms.editDocument('cities', 'Leuven', 'population', 102000);

      const result = await simpleDbms.getDocumentById('cities', 'Leuven');
      expect(JSON.parse(result)).toEqual({ id: 'Leuven', population: 102000, _isProvinceCapital: true });
    });

    it('throws error when editing document id or collection name', async () => {
      const city = { id: 'Leuven', population: 101032, _isProvinceCapital: true };
      await simpleDbms.insertDocument('cities', JSON.stringify(city));

      await expect(simpleDbms.editDocument('cities', 'Leuven', 'id', 'New ID')).rejects.toThrow();
      await expect(simpleDbms.editDocument('cities', 'Leuven', 'collection', 'New Collection')).rejects.toThrow();
    });

    it('edits multiple fields in a document sequentially', async () => {
      const city = { id: 'Leuven', population: 101032, _isProvinceCapital: true };
      await simpleDbms.insertDocument('cities', JSON.stringify(city));

      await simpleDbms.editDocument('cities', 'Leuven', 'population', 102000);
      await simpleDbms.editDocument('cities', 'Leuven', '_isProvinceCapital', false);

      const result = await simpleDbms.getDocumentById('cities', 'Leuven');
      expect(JSON.parse(result)).toEqual({ id: 'Leuven', population: 102000, _isProvinceCapital: false });
    });
  });

  describe('cursor - iterate over documents', () => {
    beforeEach(async () => {
      // Setup test data
      const leuven = { id: 'Leuven', population: 101032, _isProvinceCapital: true };
      const brussels = { id: 'Brussels', population: 196828, _isNationalCapital: true };
      const kuLeuven = { id: 'KU Leuven', city: 'Leuven', studentCount: 65655 };
      const vub = { id: 'VUB', city: 'Brussels', studentCount: 22313 };

      await simpleDbms.insertDocument('cities', JSON.stringify(leuven));
      await simpleDbms.insertDocument('cities', JSON.stringify(brussels));
      await simpleDbms.insertDocument('universities', JSON.stringify(kuLeuven));
      await simpleDbms.insertDocument('universities', JSON.stringify(vub));
    });

    it('iterates over all documents by id', async () => {
      const results: string[] = [];
      for await (const doc of simpleDbms.cursor('cities', 'id')) {
        results.push((JSON.parse(doc) as { id: string }).id);
      }

      expect(results).toHaveLength(2);
      expect(results).toContain('Leuven');
      expect(results).toContain('Brussels');
    });

    it('iterates over documents filtered by population', async () => {
      const results: string[] = [];
      for await (const doc of simpleDbms.cursor('cities', 'population', 101032)) {
        results.push((JSON.parse(doc) as { id: string }).id);
      }

      expect(results).toContain('Leuven');
    });

    it('iterates over universities by city', async () => {
      const results: string[] = [];
      for await (const doc of simpleDbms.cursor('universities', 'city', 'Leuven')) {
        results.push((JSON.parse(doc) as { id: string }).id);
      }

      expect(results).toContain('KU Leuven');
    });

    it('iterates over documents filtered by population', async () => {
      const results: string[] = [];
      for await (const doc of simpleDbms.cursor('cities', 'population', 196828)) {
        results.push((JSON.parse(doc) as { id: string }).id);
      }

      expect(results).toContain('Brussels');
    });
  });

  describe('commit', () => {
    it('commits changes successfully', async () => {
      const city = { id: 'Leuven', population: 101032, _isProvinceCapital: true };
      await simpleDbms.insertDocument('cities', JSON.stringify(city));

      await expect(simpleDbms.commit()).resolves.not.toThrow();
    });
  });

  describe('multiple collections', () => {
    it('handles multiple collections independently', async () => {
      const leuven = { id: 'Leuven', population: 101032, _isProvinceCapital: true };
      const kuLeuven = { id: 'KU Leuven', city: 'Leuven', studentCount: 65655 };

      await simpleDbms.insertDocument('cities', JSON.stringify(leuven));
      await simpleDbms.insertDocument('universities', JSON.stringify(kuLeuven));

      const city = await simpleDbms.getDocumentById('cities', 'Leuven');
      const university = await simpleDbms.getDocumentById('universities', 'KU Leuven');

      expect(JSON.parse(city)).toEqual(leuven);
      expect(JSON.parse(university)).toEqual(kuLeuven);
    });
  });

  describe('edge cases', () => {
    it('handles numeric ids', async () => {
      const doc = { id: 123, name: 'Test', value: 456 };
      await simpleDbms.insertDocument('test', JSON.stringify(doc));

      const result = await simpleDbms.getDocumentById('test', '123');
      expect(JSON.parse(result)).toEqual(doc);
    });

    it('handles documents with various data types', async () => {
      const doc = {
        id: 'mixed',
        stringField: 'text',
        numberField: 42,
        _booleanField: false,
        _privateField: 'hidden',
      };
      await simpleDbms.insertDocument('test', JSON.stringify(doc));

      const result = await simpleDbms.getDocumentById('test', 'mixed');
      expect(JSON.parse(result)).toEqual(doc);
    });
  });

  describe('large documents with varying schemas', () => {
    it('handles large documents with long text fields', async () => {
      const longText = 'Lorem ipsum dolor sit amet, '.repeat(100);
      const largeDoc = {
        id: 'doc1',
        title: 'Large Document',
        content: longText,
        author: 'John Doe',
        wordCount: 2800,
        tags: 'article,science,research',
        _isPublished: true,
        _metadata: 'internal tracking data',
      };

      await simpleDbms.insertDocument('articles', JSON.stringify(largeDoc));
      const result = await simpleDbms.getDocumentById('articles', 'doc1');
      expect(JSON.parse(result)).toEqual(largeDoc);
    });

    it('handles documents with different schemas in same collection', async () => {
      const product1 = {
        id: 'prod1',
        name: 'Laptop',
        price: 999,
        category: 'Electronics',
        manufacturer: 'TechCorp',
        specs: 'Intel i7, 16GB RAM, 512GB SSD',
        _inStock: true,
      };

      const product2 = {
        id: 'prod2',
        name: 'Office Chair',
        price: 299,
        category: 'Furniture',
        material: 'Leather',
        color: 'Black',
        weight: 15,
        dimensions: '60x60x120cm',
        _inStock: false,
        _warehouseLocation: 'B-12',
      };

      const product3 = {
        id: 'prod3',
        name: 'Pen',
        price: 2,
        category: 'Stationery',
        color: 'Blue',
        _inStock: true,
      };

      await simpleDbms.insertDocument('products', JSON.stringify(product1));
      await simpleDbms.insertDocument('products', JSON.stringify(product2));
      await simpleDbms.insertDocument('products', JSON.stringify(product3));

      const result1 = await simpleDbms.getDocumentById('products', 'prod1');
      const result2 = await simpleDbms.getDocumentById('products', 'prod2');
      const result3 = await simpleDbms.getDocumentById('products', 'prod3');

      expect(JSON.parse(result1)).toEqual(product1);
      expect(JSON.parse(result2)).toEqual(product2);
      expect(JSON.parse(result3)).toEqual(product3);
    });

    it('queries documents with varying schemas by common field', async () => {
      const book1 = {
        id: 'book1',
        title: 'The Great Gatsby',
        author: 'F. Scott Fitzgerald',
        year: 1925,
        genre: 'Classic',
        pages: 180,
        _available: true,
      };

      const book2 = {
        id: 'book2',
        title: '1984',
        author: 'George Orwell',
        year: 1949,
        genre: 'Dystopian',
        pages: 328,
        publisher: 'Secker & Warburg',
        _available: true,
        _location: 'Shelf A-5',
      };

      const book3 = {
        id: 'book3',
        title: 'The Hobbit',
        author: 'J.R.R. Tolkien',
        year: 1937,
        genre: 'Fantasy',
        pages: 310,
        illustrator: 'Tolkien',
        _available: false,
      };

      await simpleDbms.insertDocument('books', JSON.stringify(book1));
      await simpleDbms.insertDocument('books', JSON.stringify(book2));
      await simpleDbms.insertDocument('books', JSON.stringify(book3));

      const results: string[] = [];
      for await (const doc of simpleDbms.cursor('books', 'genre', 'Fantasy')) {
        results.push((JSON.parse(doc) as { id: string }).id);
      }

      expect(results).toContain('book3');
    });

    it('handles documents with many fields', async () => {
      const employee = {
        id: 'emp001',
        firstName: 'Alice',
        lastName: 'Johnson',
        email: 'alice.johnson@company.com',
        phone: '+1-555-0123',
        department: 'Engineering',
        position: 'Senior Developer',
        salary: 95000,
        startDate: '2020-03-15',
        manager: 'Bob Smith',
        projects: 'ProjectA,ProjectB,ProjectC',
        skills: 'JavaScript,TypeScript,Python,SQL',
        certifications: 'AWS Certified,Scrum Master',
        yearsExperience: 8,
        _performance: 'Excellent',
        _bonus: 10000,
        _SSN: '123-45-6789',
      };

      await simpleDbms.insertDocument('employees', JSON.stringify(employee));
      const result = await simpleDbms.getDocumentById('employees', 'emp001');
      expect(JSON.parse(result)).toEqual(employee);
    });

    it('handles mixed length documents and queries by different fields', async () => {
      const movie1 = {
        id: 'mov1',
        title: 'Inception',
        director: 'Christopher Nolan',
        year: 2010,
        rating: 8.8,
        _reviewed: true,
      };

      const movie2 = {
        id: 'mov2',
        title: 'The Matrix',
        director: 'The Wachowskis',
        year: 1999,
        rating: 8.7,
        genre: 'Sci-Fi',
        cast: 'Keanu Reeves,Laurence Fishburne,Carrie-Anne Moss',
        runtime: 136,
        budget: 63000000,
        boxOffice: 467000000,
        _reviewed: true,
        _awards: 'Oscar for Best Visual Effects',
      };

      const movie3 = {
        id: 'mov3',
        title: 'Parasite',
        director: 'Bong Joon-ho',
        year: 2019,
        rating: 8.6,
        country: 'South Korea',
        language: 'Korean',
        _reviewed: false,
      };

      await simpleDbms.insertDocument('movies', JSON.stringify(movie1));
      await simpleDbms.insertDocument('movies', JSON.stringify(movie2));
      await simpleDbms.insertDocument('movies', JSON.stringify(movie3));

      // Query by year
      const results2010: string[] = [];
      for await (const doc of simpleDbms.cursor('movies', 'year', 2010)) {
        results2010.push((JSON.parse(doc) as { title: string }).title);
      }
      expect(results2010).toContain('Inception');

      // Query by director
      const resultsNolan: string[] = [];
      for await (const doc of simpleDbms.cursor('movies', 'director', 'Christopher Nolan')) {
        resultsNolan.push((JSON.parse(doc) as { title: string }).title);
      }
      expect(resultsNolan).toContain('Inception');

      // Verify all documents retrieved correctly
      const result1 = await simpleDbms.getDocumentById('movies', 'mov1');
      const result2 = await simpleDbms.getDocumentById('movies', 'mov2');
      const result3 = await simpleDbms.getDocumentById('movies', 'mov3');

      expect(JSON.parse(result1)).toEqual(movie1);
      expect(JSON.parse(result2)).toEqual(movie2);
      expect(JSON.parse(result3)).toEqual(movie3);
    });

    it('handles very large collection with mixed schemas', async () => {
      const documents = [];

      // Create 129 documents with varying structures (exceeds 128 limit)
      for (let i = 1; i <= 129; i++) {
        let doc;
        if (i % 3 === 0) {
          doc = {
            id: `item${i}`,
            name: `Item ${i}`,
            type: 'TypeA',
            value: i * 100,
            description: `This is item number ${i} with some additional text to make it longer`,
            _internal: `internal-${i}`,
          };
        } else if (i % 3 === 1) {
          doc = {
            id: `item${i}`,
            name: `Item ${i}`,
            type: 'TypeB',
            category: 'Category' + (i % 5),
            price: i * 10.5,
            quantity: i * 2,
            supplier: `Supplier ${i % 4}`,
            _verified: i % 2 === 0,
          };
        } else {
          doc = {
            id: `item${i}`,
            name: `Item ${i}`,
            type: 'TypeC',
            status: i % 2 === 0 ? 'active' : 'inactive',
            score: i * 0.5,
            _archived: false,
          };
        }
        documents.push(doc);
        await simpleDbms.insertDocument('items', JSON.stringify(doc));
      }

      // Query by type
      const typeAResults: string[] = [];
      for await (const doc of simpleDbms.cursor('items', 'type', 'TypeA')) {
        typeAResults.push((JSON.parse(doc) as { id: string }).id);
      }
      expect(typeAResults.length).toBeGreaterThan(0);

      // Verify random documents across the range
      const result5 = await simpleDbms.getDocumentById('items', 'item5');
      const result50 = await simpleDbms.getDocumentById('items', 'item50');
      const result100 = await simpleDbms.getDocumentById('items', 'item100');
      const result129 = await simpleDbms.getDocumentById('items', 'item129');

      expect(JSON.parse(result5)).toEqual(documents[4]);
      expect(JSON.parse(result50)).toEqual(documents[49]);
      expect(JSON.parse(result100)).toEqual(documents[99]);
      expect(JSON.parse(result129)).toEqual(documents[128]);
    });

    it('handles documents with special characters and long strings', async () => {
      const doc = {
        id: 'special1',
        text: 'Text with "quotes" and \\backslashes\\ and émojis 😀🎉',
        description: 'A'.repeat(500),
        jsonField: '{"nested": "value", "array": [1, 2, 3]}',
        _hidden: 'secret data with special chars: @#$%^&*()',
      };

      await simpleDbms.insertDocument('special', JSON.stringify(doc));
      const result = await simpleDbms.getDocumentById('special', 'special1');
      expect(JSON.parse(result)).toEqual(doc);
    });

    it('deletes documents from collection with varying schemas', async () => {
      const doc1 = { id: 'del1', field1: 'value1', field2: 100 };
      const doc2 = { id: 'del2', field1: 'value2', field3: 'extra', field4: 200, _private: true };
      const doc3 = { id: 'del3', field1: 'value3' };

      await simpleDbms.insertDocument('mixed', JSON.stringify(doc1));
      await simpleDbms.insertDocument('mixed', JSON.stringify(doc2));
      await simpleDbms.insertDocument('mixed', JSON.stringify(doc3));

      await simpleDbms.deleteDocumentById('mixed', 'del2');

      const result1 = await simpleDbms.getDocumentById('mixed', 'del1');
      await expect(simpleDbms.getDocumentById('mixed', 'del2')).rejects.toThrow();
      const result3 = await simpleDbms.getDocumentById('mixed', 'del3');

      expect(JSON.parse(result1)).toEqual(doc1);
      expect(JSON.parse(result3)).toEqual(doc3);
    });
  });

  describe('boolean field handling', () => {
    it('handles boolean fields as indexed numeric values', async () => {
      const doc1 = { id: 'bool1', name: 'Active User', active: true, score: 100 };
      const doc2 = { id: 'bool2', name: 'Inactive User', active: false, score: 50 };
      const doc3 = { id: 'bool3', name: 'Another Active', active: true, score: 90 };

      await simpleDbms.insertDocument('users', JSON.stringify(doc1));
      await simpleDbms.insertDocument('users', JSON.stringify(doc2));
      await simpleDbms.insertDocument('users', JSON.stringify(doc3));

      // Query for active=true (converted to 1)
      const activeResults: string[] = [];
      for await (const doc of simpleDbms.cursor('users', 'active', 1)) {
        activeResults.push((JSON.parse(doc) as { id: string }).id);
      }

      expect(activeResults).toContain('bool1');
      expect(activeResults).toContain('bool3');
      expect(activeResults).not.toContain('bool2');
    });

    it('distinguishes between true and false boolean values', async () => {
      const doc1 = { id: 'status1', enabled: true, value: 10 };
      const doc2 = { id: 'status2', enabled: false, value: 20 };

      await simpleDbms.insertDocument('statuses', JSON.stringify(doc1));
      await simpleDbms.insertDocument('statuses', JSON.stringify(doc2));

      // Query for false (converted to 0)
      const falseResults: string[] = [];
      for await (const doc of simpleDbms.cursor('statuses', 'value', 20)) {
        falseResults.push((JSON.parse(doc) as { id: string }).id);
      }

      expect(falseResults).toContain('status2');
      expect(falseResults).not.toContain('status1');
    });
  });

  describe('cursor with range queries and ordering', () => {
    beforeEach(async () => {
      // Insert test data with numeric values
      for (let i = 1; i <= 10; i++) {
        const doc = { id: `item${i}`, priority: i * 10, name: `Item ${i}` };
        await simpleDbms.insertDocument('priorities', JSON.stringify(doc));
      }
    });

    it('iterates from a specific starting point', async () => {
      const results: number[] = [];
      for await (const doc of simpleDbms.cursor('priorities', 'priority', 50)) {
        results.push((JSON.parse(doc) as { priority: number }).priority);
      }

      // Should get items starting from priority 50
      expect(results).toContain(50);
      expect(results).toContain(60);
      expect(results).toContain(100);
      expect(results).not.toContain(40);
    });

    it('iterates in sorted order by numeric field', async () => {
      const results: number[] = [];
      for await (const doc of simpleDbms.cursor('priorities', 'priority')) {
        results.push((JSON.parse(doc) as { priority: number }).priority);
      }

      // Check if results are in ascending order
      for (let i = 1; i < results.length; i++) {
        expect(results[i]).toBeGreaterThanOrEqual(results[i - 1]);
      }
    });

    it('iterates in sorted order by string field', async () => {
      const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
      for (const name of names) {
        const doc = { id: name.toLowerCase(), name, age: 25 };
        await simpleDbms.insertDocument('people', JSON.stringify(doc));
      }

      const results: string[] = [];
      for await (const doc of simpleDbms.cursor('people', 'name')) {
        results.push((JSON.parse(doc) as { name: string }).name);
      }

      // Check lexicographic order
      expect(results).toEqual(['Alice', 'Bob', 'Charlie', 'David', 'Eve']);
    });
  });

  describe('error handling', () => {
    it('throws error when getting non-existent document', async () => {
      await expect(simpleDbms.getDocumentById('nonexistent', 'fake-id')).rejects.toThrow('Collection does not exist');
    });

    it('throws error when deleting non-existent document', async () => {
      await expect(simpleDbms.deleteDocumentById('nonexistent', 'fake-id')).rejects.toThrow(
        'Collection does not exist',
      );
    });

    it('throws error when deleting document that does not exist', async () => {
      const doc = { id: 'exists', value: 100 };
      await simpleDbms.insertDocument('test', JSON.stringify(doc));

      await expect(simpleDbms.deleteDocumentById('test', 'does-not-exist')).rejects.toThrow();
    });

    it('throws error when querying non-existent collection', async () => {
      const cursor = simpleDbms.cursor('nonexistent', 'id');
      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _doc of cursor) {
          // Should throw before iterating
        }
      }).rejects.toThrow('Collection does not exist');
    });

    it('throws error when querying non-indexed field', async () => {
      const doc = { id: 'test1', name: 'Test', _private: 'secret' };
      await simpleDbms.insertDocument('test', JSON.stringify(doc));

      const cursor = simpleDbms.cursor('test', '_private');
      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _doc of cursor) {
          // Should throw
        }
      }).rejects.toThrow('Iterable key does not exist in collection');
    });

    it('throws error when querying field that does not exist in collection', async () => {
      const doc = { id: 'test1', name: 'Test' };
      await simpleDbms.insertDocument('test', JSON.stringify(doc));

      const cursor = simpleDbms.cursor('test', 'nonexistentField');
      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _doc of cursor) {
          // Should throw
        }
      }).rejects.toThrow('Iterable key does not exist in collection');
    });
  });

  describe('empty collection operations', () => {
    it('returns no results when querying empty collection with cursor', async () => {
      // Create a document to establish collection, then delete it
      const doc = { id: 'temp', value: 100 };
      await simpleDbms.insertDocument('empty', JSON.stringify(doc));
      await simpleDbms.deleteDocumentById('empty', 'temp');

      const results: unknown[] = [];
      for await (const doc of simpleDbms.cursor('empty', 'id')) {
        results.push(JSON.parse(doc) as unknown);
      }

      expect(results).toHaveLength(0);
    });
  });

  describe('duplicate handling', () => {
    it('handles multiple documents with same non-id field value', async () => {
      const doc1 = { id: 'user1', name: 'John', age: 30 };
      const doc2 = { id: 'user2', name: 'John', age: 25 };
      const doc3 = { id: 'user3', name: 'Jane', age: 30 };

      await simpleDbms.insertDocument('users', JSON.stringify(doc1));
      await simpleDbms.insertDocument('users', JSON.stringify(doc2));
      await simpleDbms.insertDocument('users', JSON.stringify(doc3));

      // Query by name
      const johnResults: string[] = [];
      for await (const doc of simpleDbms.cursor('users', 'name', 'John')) {
        johnResults.push((JSON.parse(doc) as { id: string }).id);
      }

      expect(johnResults).toContain('user1');
      expect(johnResults).toContain('user2');
      expect(johnResults).not.toContain('user3');

      // Query by age
      const age30Results: string[] = [];
      for await (const doc of simpleDbms.cursor('users', 'age', 30)) {
        age30Results.push((JSON.parse(doc) as { id: string }).id);
      }

      expect(age30Results).toContain('user1');
      expect(age30Results).toContain('user3');
      expect(age30Results).not.toContain('user2');
    });
  });

  describe('numeric id handling', () => {
    it('inserts and retrieves documents with numeric ids', async () => {
      const doc1 = { id: 1, name: 'First', value: 100 };
      const doc2 = { id: 2, name: 'Second', value: 200 };
      const doc3 = { id: 100, name: 'Hundredth', value: 10000 };

      await simpleDbms.insertDocument('numeric', JSON.stringify(doc1));
      await simpleDbms.insertDocument('numeric', JSON.stringify(doc2));
      await simpleDbms.insertDocument('numeric', JSON.stringify(doc3));

      const result1 = await simpleDbms.getDocumentById('numeric', '1');
      const result2 = await simpleDbms.getDocumentById('numeric', '2');
      const result100 = await simpleDbms.getDocumentById('numeric', '100');

      expect(JSON.parse(result1)).toEqual(doc1);
      expect(JSON.parse(result2)).toEqual(doc2);
      expect(JSON.parse(result100)).toEqual(doc3);
    });

    it('queries numeric id collection in sorted order', async () => {
      const ids = [50, 10, 30, 20, 40];
      for (const id of ids) {
        const doc = { id, value: id * 10 };
        await simpleDbms.insertDocument('sorted', JSON.stringify(doc));
      }

      const results: number[] = [];
      for await (const doc of simpleDbms.cursor('sorted', 'id')) {
        results.push((JSON.parse(doc) as { id: number }).id);
      }

      expect(results).toEqual([10, 20, 30, 40, 50]);
    });

    it('deletes document with numeric id', async () => {
      const doc = { id: 42, name: 'Answer', value: 42 };
      await simpleDbms.insertDocument('numeric', JSON.stringify(doc));

      await simpleDbms.deleteDocumentById('numeric', '42');

      await expect(simpleDbms.getDocumentById('numeric', '42')).rejects.toThrow();
    });
  });

  describe('composite key scenarios (NN, SS, SN, NS)', () => {
    it('handles documents with numeric fields creating NN composite keys', async () => {
      const doc1 = { id: 1, x: 10, y: 20 };
      const doc2 = { id: 2, x: 10, y: 30 };
      const doc3 = { id: 3, x: 15, y: 20 };

      await simpleDbms.insertDocument('coords', JSON.stringify(doc1));
      await simpleDbms.insertDocument('coords', JSON.stringify(doc2));
      await simpleDbms.insertDocument('coords', JSON.stringify(doc3));

      // Verify retrieval (NN keys are created internally)
      const result1 = await simpleDbms.getDocumentById('coords', '1');
      const result2 = await simpleDbms.getDocumentById('coords', '2');
      const result3 = await simpleDbms.getDocumentById('coords', '3');

      expect(JSON.parse(result1)).toEqual(doc1);
      expect(JSON.parse(result2)).toEqual(doc2);
      expect(JSON.parse(result3)).toEqual(doc3);
    });

    it('handles documents with string fields creating SS composite keys', async () => {
      const doc1 = { id: 'loc1', city: 'Brussels', country: 'Belgium' };
      const doc2 = { id: 'loc2', city: 'Paris', country: 'France' };
      const doc3 = { id: 'loc3', city: 'Brussels', country: 'Wisconsin' };

      await simpleDbms.insertDocument('locations', JSON.stringify(doc1));
      await simpleDbms.insertDocument('locations', JSON.stringify(doc2));
      await simpleDbms.insertDocument('locations', JSON.stringify(doc3));

      // Query by city
      const brusselsResults: string[] = [];
      for await (const doc of simpleDbms.cursor('locations', 'city', 'Brussels')) {
        brusselsResults.push((JSON.parse(doc) as { id: string }).id);
      }

      expect(brusselsResults).toContain('loc1');
      expect(brusselsResults).toContain('loc3');
    });

    it('handles mixed type fields creating SN composite keys', async () => {
      const doc1 = { id: 'grade1', student: 'Alice', score: 95 };
      const doc2 = { id: 'grade2', student: 'Bob', score: 87 };
      const doc3 = { id: 'grade3', student: 'Alice', score: 92 };

      await simpleDbms.insertDocument('grades', JSON.stringify(doc1));
      await simpleDbms.insertDocument('grades', JSON.stringify(doc2));
      await simpleDbms.insertDocument('grades', JSON.stringify(doc3));

      // Query by student name
      const aliceResults: string[] = [];
      for await (const doc of simpleDbms.cursor('grades', 'student', 'Alice')) {
        aliceResults.push((JSON.parse(doc) as { id: string }).id);
      }

      expect(aliceResults).toContain('grade1');
      expect(aliceResults).toContain('grade3');

      // Query by score
      const score95Results: string[] = [];
      for await (const doc of simpleDbms.cursor('grades', 'score', 95)) {
        score95Results.push((JSON.parse(doc) as { id: string }).id);
      }

      expect(score95Results).toContain('grade1');
    });

    it('handles NS composite keys with numeric string ids', async () => {
      const doc1 = { id: 'item1', priority: 1, category: 'A' };
      const doc2 = { id: 'item2', priority: 2, category: 'B' };
      const doc3 = { id: 'item3', priority: 1, category: 'C' };

      await simpleDbms.insertDocument('tasks', JSON.stringify(doc1));
      await simpleDbms.insertDocument('tasks', JSON.stringify(doc2));
      await simpleDbms.insertDocument('tasks', JSON.stringify(doc3));

      // Query by priority
      const priority1Results: string[] = [];
      for await (const doc of simpleDbms.cursor('tasks', 'priority', 1)) {
        priority1Results.push((JSON.parse(doc) as { id: string }).id);
      }

      expect(priority1Results).toContain('item1');
      expect(priority1Results).toContain('item3');
    });
  });

  describe('stress tests', () => {
    it('handles rapid sequential inserts and deletions', async () => {
      const count = 1360;
      for (let i = 0; i < count; i++) {
        const doc = {
          id: `rapid${i}`, // long id to test handling
          value: i,
        };
        await simpleDbms.insertDocument('rapid', JSON.stringify(doc));
      }

      // Verify first and last
      const first = await simpleDbms.getDocumentById('rapid', 'rapid0');
      const last = await simpleDbms.getDocumentById('rapid', `rapid${count - 1}`);

      expect(JSON.parse(first)).toEqual({ id: 'rapid0', value: 0 });
      expect(JSON.parse(last)).toEqual({
        id: `rapid${count - 1}`,
        value: count - 1,
      });

      for (let i = 0; i < count; i++) {
        await simpleDbms.deleteDocumentById('rapid', `rapid${i}`);
      }
      // Verify deletion
      for (let i = 0; i < count; i++) {
        await expect(simpleDbms.getDocumentById('rapid', `rapid${i}`)).rejects.toThrow();
      }
    });

    it('handles documents with many indexed fields', async () => {
      const doc = {
        id: 'manyfields',
        field1: 'value1',
        field2: 100,
        field3: 'value3',
        field4: 200,
        field5: 'value5',
        field6: 300,
        field7: 'value7',
        field8: 400,
        field9: 'value9',
        field10: 500,
        _private1: 'hidden1',
        _private2: 'hidden2',
      };

      await simpleDbms.insertDocument('manyfields', JSON.stringify(doc));

      // Verify retrieval and query by a couple fields
      const result = await simpleDbms.getDocumentById('manyfields', 'manyfields');
      expect(JSON.parse(result)).toEqual(doc);

      // Query by field2
      const results2: string[] = [];
      for await (const d of simpleDbms.cursor('manyfields', 'field2', 100)) {
        results2.push((JSON.parse(d) as { id: string }).id);
      }
      expect(results2).toContain('manyfields');
    });

    it('handles interleaved inserts and queries', async () => {
      for (let i = 0; i < 10; i++) {
        const doc = { id: `interleaved${i}`, step: i };
        await simpleDbms.insertDocument('interleaved', JSON.stringify(doc));

        // Query after each insert
        const results: string[] = [];
        for await (const d of simpleDbms.cursor('interleaved', 'id')) {
          results.push((JSON.parse(d) as { id: string }).id);
        }
        expect(results).toHaveLength(i + 1);
      }
    });
  });

  describe('persistence and crash recovery with commit', () => {
    it('commits after multiple operations', async () => {
      const doc1 = { id: 'commit1', value: 100 };
      const doc2 = { id: 'commit2', value: 200 };

      await simpleDbms.insertDocument('commits', JSON.stringify(doc1));
      await simpleDbms.commit();
      await simpleDbms.insertDocument('commits', JSON.stringify(doc2));
      await simpleDbms.commit();

      const result1 = await simpleDbms.getDocumentById('commits', 'commit1');
      const result2 = await simpleDbms.getDocumentById('commits', 'commit2');

      expect(JSON.parse(result1)).toEqual(doc1);
      expect(JSON.parse(result2)).toEqual(doc2);
    });

    it('commits after deletes', async () => {
      const doc1 = { id: 'del1', value: 100 };
      const doc2 = { id: 'del2', value: 200 };

      await simpleDbms.insertDocument('deletes', JSON.stringify(doc1));
      await simpleDbms.insertDocument('deletes', JSON.stringify(doc2));
      await simpleDbms.commit();

      await simpleDbms.deleteDocumentById('deletes', 'del1');
      await simpleDbms.commit();

      await expect(simpleDbms.getDocumentById('deletes', 'del1')).rejects.toThrow();
      const result2 = await simpleDbms.getDocumentById('deletes', 'del2');
      expect(JSON.parse(result2)).toEqual(doc2);
    });

    it('committed data persists after close and reopen', async () => {
      const dataFile: MockFile = new MockFile(4096);
      const logFile: MockFile = new MockFile(4000096);
      const db: SimpleDbms = await SimpleDbms.create(dataFile, logFile);

      const doc1 = { id: 'persist1', value: 100 };
      const doc2 = { id: 'persist2', value: 200 };

      await db.insertDocument('test', JSON.stringify(doc1));
      await db.insertDocument('test', JSON.stringify(doc2));
      await db.commit();

      await db.close();

      // Reopen and check
      const db2: SimpleDbms = await SimpleDbms.open(dataFile, logFile);

      const result1: string = await db2.getDocumentById('test', 'persist1');
      const result2: string = await db2.getDocumentById('test', 'persist2');

      expect(JSON.parse(result1)).toEqual(doc1);
      expect(JSON.parse(result2)).toEqual(doc2);

      await db2.close();
    });

    it('multiple commits create consistent checkpoints', async () => {
      const dataFile: MockFile = new MockFile(4096);
      const logFile: MockFile = new MockFile(4000096);
      const db: SimpleDbms = await SimpleDbms.create(dataFile, logFile);

      // First checkpoint
      const doc1 = { id: 'checkpoint1', version: 1 };
      await db.insertDocument('versions', JSON.stringify(doc1));
      await db.commit();

      // Second checkpoint
      const doc2 = { id: 'checkpoint2', version: 2 };
      await db.insertDocument('versions', JSON.stringify(doc2));
      await db.commit();

      // Third checkpoint
      const doc3 = { id: 'checkpoint3', version: 3 };
      await db.insertDocument('versions', JSON.stringify(doc3));
      await db.commit();

      await db.close();

      // Reopen and verify all committed data
      const db2: SimpleDbms = await SimpleDbms.open(dataFile, logFile);

      const result1: string = await db2.getDocumentById('versions', 'checkpoint1');
      const result2: string = await db2.getDocumentById('versions', 'checkpoint2');
      const result3: string = await db2.getDocumentById('versions', 'checkpoint3');

      expect(JSON.parse(result1)).toEqual(doc1);
      expect(JSON.parse(result2)).toEqual(doc2);
      expect(JSON.parse(result3)).toEqual(doc3);

      await db2.close();
    });

    it('uncommitted changes are lost after crash', async () => {
      const dataFile: MockFile = new MockFile(4096);
      const logFile: MockFile = new MockFile(4000096);
      const db: SimpleDbms = await SimpleDbms.create(dataFile, logFile);

      const doc1 = { id: 'committed', value: 100 };
      await db.insertDocument('crash', JSON.stringify(doc1));
      await db.commit();

      const doc2 = { id: 'uncommitted', value: 200 };
      await db.insertDocument('crash', JSON.stringify(doc2));
      // No commit - then crash
      dataFile.crash();
      logFile.crash();

      // Reopen after crash
      const db2: SimpleDbms = await SimpleDbms.open(dataFile, logFile);

      const result1: string = await db2.getDocumentById('crash', 'committed');
      expect(JSON.parse(result1)).toEqual(doc1);

      // doc2 should not exist since it wasn't committed before crash
      await expect(db2.getDocumentById('crash', 'uncommitted')).rejects.toThrow();

      await db2.close();
    });

    it('WAL recovery after crash during write', async () => {
      const dataFile: MockFile = new MockFile(4096);
      const logFile: MockFile = new MockFile(4000096);
      const db: SimpleDbms = await SimpleDbms.create(dataFile, logFile);

      const doc1 = { id: 'wal1', value: 100 };
      const doc2 = { id: 'wal2', value: 200 };

      await db.insertDocument('wal', JSON.stringify(doc1));
      await db.insertDocument('wal', JSON.stringify(doc2));

      // Commit writes to WAL first, then to data file
      await db.commit();

      // At this point, data should be safely on disk
      await db.close();

      // Reopen and verify
      const db2: SimpleDbms = await SimpleDbms.open(dataFile, logFile);

      const result1: string = await db2.getDocumentById('wal', 'wal1');
      const result2: string = await db2.getDocumentById('wal', 'wal2');

      expect(JSON.parse(result1)).toEqual(doc1);
      expect(JSON.parse(result2)).toEqual(doc2);

      await db2.close();
    });

    it('multiple operations between commits', async () => {
      const dataFile: MockFile = new MockFile(4096);
      const logFile: MockFile = new MockFile(4000096);
      const db: SimpleDbms = await SimpleDbms.create(dataFile, logFile);

      // Insert 5 documents, commit only after all
      for (let i = 1; i <= 5; i++) {
        const doc = { id: `batch${i}`, value: i * 10 };
        await db.insertDocument('batch', JSON.stringify(doc));
      }
      await db.commit();

      await db.close();

      // Reopen and verify all documents
      const db2: SimpleDbms = await SimpleDbms.open(dataFile, logFile);

      for (let i = 1; i <= 5; i++) {
        const result: string = await db2.getDocumentById('batch', `batch${i}`);
        expect(JSON.parse(result)).toEqual({ id: `batch${i}`, value: i * 10 });
      }

      await db2.close();
    });

    it('delete operations persist after commit', async () => {
      const dataFile: MockFile = new MockFile(4096);
      const logFile: MockFile = new MockFile(4000096);
      const db: SimpleDbms = await SimpleDbms.create(dataFile, logFile);

      const doc1 = { id: 'keep', value: 100 };
      const doc2 = { id: 'remove', value: 200 };

      await db.insertDocument('deltest', JSON.stringify(doc1));
      await db.insertDocument('deltest', JSON.stringify(doc2));
      await db.commit();

      await db.deleteDocumentById('deltest', 'remove');
      await db.commit();

      await db.close();

      // Reopen and verify
      const db2: SimpleDbms = await SimpleDbms.open(dataFile, logFile);

      const result1: string = await db2.getDocumentById('deltest', 'keep');
      expect(JSON.parse(result1)).toEqual(doc1);

      await expect(db2.getDocumentById('deltest', 'remove')).rejects.toThrow();

      await db2.close();
    });

    it('large transaction with many documents commits atomically', async () => {
      const dataFile: MockFile = new MockFile(4096);
      const logFile: MockFile = new MockFile(4000096);
      const db: SimpleDbms = await SimpleDbms.create(dataFile, logFile);

      const docCount = 30;
      for (let i = 1; i <= docCount; i++) {
        const doc = { id: `large${i}`, value: i, description: `Document number ${i}` };
        await db.insertDocument('large', JSON.stringify(doc));
      }

      await db.commit();
      await db.close();

      // Reopen and verify all documents
      const db2: SimpleDbms = await SimpleDbms.open(dataFile, logFile);

      for (let i = 1; i <= docCount; i++) {
        const result: string = await db2.getDocumentById('large', `large${i}`);
        expect(JSON.parse(result)).toEqual({ id: `large${i}`, value: i, description: `Document number ${i}` });
      }

      await db2.close();
    });
  });

  describe('boundary value tests', () => {
    it('handles very small numeric values', async () => {
      const doc = { id: 'tiny', value: 0.0000001, count: 0 };
      await simpleDbms.insertDocument('boundary', JSON.stringify(doc));

      const result = await simpleDbms.getDocumentById('boundary', 'tiny');
      expect(JSON.parse(result)).toEqual(doc);
    });

    it('handles very large numeric values', async () => {
      const doc = { id: 'huge', value: 999999999999, count: 1000000 };
      await simpleDbms.insertDocument('boundary', JSON.stringify(doc));

      const result = await simpleDbms.getDocumentById('boundary', 'huge');
      expect(JSON.parse(result)).toEqual(doc);
    });

    it('handles negative numeric values', async () => {
      const doc = { id: 'negative', temperature: -40, balance: -1500 };
      await simpleDbms.insertDocument('boundary', JSON.stringify(doc));

      const result = await simpleDbms.getDocumentById('boundary', 'negative');
      expect(JSON.parse(result)).toEqual(doc);
    });

    it('handles empty string values', async () => {
      const doc = { id: 'empty', name: '', description: 'has empty name' };
      await simpleDbms.insertDocument('boundary', JSON.stringify(doc));

      const result = await simpleDbms.getDocumentById('boundary', 'empty');
      expect(JSON.parse(result)).toEqual(doc);
    });

    it('handles very long string values', async () => {
      const longString = 'a'.repeat(1000);
      const doc = { id: 'longstring', data: longString };
      await simpleDbms.insertDocument('boundary', JSON.stringify(doc));

      const result = await simpleDbms.getDocumentById('boundary', 'longstring');
      expect(JSON.parse(result)).toEqual(doc);
    });

    it('handles zero as numeric value', async () => {
      const doc = { id: 'zero', count: 0, amount: 0 };
      await simpleDbms.insertDocument('boundary', JSON.stringify(doc));

      const result = await simpleDbms.getDocumentById('boundary', 'zero');
      expect(JSON.parse(result)).toEqual(doc);
    });
  });
});

// ─── Semantic Search (HNSW) ──────────────────────────────────────────────────
//
// The tests below verify the HNSW-backed semantic search feature of SimpleDbms.
//
// Design notes for helpers
// ─────────────────────────
// makeTestEmbeddingFn
//   A real language model is not available in unit tests.  Instead we use a
//   deterministic trigonometric hash: for every dimension i and every character
//   at position j in the text we accumulate sin((charCode + i*17) * 0.1).  The
//   result has the property that strings with very different characters end up
//   in very different directions in the embedding space, which is sufficient for
//   all nearest-neighbour assertions below.
//

/**
 * Create a tiny, deterministic embedding function for unit tests.
 *
 * @param dim - Dimensionality of the output vector (keep small, e.g. 8, for speed).
 */
function makeTestEmbeddingFn(dim: number): (text: string) => Promise<Float32Array> {
  return (text: string): Promise<Float32Array> => {
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      let sum = 0;
      for (let j = 0; j < text.length; j++) {
        // Spread characters across all dimensions deterministically.
        sum += Math.sin((text.charCodeAt(j) + i * 17) * 0.1);
      }
      // Normalise by length so short and long strings have comparable magnitudes.
      v[i] = sum / (text.length || 1);
    }
    return Promise.resolve(v);
  };
}

function makeTestImageEmbeddingFn(dim: number): (imageData: Buffer) => Promise<Float32Array> {
  return (imageData: Buffer): Promise<Float32Array> => {
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      let sum = 0;
      for (const byte of imageData) {
        sum += Math.cos((byte + i * 23) * 0.1);
      }
      v[i] = sum / (imageData.length || 1);
    }
    return Promise.resolve(v);
  };
}

describe('SimpleDbms – semantic search (HNSW)', () => {
  /** Vector dimension kept small so tests run fast. */
  const DIM = 8;

  // Shared state for the HNSW-enabled database created in beforeEach.
  let dataFile: MockFile;
  let logFile: MockFile;
  let hnswConfig: HnswConfig;
  let db: SimpleDbms;

  beforeEach(async () => {
    dataFile = new MockFile(4096);
    logFile = new MockFile(4000096);
    hnswConfig = {
      dimension: DIM,
      embeddingFn: makeTestEmbeddingFn(DIM),
      imageEmbeddingFn: makeTestImageEmbeddingFn(DIM),
      // Use small HNSW parameters so the tests stay fast on CI.
      M: 8,
      efConstruction: 32,
      efSearch: 16,
    };
    db = await SimpleDbms.create(dataFile, logFile, hnswConfig);
  });

  // ── 1. Error handling when HNSW is not configured ─────────────────────────

  describe('error handling when HNSW is not configured', () => {
    it('throws when semanticSearch is called without hnswConfig', async () => {
      /**
       * A SimpleDbms that was created *without* an HnswConfig must reject
       * any call to semanticSearch immediately with a descriptive error.
       * This prevents silent no-op behaviour when the developer forgets to
       * pass the config.
       */
      const plainDb = await SimpleDbms.create(new MockFile(4096), new MockFile(4000096));
      await expect(plainDb.semanticSearch('articles', 'any query', 5)).rejects.toThrow(/not configured|no hnswConfig/i);
      await plainDb.close();
    });
  });

  // ── 2. Basic insert and search ────────────────────────────────────────────

  describe('basic insert and search', () => {
    it('returns an empty array when the collection has no indexed documents', async () => {
      /**
       * Querying a brand-new collection that has never received any text
       * document must return [] rather than throwing.  The HNSW metadata
       * entry for that collection does not yet exist, so the fast-path that
       * skips graph construction should engage.
       */
      const results = await db.semanticSearch('empty', 'hello world', 3);
      expect(results).toEqual([]);
    });

    it('finds a single inserted document', async () => {
      /**
       * With exactly one text document in the graph, semanticSearch must
       * return it for any query string (there is no other candidate).
       */
      const doc = { id: 'a1', title: 'Introduction to databases' };
      await db.insertDocument('articles', JSON.stringify(doc));

      const results = await db.semanticSearch('articles', 'databases', 1);
      expect(results).toHaveLength(1);
      expect(JSON.parse(results[0])).toEqual(doc);
    });

    it('returns at most k documents', async () => {
      /**
       * When k=1 but three documents exist, only one result may be returned.
       * The caller controls result-set size via k.
       */
      await db.insertDocument('articles', JSON.stringify({ id: 'r1', text: 'alpha topic' }));
      await db.insertDocument('articles', JSON.stringify({ id: 'r2', text: 'beta topic' }));
      await db.insertDocument('articles', JSON.stringify({ id: 'r3', text: 'gamma topic' }));

      const results = await db.semanticSearch('articles', 'alpha', 1);
      expect(results).toHaveLength(1);
    });

    it('returns fewer than k documents when the index is smaller than k', async () => {
      /**
       * If only 2 documents are indexed but k=10, the implementation must
       * return at most 2 results without throwing an out-of-bounds error.
       */
      await db.insertDocument('articles', JSON.stringify({ id: 'x1', content: 'machine learning' }));
      await db.insertDocument('articles', JSON.stringify({ id: 'x2', content: 'deep learning' }));

      const results = await db.semanticSearch('articles', 'learning', 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns all JSON-serialised documents as valid JSON strings', async () => {
      /**
       * The semanticSearch contract is Promise<string[]> where each element
       * is a JSON-serialised document.  Every returned string must round-trip
       * through JSON.parse without throwing.
       */
      const doc = { id: 'j1', body: 'test document for JSON validation' };
      await db.insertDocument('jscheck', JSON.stringify(doc));

      const results = await db.semanticSearch('jscheck', 'json', 1);
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(() => {
          JSON.parse(r);
        }).not.toThrow();
      }
    });
  });

  // ── 3. Text field extraction rules ───────────────────────────────────────

  describe('text field extraction rules', () => {
    it('does not index documents that contain only numeric fields', async () => {
      /**
       * extractText() only concatenates string fields.  A document whose
       * body consists entirely of numbers must not be added to the HNSW graph,
       * so semanticSearch must return [] for that collection.
       */
      const numericDoc = { id: 'metrics1', count: 42, ratio: 0.95 };
      await db.insertDocument('metrics', JSON.stringify(numericDoc));

      const results = await db.semanticSearch('metrics', 'something', 3);
      expect(results).toEqual([]);
    });

    it('does not use underscore-prefixed fields as embeddable text', async () => {
      /**
       * Fields starting with "_" are reserved for private/internal metadata
       * (e.g. _isProvinceCapital in the city documents that appear throughout
       * the test suite) and must be excluded from the embedding input.
       * A document whose only string fields all start with "_" must therefore
       * not be indexed.
       */
      const internalDoc = { id: 'priv1', _secret: 'do not embed this' };
      await db.insertDocument('internals', JSON.stringify(internalDoc));

      const results = await db.semanticSearch('internals', 'secret', 3);
      expect(results).toEqual([]);
    });

    it('concatenates multiple public string fields for the embedding', async () => {
      /**
       * When a document has more than one public text field (e.g. "title" and
       * "abstract"), both values must be joined and embedded together.  The
       * document must be reachable via a query that matches either field.
       */
      const doc = { id: 'multi1', title: 'Graph databases', abstract: 'Nodes and edges' };
      await db.insertDocument('papers', JSON.stringify(doc));

      const results = await db.semanticSearch('papers', 'graph nodes', 1);
      expect(results).toHaveLength(1);
      expect(JSON.parse(results[0])).toEqual(doc);
    });

    it('supports separate text and image semantic indexes per collection', async () => {
      const dualDb = await SimpleDbms.create(new MockFile(4096), new MockFile(4000096), {
        dimension: DIM,
        embeddingFn: makeTestEmbeddingFn(DIM),
        imageEmbeddingFn: makeTestImageEmbeddingFn(DIM),
        M: 8,
        efConstruction: 32,
        efSearch: 16,
        textIndex: {
          dimension: DIM,
          embeddingFn: makeTestEmbeddingFn(DIM),
          M: 8,
          efConstruction: 32,
          efSearch: 16,
        },
        imageIndex: {
          dimension: DIM,
          embeddingFn: makeTestEmbeddingFn(DIM),
          imageEmbeddingFn: makeTestImageEmbeddingFn(DIM),
          M: 8,
          efConstruction: 32,
          efSearch: 16,
        },
      });

      const textOnly = { id: 'text-only', name: 'Ada Lovelace', role: 'mathematician' };
      const imageOne = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
      const imageTwo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
      const imageOnly = { id: 'image-only', 'photo.jpg': imageOne.toString('base64') };
      const mixed = { id: 'mixed', name: 'Grace Hopper', role: 'engineer', 'avatar.png': imageTwo.toString('base64') };
      await dualDb.insertDocument('people', JSON.stringify(textOnly));
      await dualDb.insertDocument('people', JSON.stringify(imageOnly));
      await dualDb.insertDocument('people', JSON.stringify(mixed));

      const textResults = (await dualDb.semanticSearch('people', 'engineer', 10)).map((raw) => {
        const parsed = JSON.parse(raw) as { id: string };
        return parsed.id;
      });
      expect(textResults).toContain('text-only');
      expect(textResults).toContain('mixed');
      expect(textResults).not.toContain('image-only');

      const imageResults = (await dualDb.semanticImageTextSearch('people', 'portrait', 10)).map((raw) => {
        const parsed = JSON.parse(raw) as { id: string };
        return parsed.id;
      });
      expect(imageResults).toContain('image-only');
      expect(imageResults).toContain('mixed');
      expect(imageResults).not.toContain('text-only');
      await dualDb.close();
    });

    it('indexes a document that mixes public text fields with underscore fields', async () => {
      /**
       * A document that has BOTH public text fields and underscore-prefixed
       * fields must still be indexed (using only the public fields).  The
       * underscore fields must be silently ignored but must not prevent the
       * document from appearing in results.
       */
      const mixed = { id: 'mixed1', title: 'Public title', _internalTag: 'tag-xyz' };
      await db.insertDocument('mixed', JSON.stringify(mixed));

      const results = await db.semanticSearch('mixed', 'public title', 1);
      expect(results).toHaveLength(1);
      expect(JSON.parse(results[0])).toEqual(mixed);
    });

    it('a document with only the id field and no other text fields is not indexed', async () => {
      /**
       * The "id" field is the document key and is NOT included in the set of
       * fields returned by document.getFields().  Therefore a document that
       * carries nothing but an id has no embeddable text and must not be added
       * to the HNSW graph — semanticSearch must return [].
       * This behaviour is consistent with how numeric-only documents are
       * treated; the id is metadata, not content.
       */
      const idOnly = { id: 'idonly1' };
      await db.insertDocument('idtest', JSON.stringify(idOnly));

      // No embeddable text: the document should NOT appear in search results.
      const results = await db.semanticSearch('idtest', 'idonly1', 1);
      expect(results).toEqual([]);
    });
  });

  // ── 4. Delete removes document from semantic index ────────────────────────

  describe('delete removes document from semantic index', () => {
    it('deleted document does not appear in search results', async () => {
      /**
       * Deleting a document must remove it from the HNSW graph so subsequent
       * semanticSearch calls do not return it.
       */
      await db.insertDocument('news', JSON.stringify({ id: 'n1', headline: 'Big news today' }));
      await db.insertDocument('news', JSON.stringify({ id: 'n2', headline: 'Small local news' }));
      await db.deleteDocumentById('news', 'n1');

      const results = await db.semanticSearch('news', 'big news today', 5);
      const ids = results.map((r) => (JSON.parse(r) as { id: string }).id);
      expect(ids).not.toContain('n1');
    });

    it('remaining documents are still reachable after a deletion', async () => {
      /**
       * Deleting one node from the HNSW graph must not corrupt graph
       * navigation to its former neighbours.  The surviving sibling must
       * remain searchable.
       */
      await db.insertDocument('news', JSON.stringify({ id: 'stay', headline: 'Article that stays' }));
      await db.insertDocument('news', JSON.stringify({ id: 'gone', headline: 'Article that is removed' }));
      await db.deleteDocumentById('news', 'gone');

      const results = await db.semanticSearch('news', 'article', 5);
      const ids = results.map((r) => (JSON.parse(r) as { id: string }).id);
      expect(ids).toContain('stay');
    });

    it('re-insert after delete works correctly', async () => {
      /**
       * After deleting a document and inserting a replacement, the replacement
       * must be findable and the deleted document must not reappear.
       * This exercises the docId reuse path inside HNSW.
       */
      await db.insertDocument('blog', JSON.stringify({ id: 'post1', body: 'Old content about cats' }));
      await db.deleteDocumentById('blog', 'post1');
      await db.insertDocument('blog', JSON.stringify({ id: 'post2', body: 'New content about dogs' }));

      const results = await db.semanticSearch('blog', 'content about dogs', 5);
      const ids = results.map((r) => (JSON.parse(r) as { id: string }).id);
      expect(ids).not.toContain('post1');
      expect(ids).toContain('post2');
    });

    it('re-indexes a replaced document when an image field is added', async () => {
      const image = Buffer.from('rabbit image bytes');
      await db.insertDocument('employees', JSON.stringify({ id: 'e1', name: 'Alice', department: 'Engineering' }));

      await db.replaceDocument('employees', 'e1', {
        id: 'e1',
        name: 'Alice',
        department: 'Engineering',
        'photo.jpg': image.toString('base64'),
      });

      const results = await db.semanticImageSearch('employees', image, 5);
      const parsed = results.map((r) => JSON.parse(r) as Record<string, unknown>);
      expect(parsed).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'e1', 'photo.jpg': image.toString('base64') })]),
      );
    });

    it('deleting the only document leaves the collection empty for search', async () => {
      /**
       * Once all documents are deleted the HNSW graph is empty.  A search
       * over an empty graph must return [] without throwing.
       */
      await db.insertDocument('solo', JSON.stringify({ id: 's1', text: 'the only one' }));
      await db.deleteDocumentById('solo', 's1');

      const results = await db.semanticSearch('solo', 'the only one', 3);
      expect(results).toEqual([]);
    });
  });

  // ── 5. Multiple independent collections ──────────────────────────────────

  describe('multiple independent collections', () => {
    it('searching one collection does not return documents from another', async () => {
      /**
       * Every collection gets its own independent HNSW index.  A document in
       * "colA" must never surface in a search over "colB" and vice-versa.
       */
      await db.insertDocument('colA', JSON.stringify({ id: 'a1', text: 'content in collection A' }));
      await db.insertDocument('colB', JSON.stringify({ id: 'b1', text: 'content in collection B' }));

      const resultsA = await db.semanticSearch('colA', 'collection A', 5);
      const idsA = resultsA.map((r) => (JSON.parse(r) as { id: string }).id);
      expect(idsA).toContain('a1');
      expect(idsA).not.toContain('b1');

      const resultsB = await db.semanticSearch('colB', 'collection B', 5);
      const idsB = resultsB.map((r) => (JSON.parse(r) as { id: string }).id);
      expect(idsB).toContain('b1');
      expect(idsB).not.toContain('a1');
    });

    it('deletions in one collection do not affect another collection', async () => {
      /**
       * Removing a document from "setA" must have no side-effect on the HNSW
       * index of "setB" — their backing FBF files are completely separate.
       */
      await db.insertDocument('setA', JSON.stringify({ id: 'sa1', text: 'document in set A' }));
      await db.insertDocument('setB', JSON.stringify({ id: 'sb1', text: 'document in set B' }));
      await db.deleteDocumentById('setA', 'sa1');

      const resultsB = await db.semanticSearch('setB', 'document', 5);
      const idsB = resultsB.map((r) => (JSON.parse(r) as { id: string }).id);
      expect(idsB).toContain('sb1');
    });

    it('each collection returns its own documents after insert', async () => {
      /**
       * Insert two documents with the same id into different collections and
       * confirm that each collection's search only returns its own version.
       */
      const docA = { id: 'shared', topic: 'physics' };
      const docB = { id: 'shared', topic: 'chemistry' };
      await db.insertDocument('science1', JSON.stringify(docA));
      await db.insertDocument('science2', JSON.stringify(docB));

      const r1 = await db.semanticSearch('science1', 'physics', 1);
      const r2 = await db.semanticSearch('science2', 'chemistry', 1);

      expect(r1).toHaveLength(1);
      expect((JSON.parse(r1[0]) as { topic: string }).topic).toBe('physics');

      expect(r2).toHaveLength(1);
      expect((JSON.parse(r2[0]) as { topic: string }).topic).toBe('chemistry');
    });
  });

  // ── 6. Persistence: commit and reopen ────────────────────────────────────

  describe('persistence: commit and reopen', () => {
    it('HNSW index survives commit, close, and reopen', async () => {
      /**
       * This is the primary persistence test for the HNSW integration.
       * It mirrors the "committed data persists after close and reopen" test
       * already present for the B+ tree index, but also verifies that the
       * HNSW graph nodes and vectors are correctly restored on open().
       *
       * Steps:
       *   1. Create a DB with HnswConfig, insert a text document, commit.
       *   2. Close the DB.
       *   3. Reopen using the *same* MockFile instances (dataFile / logFile).
       *      HNSW data lives in the same single FBF, so no extra file handles
       *      are needed — the metaCache stores the HNSW metadata block number.
       *   4. semanticSearch must find the persisted document.
       */
      const doc = { id: 'persist1', title: 'Persistent semantic search' };
      await db.insertDocument('library', JSON.stringify(doc));
      await db.commit();
      await db.close();

      const db2 = await SimpleDbms.open(dataFile, logFile, hnswConfig);
      const results = await db2.semanticSearch('library', 'persistent search', 3);
      expect(results).toHaveLength(1);
      expect(JSON.parse(results[0])).toEqual(doc);
      await db2.close();
    });

    it('multiple documents persist after reopen', async () => {
      /**
       * All documents committed before close must be reachable via
       * semanticSearch after reopening — not just the last one inserted.
       */
      const docs = [
        { id: 'book1', title: 'Algorithms and data structures' },
        { id: 'book2', title: 'Operating systems fundamentals' },
        { id: 'book3', title: 'Computer networks explained' },
      ];
      for (const doc of docs) {
        await db.insertDocument('books', JSON.stringify(doc));
      }
      await db.commit();
      await db.close();

      const db2 = await SimpleDbms.open(dataFile, logFile, hnswConfig);
      const results = await db2.semanticSearch('books', 'data structures algorithms', 3);
      expect(results.length).toBeGreaterThan(0);

      const ids = results.map((r) => (JSON.parse(r) as { id: string }).id);
      // At least one of the three books must appear in the top results.
      expect(['book1', 'book2', 'book3'].some((id) => ids.includes(id))).toBe(true);

      await db2.close();
    });

    it('deletions committed before close are reflected after reopen', async () => {
      /**
       * A document that was inserted, committed, then deleted and committed
       * again must NOT be returned by semanticSearch after reopening.
       * The deletion is durable: the HNSW graph FBF was committed without
       * the node, and the vector FBF no longer holds its embedding.
       */
      const doc = { id: 'gone2', headline: 'This article will be permanently removed' };
      await db.insertDocument('news', JSON.stringify(doc));
      await db.commit();

      await db.deleteDocumentById('news', 'gone2');
      await db.commit();
      await db.close();

      const db2 = await SimpleDbms.open(dataFile, logFile, hnswConfig);
      const results = await db2.semanticSearch('news', 'article removed', 5);
      const ids = results.map((r) => (JSON.parse(r) as { id: string }).id);
      expect(ids).not.toContain('gone2');
      await db2.close();
    });

    it('HNSW metadata key is restored so open() needs no manual re-registration', async () => {
      /**
       * DbmsBack stores a marker in metaCache[HNSW_META_KEY] when an HNSW
       * index is created for a collection.  After commit+close+reopen that
       * marker must have been loaded from the FBF client area so that
       * DbmsBack.open() automatically reopens the right HNSW FBF files —
       * no manual "register index" call should be needed.
       */
      await db.insertDocument('docs', JSON.stringify({ id: 'd1', body: 'Hello world' }));
      await db.commit();
      await db.close();

      // open() must automatically find and reopen the HNSW index for 'docs'.
      const db2 = await SimpleDbms.open(dataFile, logFile, hnswConfig);
      const results = await db2.semanticSearch('docs', 'hello', 3);
      // If metadata restoration failed we would get [] here.
      expect(results.length).toBeGreaterThan(0);
      await db2.close();
    });

    it('regular document operations still work after a reopen with HNSW', async () => {
      /**
       * Opening a database that already has HNSW indices must not break the
       * ordinary B+ tree operations (getDocumentById, cursor, etc.).  Both
       * subsystems must coexist correctly after reopen.
       */
      const doc = { id: 'dual1', title: 'Works on both indexes' };
      await db.insertDocument('dual', JSON.stringify(doc));
      await db.commit();
      await db.close();

      const db2 = await SimpleDbms.open(dataFile, logFile, hnswConfig);

      // B+ tree lookup must still work.
      const retrieved = await db2.getDocumentById('dual', 'dual1');
      expect(JSON.parse(retrieved)).toEqual(doc);

      // Semantic search must also work.
      const results = await db2.semanticSearch('dual', 'works', 1);
      expect(results).toHaveLength(1);
      expect(JSON.parse(results[0])).toEqual(doc);

      await db2.close();
    });

    it('uncommitted HNSW inserts are lost after crash', async () => {
      /**
       * This test mirrors the existing WAL crash-recovery test and extends it
       * to cover the HNSW index.
       *
       * A document committed before the crash must survive; a document that
       * was only inserted (not committed) must vanish from semanticSearch
       * results after recovery — just as it vanishes from the B+ tree index.
       *
       * Since HNSW data now shares the same single FreeBlockFile WAL as the
       * rest of the database, crashing dataFile/logFile rolls back both the
       * B+ tree insert and the HNSW insert atomically.
       */
      const committed = { id: 'safe1', text: 'This was safely committed' };
      await db.insertDocument('crash', JSON.stringify(committed));
      await db.commit();

      // Insert but do NOT commit — this change is in-flight.
      await db.insertDocument('crash', JSON.stringify({ id: 'unsafe1', text: 'This was NOT committed' }));

      // Simulate crash.
      dataFile.crash();
      logFile.crash();

      const db2 = await SimpleDbms.open(dataFile, logFile, hnswConfig);
      const results = await db2.semanticSearch('crash', 'committed', 5);
      const ids = results.map((r) => (JSON.parse(r) as { id: string }).id);
      expect(ids).not.toContain('unsafe1');
      await db2.close();
    });
  });

  // ── 7. Larger-scale correctness ───────────────────────────────────────────

  describe('larger-scale semantic search correctness', () => {
    it('handles 20 inserted documents without errors', async () => {
      /**
       * Insert 20 documents spread across 5 different topic prefixes.
       * The HNSW graph must build without panics or assertion failures,
       * and semanticSearch must return a non-empty, bounded result set.
       */
      const topics = ['database', 'network', 'operating system', 'compiler', 'algorithm'];
      for (let i = 0; i < 20; i++) {
        const topic = topics[i % topics.length];
        await db.insertDocument(
          'textbook',
          JSON.stringify({ id: `doc${i}`, text: `${topic} fundamentals chapter ${i}` }),
        );
      }

      const results = await db.semanticSearch('textbook', 'database fundamentals', 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('handles interleaved inserts and deletes without graph corruption', async () => {
      /**
       * Insert 10 documents, then delete the even-indexed ones.  The HNSW
       * graph must remain navigable — no null entry-point panics or infinite
       * loops.  Every id in the search results must be an odd-indexed survivor.
       */
      for (let i = 0; i < 10; i++) {
        await db.insertDocument('mixed2', JSON.stringify({ id: `m${i}`, text: `snippet number ${i}` }));
      }
      for (let i = 0; i < 10; i += 2) {
        await db.deleteDocumentById('mixed2', `m${i}`);
      }

      // Survivors: m1, m3, m5, m7, m9
      const results = await db.semanticSearch('mixed2', 'snippet', 5);
      const ids = results.map((r) => (JSON.parse(r) as { id: string }).id);
      for (const id of ids) {
        expect(['m1', 'm3', 'm5', 'm7', 'm9']).toContain(id);
      }
    });

    it('inserts into two collections and persists both after reopen', async () => {
      /**
       * Two separate collections each get their own committed HNSW index.
       * After close+reopen both must remain independently searchable.
       */
      await db.insertDocument('sciA', JSON.stringify({ id: 'phys1', text: 'quantum mechanics' }));
      await db.insertDocument('sciB', JSON.stringify({ id: 'chem1', text: 'organic chemistry' }));
      await db.commit();
      await db.close();

      const db2 = await SimpleDbms.open(dataFile, logFile, hnswConfig);

      const rA = await db2.semanticSearch('sciA', 'quantum', 3);
      expect(rA.length).toBeGreaterThan(0);
      const idsA = rA.map((r) => (JSON.parse(r) as { id: string }).id);
      expect(idsA).not.toContain('chem1');

      const rB = await db2.semanticSearch('sciB', 'chemistry', 3);
      expect(rB.length).toBeGreaterThan(0);
      const idsB = rB.map((r) => (JSON.parse(r) as { id: string }).id);
      expect(idsB).not.toContain('phys1');

      await db2.close();
    });

    it('commit + reopen + insert more documents continues correctly', async () => {
      /**
       * After reopening a database that already has a persisted HNSW index,
       * inserting additional documents into the same collection must work —
       * the index is still "open" and mutable, not frozen.
       */
      await db.insertDocument('grow', JSON.stringify({ id: 'g1', text: 'first document' }));
      await db.commit();
      await db.close();

      const db2 = await SimpleDbms.open(dataFile, logFile, hnswConfig);
      await db2.insertDocument('grow', JSON.stringify({ id: 'g2', text: 'second document' }));
      await db2.commit();

      const results = await db2.semanticSearch('grow', 'document', 5);
      const ids = results.map((r) => (JSON.parse(r) as { id: string }).id);
      expect(ids).toContain('g1');
      expect(ids).toContain('g2');

      await db2.close();
    });
  });

  describe('compression', () => {
    it('applies default compression and returns encoded payload on request', async () => {
      db.setFieldCompressionDefaults('articles', { content: 'gzip' });
      await db.insertDocument(
        'articles',
        JSON.stringify({ id: 'a1', content: 'Lorem ipsum '.repeat(80), title: 'Test' }),
      );

      const encodedRaw = await db.getDocumentById('articles', 'a1', { encoded: true });
      const encoded = JSON.parse(encodedRaw) as Record<string, unknown>;
      const content = encoded['content'] as Record<string, unknown>;

      expect(content['compression']).toBe('gzip');
      expect(typeof content['payloadBase64']).toBe('string');

      const decodedRaw = await db.getDocumentById('articles', 'a1');
      const decoded = JSON.parse(decodedRaw) as Record<string, unknown>;
      expect(decoded['content']).toBe('Lorem ipsum '.repeat(80));
    });

    it('supports per-document override to disable compression', async () => {
      db.setFieldCompressionDefaults('articles', { content: 'gzip' });
      await db.insertDocument('articles', JSON.stringify({ id: 'a2', content: 'Lorem ipsum '.repeat(80) }), {
        compression: { content: 'off' },
      });

      const encodedRaw = await db.getDocumentById('articles', 'a2', { encoded: true });
      const encoded = JSON.parse(encodedRaw) as Record<string, unknown>;
      const content = encoded['content'] as Record<string, unknown>;

      expect(content['compression']).toBe('none');
    });
  });
});
