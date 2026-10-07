// @author: Alec Van Vlerken
// @date: 2026-04-24

import assert from 'assert';
import { describe, it, beforeEach } from 'vitest';

import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { DbmsBack } from '../../../database/dbmsback.mjs';
import { JSONtoDocument } from '../../../database/document.mjs';
import { CollectionCatalog } from '../collectioncatalog.mjs';
import { VacuumValidator } from '../vacuumvalidator.mjs';

//
// Test setup helpers
//
async function makeDbmsBack(): Promise<DbmsBack> {
  const data = new MockFile(4096);
  const log = new MockFile(4096);
  const db = new DbmsBack(data, log);
  await db.create();
  return db;
}

describe('vacuumvalidator.mjs', () => {
  let source: DbmsBack;
  let target: DbmsBack;

  beforeEach(async () => {
    source = await makeDbmsBack();
    target = await makeDbmsBack();
  });

  // ---------------------------------------------------------
  // validate()
  // ---------------------------------------------------------
  it('passes when source and target match', async () => {
    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'hello',
        }),
        'articles',
      ),
    );

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '2',
          title: 'world',
        }),
        'articles',
      ),
    );

    await source.commit();

    await target.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'hello',
        }),
        'articles',
      ),
    );

    await target.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '2',
          title: 'world',
        }),
        'articles',
      ),
    );

    await target.commit();

    const validator = new VacuumValidator(source, target, new CollectionCatalog(source));

    await validator.validate();
  });

  it('passes for metadata-only collection without id tree', async () => {
    source.setFieldCompressionDefaults('articles', { title: 'gzip' });
    target.setFieldCompressionDefaults('articles', { title: 'gzip' });

    await source.commit();
    await target.commit();

    const validator = new VacuumValidator(source, target, new CollectionCatalog(source));

    await validator.validate();
  });

  it('rejects when target is missing a source collection', async () => {
    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'hello',
        }),
        'articles',
      ),
    );

    await source.commit();
    await target.commit();

    const validator = new VacuumValidator(source, target, new CollectionCatalog(source));

    await assert.rejects(() => validator.validate());
  });

  it('rejects when source and target document counts differ', async () => {
    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'hello',
        }),
        'articles',
      ),
    );

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '2',
          title: 'world',
        }),
        'articles',
      ),
    );

    await source.commit();

    await target.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'hello',
        }),
        'articles',
      ),
    );

    await target.commit();

    const validator = new VacuumValidator(source, target, new CollectionCatalog(source));

    await assert.rejects(() => validator.validate());
  });

  it('rejects when a source document id is missing in the target', async () => {
    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'hello',
        }),
        'articles',
      ),
    );

    await source.commit();

    await target.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '2',
          title: 'other',
        }),
        'articles',
      ),
    );

    await target.commit();

    const validator = new VacuumValidator(source, target, new CollectionCatalog(source));

    await assert.rejects(() => validator.validate());
  });

  it('rejects when a target document has the same id but different contents', async () => {
    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'source',
        }),
        'articles',
      ),
    );

    await source.commit();

    await target.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'target',
        }),
        'articles',
      ),
    );

    await target.commit();

    const validator = new VacuumValidator(source, target, new CollectionCatalog(source));

    await assert.rejects(() => validator.validate());
  });

  it('rejects when compression defaults differ', async () => {
    source.setFieldCompressionDefaults('articles', { title: 'gzip' });
    target.setFieldCompressionDefaults('articles', { title: 'deflate' });

    await source.commit();
    await target.commit();

    const validator = new VacuumValidator(source, target, new CollectionCatalog(source));

    await assert.rejects(() => validator.validate());
  });

  it('rejects when source has an id tree but target does not', async () => {
    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'hello',
        }),
        'articles',
      ),
    );

    await source.commit();

    target.setFieldCompressionDefaults('articles', { title: 'gzip' });
    await target.commit();

    const validator = new VacuumValidator(source, target, new CollectionCatalog(source));

    await assert.rejects(() => validator.validate());
  });

  it('rejects when target has an id tree but source does not', async () => {
    source.setFieldCompressionDefaults('articles', { title: 'gzip' });
    await source.commit();

    await target.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'hello',
        }),
        'articles',
      ),
    );

    await target.commit();

    const validator = new VacuumValidator(source, target, new CollectionCatalog(source));

    await assert.rejects(() => validator.validate());
  });

  it('passes when both source and target have the same empty metadata-only collection', async () => {
    source.setFieldCompressionDefaults('articles', { title: 'gzip' });
    source.setFieldCompressionDefaults('users', { name: 'deflate' });

    target.setFieldCompressionDefaults('articles', { title: 'gzip' });
    target.setFieldCompressionDefaults('users', { name: 'deflate' });

    await source.commit();
    await target.commit();

    const validator = new VacuumValidator(source, target, new CollectionCatalog(source));

    await validator.validate();
  });

  it('passes when multiple collections match', async () => {
    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'a',
        }),
        'articles',
      ),
    );

    await source.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '2',
          name: 'b',
        }),
        'users',
      ),
    );

    await source.commit();

    await target.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '1',
          title: 'a',
        }),
        'articles',
      ),
    );

    await target.insertDocument(
      JSONtoDocument(
        JSON.stringify({
          id: '2',
          name: 'b',
        }),
        'users',
      ),
    );

    await target.commit();

    const validator = new VacuumValidator(source, target, new CollectionCatalog(source));

    await validator.validate();
  });
});
