import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  CollectionOperations,
  collectionLoadingMessage,
  createVacuumOverlay,
  mergeCollectionCounts,
  vacuumProgressView,
  type VacuumProgressSnapshot,
} from '../database-operations.js';
import {
  captureRequestContext,
  invalidateRequestContext,
  isCurrentRequestContext,
  resetDisconnectedState,
  state,
} from '../state.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('collection operation responses', () => {
  it('immediately hides pending deletion and rejects old lists arriving after successful reconciliation', async () => {
    const operations = new CollectionOperations();
    const oldList = deferred<string[]>();
    let collections = ['books', 'photos'];
    const oldContext = operations.capture();
    const oldResponse = oldList.promise.then((names) => {
      if (operations.isCurrent(oldContext)) collections = operations.visible(names);
    });

    const deletion = operations.beginDeletion('photos')!;
    collections = operations.visible(collections);
    expect(collections).toEqual(['books']);
    expect(operations.isDeleting('photos')).toBe(true);
    expect(operations.pendingCollections).toEqual(['photos']);
    expect(operations.beginDeletion('photos')).toBeNull();
    expect(operations.isCurrent(operations.capture('photos'))).toBe(false);

    expect(operations.finishDeletion(deletion)).toBe(true);
    expect(operations.pendingCollections).toEqual([]);
    const authoritative = operations.capture();
    const newNames = await Promise.resolve(['books']);
    if (operations.isCurrent(authoritative)) collections = operations.visible(newNames);
    oldList.resolve(['books', 'photos']);
    await oldResponse;

    expect(collections).toEqual(['books']);
    expect(operations.finishDeletion(deletion)).toBe(false);
    expect(operations.isCurrent(authoritative)).toBe(true);
  });

  it('restores a failed deletion only from a fresh authoritative list and preserves other counts', async () => {
    const operations = new CollectionOperations();
    const stale = operations.capture();
    const deletion = operations.beginDeletion('photos')!;
    const counts = { books: 12, photos: 80 };
    expect(mergeCollectionCounts(counts, operations.visible(['books', 'photos']))).toEqual({ books: 12 });

    // The caller reports the actual request error, ends the pending state, and reloads.
    const failure = deferred<string[]>();
    operations.finishDeletion(deletion);
    const current = operations.capture();
    const reconciliation = failure.promise.then((names) =>
      operations.isCurrent(current) ? operations.visible(names) : [],
    );
    failure.resolve(['books', 'photos']);
    const restored = await reconciliation;

    expect(restored).toEqual(['books', 'photos']);
    expect(operations.isCurrent(stale)).toBe(false);
    expect(mergeCollectionCounts(counts, restored)).toEqual(counts);
  });

  it('rejects obsolete documents for the deleted collection without invalidating another collection', async () => {
    const operations = new CollectionOperations();
    const oldPhotos = deferred<Array<{ id: number }>>();
    const booksContext = operations.capture('books');
    const photosContext = operations.capture('photos');
    let photos: Array<{ id: number }> = [];
    const oldResponse = oldPhotos.promise.then((documents) => {
      if (operations.isCurrent(photosContext)) photos = documents;
    });
    const deletion = operations.beginDeletion('photos')!;

    expect(operations.isCurrent(booksContext)).toBe(true);
    oldPhotos.resolve([{ id: 1 }]);
    await oldResponse;
    expect(photos).toEqual([]);
    operations.finishDeletion(deletion);
    expect(operations.isCurrent(photosContext)).toBe(false);
    expect(operations.isCurrent(booksContext)).toBe(true);
  });

  it('scopes same-name pending deletions and all responses to the database session', () => {
    const operations = new CollectionOperations();
    const oldList = operations.capture();
    const oldDocuments = operations.capture('photos');
    const first = operations.beginDeletion('photos')!;
    operations.resetDatabase();
    const second = operations.beginDeletion('photos')!;

    expect(operations.finishDeletion(first)).toBe(false);
    expect(operations.isDeleting('photos')).toBe(true);
    expect(operations.isCurrent(oldList)).toBe(false);
    expect(operations.isCurrent(oldDocuments)).toBe(false);
    expect(operations.finishDeletion(second)).toBe(true);
    expect(operations.visible(['photos'])).toEqual(['photos']);
  });

  it('keeps the newly selected collection when an old document response arrives during another deletion', async () => {
    resetDisconnectedState();
    state.connected = true;
    state.filepath = 'selected.db';
    state.selectedCol = 'books';
    const operations = new CollectionOperations();
    const selection = captureRequestContext();
    const collection = operations.capture('books');
    const oldBooks = deferred<Array<{ id: string }>>();
    let displayed = [{ id: 'current-ticket' }];
    const load = oldBooks.promise.then((documents) => {
      if (isCurrentRequestContext(selection) && operations.isCurrent(collection)) displayed = documents;
    });

    operations.beginDeletion('photos');
    invalidateRequestContext();
    state.selectedCol = 'tickets';
    oldBooks.resolve([{ id: 'old-book' }]);
    await load;

    expect(state.selectedCol).toBe('tickets');
    expect(displayed).toEqual([{ id: 'current-ticket' }]);
    resetDisconnectedState();
  });

  it('keeps known counts during refresh, distinguishes unknown from empty, and accepts authoritative zero', () => {
    expect(mergeCollectionCounts({ books: 12, removed: 8 }, ['books', 'photos'])).toEqual({
      books: 12,
      photos: '?',
    });
    expect(mergeCollectionCounts({ books: 12, photos: '?' }, ['books', 'photos'], { books: 0, photos: 4 })).toEqual({
      books: 0,
      photos: 4,
    });
    expect(mergeCollectionCounts({ books: 12 }, ['books', 'photos'], { books: NaN, photos: -1 })).toEqual({
      books: 12,
      photos: '?',
    });
    expect(mergeCollectionCounts({}, ['__proto__', 'constructor', 'toString'])).toEqual({
      ['__proto__']: '?',
      constructor: '?',
      toString: '?',
    });
  });
});

describe('collection loading feedback', () => {
  it('distinguishes a deferred selection from a dispatched document request', () => {
    expect(collectionLoadingMessage('articles', { loading: true, waiting: true }, ['photos'])).toBe(
      'Waiting for collection deletion to finish. “articles” will load automatically.',
    );
    expect(collectionLoadingMessage('articles', { loading: true, waiting: false }, ['photos'])).toBe(
      'Loading “articles”…',
    );
    expect(collectionLoadingMessage('articles', { loading: true, waiting: true }, [])).toBe('Loading “articles”…');
    expect(collectionLoadingMessage('articles', { loading: true, waitingForStatus: true }, [])).toBe(
      'Waiting for database availability. “articles” will load automatically.',
    );
  });

  it('clears waiting feedback after loading and distinguishes failed reads from empty collections', () => {
    expect(collectionLoadingMessage('articles', { loading: false, waiting: true }, ['photos'])).toBeNull();
    expect(collectionLoadingMessage('articles', undefined, [])).toBeNull();
    expect(collectionLoadingMessage('articles', { error: 'Read failed' }, [])).toBe(
      'Could not load “articles”. Use Reload to try again.',
    );
    expect(collectionLoadingMessage('articles', { loading: true, error: 'Previous error' }, [])).toBe(
      'Loading “articles”…',
    );
  });
});

describe('measured vacuum progress feedback', () => {
  const progress = (overrides: Partial<VacuumProgressSnapshot> = {}): VacuumProgressSnapshot => ({
    id: 'operation-1',
    state: 'running',
    phase: 'copy-collection',
    processed: 1,
    total: 3,
    ...overrides,
  });

  it('shows only the measured phase ratio, ignoring a supplied estimated percentage', () => {
    expect(vacuumProgressView(progress({ collection: 'articles', percentage: 99 }))).toEqual({
      stage: 'Copying documents and rebuilding indexes…',
      percentage: 33,
      detail: '1 / 3 documents in “articles”',
    });
    expect(vacuumProgressView(progress({ processed: 0, total: 100 }))).toMatchObject({
      percentage: 0,
      detail: '0 / 100 documents',
    });
  });

  it('labels validation counts in their actual unit and permits completed phase counts', () => {
    expect(vacuumProgressView(progress({ phase: 'validate', unit: 'collections', processed: 2, total: 5 }))).toEqual({
      stage: 'Validating the rebuilt database…',
      percentage: 40,
      detail: '2 / 5 collections',
    });
    expect(vacuumProgressView(progress({ processed: 3 }))).toMatchObject({ percentage: 100 });
  });

  it('keeps synchronization, replacement, reopening and completion indeterminate', () => {
    for (const phase of [
      'queued',
      'commit-source',
      'commit-target',
      'replace-files',
      'reopen',
      'finalize',
      'complete',
    ]) {
      expect(vacuumProgressView(progress({ phase, processed: 3, percentage: 100 })).percentage).toBeNull();
    }
    expect(vacuumProgressView(null)).toMatchObject({ stage: 'Starting full vacuum…', percentage: null });
    expect(vacuumProgressView(progress({ phase: 'reopen' })).stage).toBe('Reopening the database…');
  });

  it('does not fabricate progress from missing, zero or invalid counts', () => {
    for (const counts of [
      { processed: undefined },
      { total: undefined },
      { total: 0, processed: 0 },
      { processed: -1 },
      { processed: 4 },
      { processed: 1.5 },
      { processed: NaN },
      { total: Infinity },
      { total: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const view = vacuumProgressView(progress(counts));
      expect(view.percentage).toBeNull();
      expect(view.detail).toBe('Please wait until the database has reopened and the view has refreshed.');
    }
  });

  it('preserves actual failure details without presenting a finished phase as successful', () => {
    expect(
      vacuumProgressView(progress({ phase: 'failed', state: 'failed', error: 'Reopen failed', processed: 3 })),
    ).toEqual({
      stage: 'Vacuum failed',
      percentage: null,
      detail: 'Reopen failed',
    });
    expect(vacuumProgressView(progress({ state: 'completed', processed: 3 })).percentage).toBeNull();
    expect(vacuumProgressView(progress({ state: 'failed' })).detail).toBe('The vacuum operation failed.');
  });
});

function maintenanceDom() {
  const listeners = new Map<string, EventListener>();
  const document = {
    activeElement: null as HTMLElement | null,
    body: { style: { overflow: 'auto' } },
    addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  function element(): HTMLElement {
    const attributes = new Map<string, string>();
    const classes = new Set(['hidden']);
    const node = {
      ownerDocument: document,
      inert: false,
      isConnected: true,
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        contains: (name: string) => classes.has(name),
      },
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
      contains: (target: unknown) => target === node,
      closest: () => (node.inert ? node : null),
      focus: vi.fn(() => {
        document.activeElement = node as unknown as HTMLElement;
      }),
    };
    return node as unknown as HTMLElement;
  }
  const app = element();
  const dialog = element();
  const button = element();
  const overlay = element();
  document.activeElement = button;
  return { document, listeners, app, dialog, button, overlay };
}

describe('full vacuum blocking dialog', () => {
  it('blocks app and open dialogs, prevents duplicate starts, and restores existing state and focus', () => {
    const { document, listeners, app, dialog, button, overlay } = maintenanceDom();
    dialog.inert = true;
    dialog.setAttribute('aria-busy', 'false');
    const operation = createVacuumOverlay(overlay, [app, dialog, overlay]);

    expect(operation.show()).toBe(true);
    expect(operation.show()).toBe(false);
    expect(operation.active).toBe(true);
    expect(app.inert).toBe(true);
    expect(dialog.inert).toBe(true);
    expect(app.getAttribute('aria-busy')).toBe('true');
    expect(overlay.inert).toBe(false);
    expect(overlay.classList.contains('hidden')).toBe(false);
    expect(document.activeElement).toBe(overlay);
    expect(document.body.style.overflow).toBe('hidden');

    operation.hide();
    expect(operation.active).toBe(false);
    expect(app.inert).toBe(false);
    expect(dialog.inert).toBe(true);
    expect(dialog.getAttribute('aria-busy')).toBe('false');
    expect(app.getAttribute('aria-busy')).toBeNull();
    expect(overlay.classList.contains('hidden')).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(document.body.style.overflow).toBe('auto');
    expect(listeners.size).toBe(0);
    operation.hide();
    expect(document.activeElement).toBe(button);
  });

  it('retains keyboard focus and cannot be dismissed with Escape while maintenance is pending', () => {
    const { listeners, app, button, overlay, document } = maintenanceDom();
    const operation = createVacuumOverlay(overlay, [app]);
    operation.show();
    for (const key of ['Tab', 'Escape']) {
      const event = { key, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
      listeners.get('keydown')!(event as unknown as Event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(overlay);
    }
    listeners.get('focusin')!({ target: button } as unknown as Event);
    expect(document.activeElement).toBe(overlay);
    operation.hide();
  });

  it('does not focus a removed element after completion or failure', () => {
    const { app, button, overlay, document } = maintenanceDom();
    const operation = createVacuumOverlay(overlay, [app]);
    operation.show();
    Object.assign(button, { isConnected: false });
    operation.hide();
    expect(document.activeElement).toBe(overlay);
    expect(operation.active).toBe(false);
    expect(app.inert).toBe(false);
  });
});

describe('connection and maintenance markup', () => {
  it('offers managed database selection and creation, keeps demo creation, and labels the blocking vacuum dialog', async () => {
    const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
    expect(html).not.toContain('connect-filepath');
    expect(html).toMatch(/<select\b[^>]*\bid="connect-database"/);
    const name = html.match(/<input\b[^>]*\bid="connect-name"[^>]*>/)?.[0];
    expect(name).toBeDefined();
    expect(name).not.toMatch(/\bvalue="[^"]+"/);
    expect(html).toContain('id="connect-refresh"');
    expect(html).toContain('id="connect-demo"');
    expect(html).toMatch(/id="database-operation-overlay"\s+role="dialog"\s+aria-modal="true"/);
    expect(html).toContain('aria-labelledby="database-operation-title"');
    expect(html).toContain('aria-describedby="database-operation-detail"');
  });
});
