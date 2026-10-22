import { describe, expect, it, vi } from 'vitest';
import { DatabasePicker, databaseFilename, databaseNameFromPath, type DatabaseCatalog } from '../database-picker.js';

const catalog = {
  databases: [
    { name: 'research', filename: 'research.db' },
    { name: 'photos', filename: 'photos.db' },
  ],
};
const session = { clientId: 'browser-tab', demoId: 'temporary-demo' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('managed database selection', () => {
  it('opens only an existing selection and never turns an empty list into a creation request', async () => {
    const picker = new DatabasePicker();
    expect(picker.canOpen).toBe(false);
    expect(() => picker.request('open', 'new-name', session)).toThrow('Select an existing database.');
    await picker.refresh(() => Promise.resolve({ databases: [] }));
    expect(picker.selectedName).toBe('');
    expect(() => picker.request('open', 'new-name', session)).toThrow('Select an existing database.');

    await picker.refresh(() => Promise.resolve(catalog));
    picker.selectedName = 'photos';
    expect(picker.request('open', 'different-creation-name', session)).toEqual({
      endpoint: '/api/connect',
      body: { name: 'photos', ...session },
    });
    picker.selectedName = 'not-in-the-list';
    expect(picker.canOpen).toBe(false);
  });

  it('creates by the entered name without sending a filepath or changing the selected database', async () => {
    const picker = new DatabasePicker();
    await picker.refresh(() => Promise.resolve(catalog));
    expect(picker.request('create', '  new-study  ', session)).toEqual({
      endpoint: '/api/create',
      body: { name: 'new-study', ...session },
    });
    expect(picker.selectedName).toBe('research');
    expect(() => picker.request('create', '  ', session)).toThrow('Enter a name');
  });

  it('preserves an available selection across refresh and selects a newly created database when requested', async () => {
    const picker = new DatabasePicker();
    await picker.refresh(() => Promise.resolve(catalog));
    picker.selectedName = 'photos';
    await picker.refresh(() => Promise.resolve(catalog));
    expect(picker.selectedName).toBe('photos');
    await picker.refresh(() => Promise.resolve(catalog), 'research');
    expect(picker.selectedName).toBe('research');
    await picker.refresh(() => Promise.resolve({ databases: [catalog.databases[1]] }));
    expect(picker.selectedName).toBe('photos');
  });

  it('shows a failed catalog as unavailable and allows a fresh successful retry', async () => {
    const picker = new DatabasePicker();
    await picker.refresh(() => Promise.resolve(catalog));
    await picker.refresh(() => Promise.reject(new Error('The daemon is unavailable.')));
    expect(picker.error).toBe('The daemon is unavailable.');
    expect(picker.loading).toBe(false);
    expect(picker.canOpen).toBe(false);
    expect(picker.databases).toEqual([]);
    await picker.refresh(() => Promise.resolve(catalog));
    expect(picker.error).toBeNull();
    expect(picker.canOpen).toBe(true);
  });

  it('rejects duplicate actions and late catalog success during connection or demo creation', async () => {
    const picker = new DatabasePicker();
    await picker.refresh(() => Promise.resolve(catalog));
    const oldCatalog = deferred<DatabaseCatalog>();
    const refresh = picker.refresh(() => oldCatalog.promise);
    expect(picker.loading).toBe(true);
    expect(picker.canOpen).toBe(false);
    picker.setBusy(true);
    expect(() => picker.request('open', '', session)).toThrow('already running');
    expect(() => picker.request('create', 'new-study', session)).toThrow('already running');
    const load = vi.fn(() => Promise.resolve(catalog));
    await picker.refresh(load);
    expect(load).not.toHaveBeenCalled();
    oldCatalog.resolve({ databases: [{ name: 'obsolete', filename: 'obsolete.db' }] });
    await refresh;
    expect(picker.databases).toEqual(catalog.databases);
    expect(picker.canOpen).toBe(false);
    expect(picker.loading).toBe(false);
    picker.setBusy(false);
    await picker.refresh(() => Promise.resolve(catalog), 'photos');
    expect(picker.canOpen).toBe(true);
    expect(picker.selectedName).toBe('photos');
  });

  it('does not let a late failure clear a newer authoritative catalog or selection', async () => {
    const picker = new DatabasePicker();
    const oldCatalog = deferred<DatabaseCatalog>();
    const oldRefresh = picker.refresh(() => oldCatalog.promise);
    await picker.refresh(() => Promise.resolve(catalog), 'photos');
    oldCatalog.reject(new Error('Late failure'));
    await oldRefresh;
    expect(picker.error).toBeNull();
    expect(picker.selectedName).toBe('photos');
    expect(picker.canOpen).toBe(true);
  });

  it('discards catalog responses from before a completed database switch', async () => {
    const picker = new DatabasePicker();
    const oldCatalog = deferred<DatabaseCatalog>();
    const oldRefresh = picker.refresh(() => oldCatalog.promise);
    picker.setBusy(true);
    picker.setBusy(false);
    await picker.refresh(() => Promise.resolve(catalog), 'photos');
    oldCatalog.resolve({ databases: [] });
    await oldRefresh;
    expect(picker.selectedName).toBe('photos');
    expect(picker.canOpen).toBe(true);
  });
});

describe('database display names', () => {
  it('handles Windows and POSIX daemon paths independently of the browser platform', () => {
    for (const filepath of ['C:\\project\\databases\\research.db', '/project/databases/research.db', 'research.db']) {
      expect(databaseFilename(filepath)).toBe('research.db');
      expect(databaseNameFromPath(filepath)).toBe('research');
    }
    expect(databaseNameFromPath('project.DRAFT.db')).toBe('project.DRAFT');
    expect(databaseNameFromPath(null)).toBe('');
    expect(databaseFilename(undefined)).toBe('');
  });
});
