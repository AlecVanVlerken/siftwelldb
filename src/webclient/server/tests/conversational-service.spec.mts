import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { SimpleDbms } from '../../../database/simpledbms.mjs';
import type { SemanticModel } from '../../../conversational/semanticModel.mjs';
import { ConversationalService } from '../conversational-service.mjs';

describe('ConversationalService database lifecycle', () => {
  let directory: string;
  const databases: SimpleDbms[] = [];

  beforeEach(async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    directory = await mkdtemp(join(tmpdir(), 'simpledbms-conversational-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const db of databases.splice(0)) await db.close();
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected temporary directory');
    await rm(target, { recursive: true, force: true });
  });

  async function createDb(collections: string[] = ['employees', 'departments']): Promise<SimpleDbms> {
    const db = await SimpleDbms.create(new MockFile(4096), new MockFile(4096));
    databases.push(db);
    for (const collection of collections) {
      await db.insertDocumentObject(collection, { id: '1', name: collection, salary: 100 });
    }
    await db.commit();
    return db;
  }

  it('generates and reloads models without an API key while leaving chat unavailable', async () => {
    const db = await createDb();
    const dbPath = join(directory, 'data.db');
    const service = new ConversationalService();
    await service.onConnect(dbPath, db);

    const { model, enriched } = await service.generateModel();
    expect(model.explores.map((explore) => explore.collection)).toEqual(['employees', 'departments']);
    expect(enriched).toBe(false);
    expect(service.llmAvailable).toBe(false);
    expect(service.engineReady).toBe(false);
    expect(JSON.parse(await readFile(`${dbPath}.model.json`, 'utf-8'))).toEqual(model);
    await expect(service.ask('How many employees?', [], 'employees')).rejects.toThrow(/GEMINI_API_KEY/);

    service.onDisconnect();
    await service.onConnect(dbPath, db);
    expect(service.getModel()).toEqual(model);
    expect(service.hasExploreForCollection('departments')).toBe(true);
  });

  it('rebuilds readiness when a key is added or removed and clears it on disconnect', async () => {
    const service = new ConversationalService();
    await service.onConnect(join(directory, 'data.db'), await createDb());
    await service.generateModel();
    service.setApiKey('configured-for-readiness-only');
    expect(service.llmAvailable).toBe(true);
    expect(service.engineReady).toBe(true);
    service.setApiKey('   ');
    expect(service.llmAvailable).toBe(false);
    expect(service.engineReady).toBe(false);
    service.onDisconnect();
    expect(service.getModel()).toBeNull();
    expect(service.hasExploreForCollection('employees')).toBe(false);
  });

  it('rejects invalid models and missing collections without replacing the saved model', async () => {
    const db = await createDb();
    const dbPath = join(directory, 'data.db');
    const service = new ConversationalService();
    await service.onConnect(dbPath, db);
    const { model } = await service.generateModel();
    const previousFile = await readFile(`${dbPath}.model.json`, 'utf-8');

    await expect(service.saveModel('{')).rejects.toThrow();
    const invalid = structuredClone(model);
    invalid.explores[0].collection = 'deleted_collection';
    await expect(service.saveModel(JSON.stringify(invalid))).rejects.toThrow(/does not exist/);
    expect(service.getModel()).toEqual(model);
    expect(await readFile(`${dbPath}.model.json`, 'utf-8')).toBe(previousFile);
  });

  it('does not persist an invalid empty model for a database without collections', async () => {
    const dbPath = join(directory, 'empty.db');
    const service = new ConversationalService();
    await service.onConnect(dbPath, await createDb([]));
    await expect(service.generateModel()).rejects.toThrow(/Add a collection/);
    expect(service.getModel()).toBeNull();
    await expect(access(`${dbPath}.model.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not restore a loaded model after disconnecting during a connection', async () => {
    const db = await createDb();
    const dbPath = join(directory, 'data.db');
    const service = new ConversationalService();
    const saved: SemanticModel = {
      explores: [
        { collection: 'employees', label: 'Employees', fields: [{ name: 'id', type: 'string', label: 'ID' }] },
      ],
    };
    await writeFile(`${dbPath}.model.json`, JSON.stringify(saved), 'utf-8');
    const connecting = service.onConnect(dbPath, db);
    service.onDisconnect();
    await connecting;
    expect(service.getModel()).toBeNull();
    expect(service.engineReady).toBe(false);
    await expect(service.generateModel()).rejects.toThrow(/No database connected/);
  });

  it('prunes only dropped collections and removes the sidecar after the last collection', async () => {
    const db = await createDb();
    const dbPath = join(directory, 'data.db');
    const service = new ConversationalService();
    await service.onConnect(dbPath, db);
    await service.generateModel();
    await db.deleteCollection('employees');
    await service.removeCollection('employees');
    expect(service.getModel()?.explores.map((explore) => explore.collection)).toEqual(['departments']);
    const saved = JSON.parse(await readFile(`${dbPath}.model.json`, 'utf-8')) as SemanticModel;
    expect(saved.explores.map((explore) => explore.collection)).toEqual(['departments']);
    await db.deleteCollection('departments');
    await service.removeCollection('departments');
    expect(service.getModel()).toBeNull();
    expect(service.engineReady).toBe(false);
    await expect(access(`${dbPath}.model.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    await service.onConnect(dbPath, db);
    expect(service.getModel()).toBeNull();
  });

  it('does not install or persist a late generated model after switching databases', async () => {
    const first = await createDb(['employees']);
    const second = await createDb(['departments']);
    const service = new ConversationalService();
    const firstPath = join(directory, 'first.db');
    const secondPath = join(directory, 'second.db');
    await service.onConnect(firstPath, first);

    const paused = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    vi.spyOn(first, 'cursor').mockImplementationOnce(async function* () {
      started.resolve();
      await paused.promise;
      yield JSON.stringify({ id: '1', name: 'Employee' });
    });
    const pending = service.generateModel();
    await started.promise;
    await service.onConnect(secondPath, second);
    const current = await service.generateModel();
    paused.resolve();
    await expect(pending).rejects.toThrow(/database connection changed/);

    expect(service.getModel()).toEqual(current.model);
    const persisted = JSON.parse(await readFile(`${secondPath}.model.json`, 'utf-8')) as SemanticModel;
    expect(persisted.explores.map((explore) => explore.collection)).toEqual(['departments']);
    await expect(access(`${firstPath}.model.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
