export type CollectionRequest = Readonly<{
  databaseEpoch: number;
  collection: string | null;
  revision: number;
}>;

export type CollectionDeletion = Readonly<{
  databaseEpoch: number;
  collection: string;
}>;

/** Keep pending removals separate from authoritative collection names. */
export class CollectionOperations {
  private databaseEpoch = 0;
  private listRevision = 0;
  private readonly revisions = new Map<string, number>();
  private readonly pending = new Map<string, CollectionDeletion>();

  get pendingCollections(): readonly string[] {
    return Array.from(this.pending.keys());
  }

  resetDatabase(): void {
    this.databaseEpoch++;
    this.listRevision++;
    this.revisions.clear();
    this.pending.clear();
  }

  capture(collection?: string): CollectionRequest {
    return {
      databaseEpoch: this.databaseEpoch,
      collection: collection ?? null,
      revision: collection === undefined ? this.listRevision : (this.revisions.get(collection) ?? 0),
    };
  }

  isCurrent(request: CollectionRequest): boolean {
    if (request.databaseEpoch !== this.databaseEpoch) return false;
    if (request.collection === null) return request.revision === this.listRevision;
    return !this.isDeleting(request.collection) && request.revision === (this.revisions.get(request.collection) ?? 0);
  }

  beginDeletion(collection: string): CollectionDeletion | null {
    if (this.isDeleting(collection)) return null;
    const deletion = { databaseEpoch: this.databaseEpoch, collection };
    this.pending.set(collection, deletion);
    this.advance(collection);
    return deletion;
  }

  /** Success and failure both require a fresh authoritative collection response. */
  finishDeletion(deletion: CollectionDeletion): boolean {
    if (deletion.databaseEpoch !== this.databaseEpoch || this.pending.get(deletion.collection) !== deletion) {
      return false;
    }
    this.pending.delete(deletion.collection);
    this.advance(deletion.collection);
    return true;
  }

  isDeleting(collection: string): boolean {
    return this.pending.has(collection);
  }

  visible(collections: readonly string[]): string[] {
    return collections.filter((collection) => !this.isDeleting(collection));
  }

  private advance(collection: string): void {
    this.listRevision++;
    this.revisions.set(collection, (this.revisions.get(collection) ?? 0) + 1);
  }
}

export function mergeCollectionCounts(
  previous: Record<string, number | '?'>,
  collections: readonly string[],
  authoritative?: Record<string, number | '?' | undefined>,
): Record<string, number | '?'> {
  const counts = Object.create(null) as Record<string, number | '?'>;
  for (const collection of collections) {
    const fresh = authoritative && Object.hasOwn(authoritative, collection) ? authoritative[collection] : undefined;
    const known = Object.hasOwn(previous, collection) ? previous[collection] : undefined;
    counts[collection] =
      typeof fresh === 'number' && Number.isSafeInteger(fresh) && fresh >= 0 ? fresh : (known ?? '?');
  }
  return counts;
}

export type VacuumProgressSnapshot = {
  id: string;
  phase: string;
  state: 'queued' | 'running' | 'completed' | 'failed';
  collection?: string;
  processed?: number;
  total?: number;
  percentage?: number;
  unit?: 'documents' | 'collections';
  error?: string;
};

export function collectionLoadingMessage(
  collection: string,
  page: { loading?: boolean; waiting?: boolean; waitingForStatus?: boolean; error?: string } | undefined,
  deletions: readonly string[],
): string | null {
  if (!page?.loading) return page?.error ? `Could not load “${collection}”. Use Reload to try again.` : null;
  if (page.waitingForStatus) return `Waiting for database availability. “${collection}” will load automatically.`;
  if (page.waiting && deletions.length)
    return `Waiting for collection deletion to finish. “${collection}” will load automatically.`;
  return `Loading “${collection}”…`;
}

/** Percentages describe only the named phase, never estimated elapsed time. */
export function vacuumProgressView(progress: VacuumProgressSnapshot | null) {
  const stages: Record<string, string> = {
    queued: 'Waiting for accepted database operations…',
    preflight: 'Checking database files…',
    'commit-source': 'Synchronizing the source database…',
    'create-target': 'Creating the new database…',
    'copy-collection': 'Copying documents and rebuilding indexes…',
    'commit-target': 'Synchronizing the new database…',
    validate: 'Validating the rebuilt database…',
    'closing-target': 'Closing database files…',
    'replace-files': 'Installing the rebuilt database…',
    reopen: 'Reopening the database…',
    finalize: 'Finalizing recovery metadata…',
    recover: 'Recovering the original database…',
    complete: 'Refreshing the database view…',
    failed: 'Vacuum failed',
  };
  const measured =
    !!progress && ['copy-collection', 'validate'].includes(progress.phase) && progress.state === 'running';
  const hasCounts =
    measured &&
    Number.isSafeInteger(progress.processed) &&
    Number.isSafeInteger(progress.total) &&
    progress.total! > 0 &&
    progress.processed! >= 0 &&
    progress.processed! <= progress.total!;
  const percentage = hasCounts ? Math.floor((progress.processed! / progress.total!) * 100) : null;
  return {
    stage: progress ? (stages[progress.phase] ?? 'Optimizing database…') : 'Starting full vacuum…',
    percentage,
    detail:
      progress?.state === 'failed'
        ? (progress.error ?? 'The vacuum operation failed.')
        : hasCounts
          ? `${progress.processed!.toLocaleString()} / ${progress.total!.toLocaleString()} ${progress.unit ?? 'documents'}${progress.collection !== undefined ? ` in “${progress.collection}”` : ''}`
          : 'Please wait until the database has reopened and the view has refreshed.',
  };
}

/** A blocking maintenance dialog; completion includes replacement and reopening. */
export function createVacuumOverlay(overlay: HTMLElement, background: readonly HTMLElement[]) {
  const document = overlay.ownerDocument;
  let active = false;
  let previousFocus: HTMLElement | null = null;
  let previousOverflow = '';
  let snapshots: Array<{ element: HTMLElement; inert: boolean; busy: string | null }> = [];

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' && event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    overlay.focus({ preventScroll: true });
  };
  const onFocus = (event: FocusEvent) => {
    if (!overlay.contains(event.target as Node | null)) overlay.focus({ preventScroll: true });
  };

  return {
    get active() {
      return active;
    },
    show(): boolean {
      if (active) return false;
      active = true;
      previousFocus = document.activeElement as HTMLElement | null;
      previousOverflow = document.body.style.overflow;
      snapshots = background
        .filter((element) => element !== overlay && !element.contains(overlay))
        .map((element) => ({ element, inert: element.inert, busy: element.getAttribute('aria-busy') }));
      for (const { element } of snapshots) {
        element.inert = true;
        element.setAttribute('aria-busy', 'true');
      }
      document.body.style.overflow = 'hidden';
      overlay.classList.remove('hidden');
      overlay.setAttribute('aria-hidden', 'false');
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('focusin', onFocus, true);
      overlay.focus({ preventScroll: true });
      return true;
    },
    hide(): void {
      if (!active) return;
      active = false;
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocus, true);
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = previousOverflow;
      for (const { element, inert, busy } of snapshots) {
        element.inert = inert;
        if (busy === null) element.removeAttribute('aria-busy');
        else element.setAttribute('aria-busy', busy);
      }
      snapshots = [];
      if (
        previousFocus?.isConnected &&
        !previousFocus.closest('[inert]') &&
        typeof previousFocus.focus === 'function'
      ) {
        previousFocus.focus({ preventScroll: true });
      }
      previousFocus = null;
    },
  };
}
