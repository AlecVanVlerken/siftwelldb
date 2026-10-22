export type ManagedDatabase = Readonly<{ name: string; filename: string }>;
export type DatabaseCatalog = { databases: ManagedDatabase[] };
type DemoSession = { clientId: string; demoId: string | null };

/** Catalog requests must not replace a selection while a database is opening. */
export class DatabasePicker {
  databases: readonly ManagedDatabase[] = [];
  selectedName = '';
  loading = false;
  error: string | null = null;
  busy = false;
  private revision = 0;

  get canOpen(): boolean {
    return !this.busy && !this.loading && this.databases.some((database) => database.name === this.selectedName);
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.revision++;
    this.loading = false;
  }

  async refresh(load: () => Promise<DatabaseCatalog>, preferredName?: string): Promise<void> {
    if (this.busy) return;
    const revision = ++this.revision;
    this.loading = true;
    this.error = null;
    try {
      const { databases } = await load();
      if (revision !== this.revision || this.busy) return;
      this.databases = databases;
      this.selectedName =
        [preferredName, this.selectedName].find((name) => databases.some((database) => database.name === name)) ??
        databases[0]?.name ??
        '';
    } catch (error) {
      if (revision !== this.revision || this.busy) return;
      this.databases = [];
      this.selectedName = '';
      this.error = error instanceof Error ? error.message : 'Could not load databases.';
    } finally {
      if (revision === this.revision) this.loading = false;
    }
  }

  request(mode: 'open' | 'create', newName: string, session: DemoSession) {
    if (this.busy) throw new Error('A database operation is already running.');
    if (mode === 'open' && !this.canOpen) throw new Error('Select an existing database.');
    const name = mode === 'open' ? this.selectedName : newName.trim();
    if (!name) throw new Error('Enter a name for the new database.');
    return {
      endpoint: mode === 'open' ? '/api/connect' : '/api/create',
      body: { name, ...session },
    };
  }
}

/** The daemon may use Windows paths even when the browser runs elsewhere. */
export function databaseFilename(filepath: string | null | undefined): string {
  return filepath?.split(/[\\/]/).at(-1) ?? '';
}

export function databaseNameFromPath(filepath: string | null | undefined): string {
  return databaseFilename(filepath).replace(/\.db$/i, '');
}
