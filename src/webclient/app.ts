// @author Alexandre-Gatien Bienfet
// @date 2026-03-31

import { state } from './state.js';
import type { Document } from './state.js';
import { apiCall } from './api.js';
import { formatSize, isImageField } from './utils.js';
import { initTable, applyFilter, renderTable, closeAllDropdowns } from './table.js';
import { initDocView, openDocView, closeDocView, enterEditMode, cancelEditMode, saveDocView } from './doc-view.js';

// ── DOM Elements ─────────────────────────────────────────────

const connectionStatus = document.getElementById('connection-status') as HTMLElement;
const disconnectBtn = document.getElementById('disconnect-btn') as HTMLButtonElement;
const collectionList = document.getElementById('collection-list') as HTMLUListElement;
const connectModal = document.getElementById('connect-modal') as HTMLElement;
const dbFilepathInput = document.getElementById('db-filepath') as HTMLInputElement;
const connectConfirmBtn = document.getElementById('connect-confirm-btn') as HTMLButtonElement;
const createNewBtn = document.getElementById('create-new-btn') as HTMLButtonElement;
const connectError = document.getElementById('connect-error') as HTMLElement;
const dataTableHead = document.querySelector('#data-table thead') as HTMLElement;
const dataTableBody = document.querySelector('#data-table tbody') as HTMLElement;
const addDocBtn = document.getElementById('add-doc-btn') as HTMLButtonElement;
const filterInput = document.getElementById('filter-input') as HTMLInputElement;
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement;
const modalCloseBtns = document.querySelectorAll('.close-btn');
const resetDbBtn = document.getElementById('reset-db-btn') as HTMLButtonElement | null;
const vacuumDbBtn = document.getElementById('vacuum-db-btn') as HTMLButtonElement | null;
const databaseSizeValue = document.getElementById('database-size-value');
const incrementalCompactionToggle = document.getElementById('incremental-compaction-toggle') as HTMLInputElement | null;
const incrementalCompactionStatus = document.getElementById('incremental-compaction-status');
const newCollectionBtn = document.querySelector('#new-collection-btn');
const newCollectionModal = document.getElementById('new-collection-modal');
const newCollectionInput = document.getElementById('new-collection-name') as HTMLInputElement | null;
const newCollectionConfirmBtn = document.getElementById('new-collection-confirm-btn') as HTMLButtonElement | null;
const newCollectionError = document.getElementById('new-collection-error');
const headerMenuBtn = document.getElementById('header-menu-btn') as HTMLButtonElement | null;
const headerDropdown = document.getElementById('header-dropdown') as HTMLDivElement | null;
const maintenanceOverlay = document.getElementById('maintenance-overlay');
const maintenanceTitle = document.getElementById('maintenance-title');
const maintenanceStatus = document.getElementById('maintenance-status');

type DatabaseSizeInfo = {
  dataFileBytes: number;
  logFileBytes: number;
  totalBytes: number;
  activeDataBytes?: number;
  freeDataBytes?: number;
  amplification?: number;
  totalBlocks?: number;
  usedBlocks?: number;
  freeBlocks?: number;
  freeTailBlocks?: number;
};

type IncrementalCompactionInfo = {
  enabled: boolean;
  queued: boolean;
  running: boolean;
  intervalMs: number;
  maxAmplification: number | null;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastResult: IncrementalCompactionResultInfo | null;
};

type IncrementalCompactionResultInfo = {
  didWork?: boolean;
  blocked?: boolean;
  reachedTarget?: boolean;
  relocatedDocuments?: number;
  relocatedBtreeNodes?: number;
  relocatedHnswUnits?: number;
  reclaimedTailBlocks?: number;
};

let connectionRequestActive = false;

// Semantic search
const semanticSearchInput = document.getElementById('semantic-search-input') as HTMLInputElement;
const semanticSearchBtn = document.getElementById('semantic-search-btn') as HTMLButtonElement;
const semanticSearchClearBtn = document.getElementById('semantic-search-clear-btn') as HTMLButtonElement;
const searchModeTextBtn = document.getElementById('search-mode-text') as HTMLButtonElement | null;
const searchModeImageBtn = document.getElementById('search-mode-image') as HTMLButtonElement | null;

// Doc view buttons
const docViewBack = document.getElementById('doc-view-back') as HTMLButtonElement;
const docViewEdit = document.getElementById('doc-view-edit') as HTMLButtonElement;
const docViewSave = document.getElementById('doc-view-save') as HTMLButtonElement;
const docViewCancel = document.getElementById('doc-view-cancel') as HTMLButtonElement;
const docViewDelete = document.getElementById('doc-view-delete') as HTMLButtonElement;

// ── Module initialisation ────────────────────────────────────

initTable({
  dataTableHead,
  dataTableBody,
  onOpenDoc: (doc, editMode) => openDocView(doc, editMode),
  onDeleteDoc: (id) => void deleteDocument(id),
});

initDocView({
  docView: document.getElementById('doc-view') as HTMLElement,
  docViewTitle: document.getElementById('doc-view-title') as HTMLElement,
  docViewFields: document.getElementById('doc-view-fields') as HTMLElement,
  docViewContent: document.getElementById('doc-view-content') as HTMLElement,
  docViewEdit,
  docViewSave,
  docViewCancel,
  loadDocuments,
  loadCollections,
});

// ── Workspace reset helper ───────────────────────────────────

function clearWorkspace(): void {
  state.currentCollection = null;
  state.allDocuments = [];
  dataTableHead.innerHTML = '';
  dataTableBody.innerHTML = '';
  filterInput.value = '';
  addDocBtn.disabled = true;
  filterInput.disabled = true;
  refreshBtn.disabled = true;
  if (searchModeTextBtn) searchModeTextBtn.disabled = true;
  if (searchModeImageBtn) searchModeImageBtn.disabled = true;
  semanticSearchInput.disabled = true;
  semanticSearchBtn.disabled = true;
  semanticSearchClearBtn.classList.add('hidden');
  closeDocView();
}

// ── Connection ───────────────────────────────────────────────

function setConnectBusy(active: boolean, statusText = ''): void {
  connectConfirmBtn.disabled = active;
  createNewBtn.disabled = active;
  dbFilepathInput.disabled = active;
  connectConfirmBtn.textContent = active ? 'Openen...' : 'Openen';
  createNewBtn.textContent = active ? 'Bezig...' : 'Nieuw aanmaken';
  if (active) setMaintenance(true, statusText, 'Database openen');
  else setMaintenance(false);
}

async function connect(filepath: string) {
  if (connectionRequestActive) return;
  connectionRequestActive = true;
  connectError.textContent = '';
  setConnectBusy(true, 'De database wordt geopend en de semantische zoekmodellen worden geladen.');
  try {
    await apiCall('/api/connect', 'POST', { filepath });
    onConnected(filepath);
    await loadCollections();
    await updateDatabaseStatus();
  } catch (error) {
    connectError.textContent = (error as Error).message;
  } finally {
    connectionRequestActive = false;
    setConnectBusy(false);
  }
}

async function createNew(filepath: string) {
  if (connectionRequestActive) return;
  connectionRequestActive = true;
  connectError.textContent = '';
  setConnectBusy(true, 'De nieuwe database wordt aangemaakt en de semantische zoekmodellen worden geladen.');
  try {
    await apiCall('/api/create', 'POST', { filepath });
    onConnected(filepath);
    await loadCollections();
    await updateDatabaseStatus();
  } catch (error) {
    connectError.textContent = (error as Error).message;
  } finally {
    connectionRequestActive = false;
    setConnectBusy(false);
  }
}

function onConnected(filepath: string) {
  connectionStatus.textContent = `Connected: ${filepath}`;
  connectionStatus.classList.add('connected');
  disconnectBtn.disabled = false;
  if (resetDbBtn) resetDbBtn.disabled = false;
  if (vacuumDbBtn) vacuumDbBtn.disabled = false;
  if (incrementalCompactionToggle) incrementalCompactionToggle.disabled = false;
  if (newCollectionBtn instanceof HTMLButtonElement) newCollectionBtn.disabled = false;
  if (headerMenuBtn) headerMenuBtn.disabled = false;
  connectModal.classList.add('hidden');
}

async function disconnect() {
  try {
    await apiCall('/api/disconnect', 'POST');
    connectionStatus.textContent = 'Disconnected';
    connectionStatus.classList.remove('connected');
    disconnectBtn.disabled = true;
    if (resetDbBtn) resetDbBtn.disabled = true;
    if (vacuumDbBtn) vacuumDbBtn.disabled = true;
    renderIncrementalCompaction(null);
    renderDatabaseSize(null);
    if (newCollectionBtn instanceof HTMLButtonElement) newCollectionBtn.disabled = true;
    if (headerMenuBtn) headerMenuBtn.disabled = true;
    collectionList.innerHTML = '';
    clearWorkspace();
    addDocBtn.disabled = true;
    filterInput.disabled = true;
    refreshBtn.disabled = true;
    if (searchModeTextBtn) searchModeTextBtn.disabled = true;
    if (searchModeImageBtn) searchModeImageBtn.disabled = true;
    semanticSearchInput.disabled = true;
    semanticSearchInput.value = '';
    semanticSearchBtn.disabled = true;
    semanticSearchClearBtn.classList.add('hidden');
    connectModal.classList.remove('hidden');
  } catch (error) {
    console.error('Disconnect failed:', error);
  }
}

async function resetDb() {
  if (!confirm('Reset the database? This will delete ALL data permanently.')) return;
  try {
    await apiCall('/api/debug/reset', 'POST');
    clearWorkspace();
    await loadCollections();
    await updateDatabaseStatus();
    alert('Database reset successfully.');
  } catch (error) {
    alert('Reset failed: ' + (error as Error).message);
  }
}

async function compactDatabase() {
  if (!confirm('Database compacten? De database is tijdelijk niet bruikbaar tot dit klaar is.')) return;

  const previousCollection = state.currentCollection;
  if (headerDropdown) headerDropdown.classList.add('hidden');
  setMaintenance(true, 'Database wordt gecompacteerd. De database is tijdelijk vergrendeld.');

  try {
    const data = await apiCall('/api/database/vacuum', 'POST');
    const before = readSizeInfo(data['before']);
    const after = readSizeInfo(data['after']);
    if (after) renderDatabaseSize(after);

    await loadCollections();
    if (previousCollection && state.collections.includes(previousCollection)) {
      selectCollection(previousCollection);
    } else {
      clearWorkspace();
    }

    const savedBytes = before && after ? before.totalBytes - after.totalBytes : undefined;
    const savedText = savedBytes !== undefined ? ` Bespaard: ${formatSize(Math.max(0, savedBytes))}.` : '';
    alert(`Database compactie klaar.${savedText}`);
  } catch (error) {
    alert('Compactie mislukt: ' + (error as Error).message);
    await updateDatabaseStatus();
  } finally {
    setMaintenance(false);
  }
}

async function updateDatabaseStatus(): Promise<void> {
  if (!databaseSizeValue || !connectionStatus.classList.contains('connected')) return;

  try {
    const data = await apiCall('/api/database/status');
    const size = readSizeInfo(data['size']);
    renderDatabaseSize(size);
    renderIncrementalCompaction(readIncrementalCompactionInfo(data['incrementalCompaction']), size);
  } catch (error) {
    console.error('Failed to load database status:', error);
    renderDatabaseSize(null);
    renderIncrementalCompaction(null);
  }
}

function readSizeInfo(value: unknown): DatabaseSizeInfo | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const dataFileBytes = record['dataFileBytes'];
  const logFileBytes = record['logFileBytes'];
  const totalBytes = record['totalBytes'];
  const activeDataBytes = record['activeDataBytes'];
  const freeDataBytes = record['freeDataBytes'];
  const amplification = record['amplification'];
  const totalBlocks = record['totalBlocks'];
  const usedBlocks = record['usedBlocks'];
  const freeBlocks = record['freeBlocks'];
  const freeTailBlocks = record['freeTailBlocks'];

  if (typeof dataFileBytes !== 'number' || typeof logFileBytes !== 'number' || typeof totalBytes !== 'number') {
    return null;
  }

  return {
    dataFileBytes,
    logFileBytes,
    totalBytes,
    activeDataBytes: typeof activeDataBytes === 'number' ? activeDataBytes : undefined,
    freeDataBytes: typeof freeDataBytes === 'number' ? freeDataBytes : undefined,
    amplification: typeof amplification === 'number' ? amplification : undefined,
    totalBlocks: typeof totalBlocks === 'number' ? totalBlocks : undefined,
    usedBlocks: typeof usedBlocks === 'number' ? usedBlocks : undefined,
    freeBlocks: typeof freeBlocks === 'number' ? freeBlocks : undefined,
    freeTailBlocks: typeof freeTailBlocks === 'number' ? freeTailBlocks : undefined,
  };
}

function renderDatabaseSize(size: DatabaseSizeInfo | null): void {
  if (!databaseSizeValue) return;
  if (!size) {
    databaseSizeValue.textContent = '-';
    databaseSizeValue.removeAttribute('title');
    return;
  }

  if (size.activeDataBytes !== undefined && size.freeDataBytes !== undefined) {
    databaseSizeValue.textContent = `${formatSize(size.dataFileBytes)} bestand / ${formatSize(size.activeDataBytes)} actief`;
    const details = [
      `Datafile: ${formatSize(size.dataFileBytes)}`,
      `Logfile: ${formatSize(size.logFileBytes)}`,
      `Actieve blokken: ${formatSize(size.activeDataBytes)}`,
      `Vrije blokken: ${formatSize(size.freeDataBytes)}`,
    ];
    if (size.amplification !== undefined) details.push(`Amplificatie: ${size.amplification.toFixed(2)}x`);
    if (size.totalBlocks !== undefined && size.usedBlocks !== undefined && size.freeBlocks !== undefined) {
      details.push(
        `Blokken: ${size.usedBlocks.toString()} gebruikt / ${size.freeBlocks.toString()} vrij / ${size.totalBlocks.toString()} totaal`,
      );
    }
    if (size.freeTailBlocks !== undefined) details.push(`Vrije staartblokken: ${size.freeTailBlocks.toString()}`);
    databaseSizeValue.title = details.join('\n');
    return;
  }

  databaseSizeValue.textContent = formatSize(size.totalBytes);
  databaseSizeValue.title = `Datafile: ${formatSize(size.dataFileBytes)}\nLogfile: ${formatSize(size.logFileBytes)}`;
}

function readIncrementalCompactionInfo(value: unknown): IncrementalCompactionInfo | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const enabled = record['enabled'];
  const queued = record['queued'];
  const running = record['running'];
  const intervalMs = record['intervalMs'];
  const policy = record['policy'];
  const lastRunAt = record['lastRunAt'];
  const lastDurationMs = record['lastDurationMs'];
  const lastError = record['lastError'];
  const lastResult = readIncrementalCompactionResultInfo(record['lastResult']);
  const maxAmplification =
    policy && typeof policy === 'object' && typeof (policy as Record<string, unknown>)['maxAmplification'] === 'number'
      ? ((policy as Record<string, unknown>)['maxAmplification'] as number)
      : null;

  if (
    typeof enabled !== 'boolean' ||
    typeof queued !== 'boolean' ||
    typeof running !== 'boolean' ||
    typeof intervalMs !== 'number'
  ) {
    return null;
  }

  return {
    enabled,
    queued,
    running,
    intervalMs,
    maxAmplification,
    lastRunAt: typeof lastRunAt === 'string' ? lastRunAt : null,
    lastDurationMs: typeof lastDurationMs === 'number' ? lastDurationMs : null,
    lastError: typeof lastError === 'string' ? lastError : null,
    lastResult,
  };
}

function readIncrementalCompactionResultInfo(value: unknown): IncrementalCompactionResultInfo | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return {
    didWork: typeof record['didWork'] === 'boolean' ? record['didWork'] : undefined,
    blocked: typeof record['blocked'] === 'boolean' ? record['blocked'] : undefined,
    reachedTarget: typeof record['reachedTarget'] === 'boolean' ? record['reachedTarget'] : undefined,
    relocatedDocuments: typeof record['relocatedDocuments'] === 'number' ? record['relocatedDocuments'] : undefined,
    relocatedBtreeNodes: typeof record['relocatedBtreeNodes'] === 'number' ? record['relocatedBtreeNodes'] : undefined,
    relocatedHnswUnits: typeof record['relocatedHnswUnits'] === 'number' ? record['relocatedHnswUnits'] : undefined,
    reclaimedTailBlocks: typeof record['reclaimedTailBlocks'] === 'number' ? record['reclaimedTailBlocks'] : undefined,
  };
}

function renderIncrementalCompaction(
  info: IncrementalCompactionInfo | null,
  size: DatabaseSizeInfo | null = null,
): void {
  const connected = connectionStatus.classList.contains('connected');
  if (incrementalCompactionToggle) {
    incrementalCompactionToggle.checked = info?.enabled ?? false;
    incrementalCompactionToggle.disabled = !connected;
  }
  if (!incrementalCompactionStatus) return;

  if (!info?.enabled) {
    incrementalCompactionStatus.textContent = 'Uitgeschakeld. Gebruik handmatige full vacuum wanneer nodig.';
    return;
  }
  if (info.lastError) {
    incrementalCompactionStatus.textContent = `Fout: ${info.lastError}`;
    return;
  }
  if (info.running) {
    incrementalCompactionStatus.textContent = 'Actief: kleine compaction-stap wordt uitgevoerd.';
    return;
  }
  if (info.queued) {
    incrementalCompactionStatus.textContent = 'In wachtrij: compaction wacht op databasegebruik.';
    return;
  }
  if (
    size?.amplification !== undefined &&
    info.maxAmplification !== null &&
    size.amplification <= info.maxAmplification
  ) {
    const free =
      size.freeBlocks !== undefined
        ? ` ${size.freeBlocks.toString()} vrije blokken, ${size.freeTailBlocks ?? 0} vrije staartblokken.`
        : '';
    incrementalCompactionStatus.textContent =
      `Ingeschakeld. Geen compaction nodig: ${size.amplification.toFixed(2)}x <= ${info.maxAmplification.toFixed(2)}x.` +
      free;
    return;
  }
  if (info.lastRunAt) {
    const duration = info.lastDurationMs !== null ? ` (${info.lastDurationMs} ms)` : '';
    const result = info.lastResult;
    const work =
      result !== null
        ? ` Docs: ${(result.relocatedDocuments ?? 0).toString()}, B-tree: ${(result.relocatedBtreeNodes ?? 0).toString()}, HNSW: ${(result.relocatedHnswUnits ?? 0).toString()}, trim: ${(result.reclaimedTailBlocks ?? 0).toString()}.`
        : '';
    const blocked = result?.blocked ? ' Geen veilige verdere stap gevonden; full vacuum kan nodig zijn.' : '';
    incrementalCompactionStatus.textContent =
      `Ingeschakeld. Laatste stap: ${new Date(info.lastRunAt).toLocaleTimeString()}${duration}.` + work + blocked;
    return;
  }

  incrementalCompactionStatus.textContent = 'Ingeschakeld. Kleine stappen worden automatisch gepland.';
}

async function setIncrementalCompactionEnabled(enabled: boolean): Promise<void> {
  if (!incrementalCompactionToggle) return;
  incrementalCompactionToggle.disabled = true;
  try {
    const data = await apiCall('/api/database/incremental-compaction/settings', 'POST', { enabled });
    renderIncrementalCompaction(readIncrementalCompactionInfo(data['incrementalCompaction']));
    await updateDatabaseStatus();
  } catch (error) {
    alert('Automatische compaction aanpassen mislukt: ' + (error as Error).message);
    await updateDatabaseStatus();
  } finally {
    incrementalCompactionToggle.disabled = !connectionStatus.classList.contains('connected');
  }
}

function setMaintenance(active: boolean, statusText = '', titleText = 'Database compacteren'): void {
  if (maintenanceOverlay) maintenanceOverlay.classList.toggle('hidden', !active);
  if (maintenanceTitle && titleText) maintenanceTitle.textContent = titleText;
  if (maintenanceStatus && statusText) maintenanceStatus.textContent = statusText;
  if (vacuumDbBtn) vacuumDbBtn.disabled = active || !connectionStatus.classList.contains('connected');
  if (incrementalCompactionToggle) {
    incrementalCompactionToggle.disabled = active || !connectionStatus.classList.contains('connected');
  }
}

// ── Collections ──────────────────────────────────────────────

async function loadCollections(): Promise<void> {
  try {
    const data = await apiCall('/api/collections');
    state.collections = (data['collections'] as string[] | undefined) ?? [];
    renderCollectionList();
    void updateDatabaseStatus();
  } catch (error) {
    console.error('Failed to load collections:', error);
  }
}

async function deleteCollection(collection: string) {
  if (
    !confirm(
      `Weet je zeker dat je de collectie "${collection}" wilt verwijderen? Dit kan niet ongedaan worden gemaakt.`,
    )
  )
    return;
  try {
    await apiCall(`/api/collections/${encodeURIComponent(collection)}`, 'DELETE');
    if (state.currentCollection === collection) clearWorkspace();
    await loadCollections();
  } catch (error) {
    alert('Verwijderen mislukt: ' + (error as Error).message);
  }
}

function renderCollectionList() {
  collectionList.innerHTML = '';
  if (state.collections.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Geen collecties';
    li.className = 'empty-hint';
    collectionList.appendChild(li);
    return;
  }
  state.collections.forEach((col) => {
    const li = document.createElement('li');
    li.className = 'collection-item';
    if (col === state.currentCollection) li.classList.add('active');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'collection-name';
    nameSpan.textContent = col;
    nameSpan.onclick = () => selectCollection(col);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'collection-delete-btn';
    deleteBtn.innerHTML = '✕';
    deleteBtn.title = 'Collectie verwijderen';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      void deleteCollection(col);
    };

    li.appendChild(nameSpan);
    li.appendChild(deleteBtn);
    collectionList.appendChild(li);
  });
}

function selectCollection(collection: string) {
  state.currentCollection = collection;
  filterInput.value = '';
  closeDocView();
  renderCollectionList();
  addDocBtn.disabled = false;
  filterInput.disabled = false;
  refreshBtn.disabled = false;
  if (searchModeTextBtn) searchModeTextBtn.disabled = false;
  if (searchModeImageBtn) searchModeImageBtn.disabled = false;
  semanticSearchInput.disabled = false;
  semanticSearchBtn.disabled = false;
  semanticSearchInput.value = '';
  semanticSearchClearBtn.classList.add('hidden');
  void loadDocuments(collection);
}

// ── Documents ────────────────────────────────────────────────

async function loadDocuments(collection: string): Promise<void> {
  try {
    const data = await apiCall(`/api/documents/${encodeURIComponent(collection)}`);
    const rawDocs = (data['documents'] as string[] | undefined) ?? [];
    state.allDocuments = rawDocs.map((d) => JSON.parse(d) as Document);
    applyFilter(filterInput);
  } catch (error) {
    console.error('Failed to load documents:', error);
    dataTableBody.innerHTML = `<tr><td colspan="4" class="error">Fout bij laden: ${(error as Error).message}</td></tr>`;
  }
}

async function deleteDocument(id: string | number) {
  if (!state.currentCollection || !confirm('Wil je dit document verwijderen?')) return;
  try {
    await apiCall(
      `/api/documents/${encodeURIComponent(state.currentCollection)}/${encodeURIComponent(String(id))}`,
      'DELETE',
    );
    closeDocView();
    await loadDocuments(state.currentCollection);
    await loadCollections();
  } catch (error) {
    alert('Verwijderen mislukt: ' + (error as Error).message);
  }
}

// ── New Collection ───────────────────────────────────────────

function openNewCollectionModal() {
  if (!newCollectionModal || !newCollectionInput || !newCollectionError) return;
  newCollectionInput.value = '';
  newCollectionError.textContent = '';
  newCollectionModal.classList.remove('hidden');
  newCollectionInput.focus();
}

function createCollection(name: string) {
  if (!newCollectionModal || !newCollectionError) return;
  const trimmed = name.trim();
  if (!trimmed) {
    newCollectionError.textContent = 'Naam mag niet leeg zijn.';
    return;
  }
  newCollectionModal.classList.add('hidden');
  state.currentCollection = trimmed;
  renderCollectionList();
  addDocBtn.disabled = false;
  filterInput.disabled = false;
  refreshBtn.disabled = false;
  dataTableHead.innerHTML = '';
  dataTableBody.innerHTML =
    '<tr><td colspan="3">Voeg het eerste document toe om deze collectie aan te maken.</td></tr>';
  openDocView({ id: '' }, true, true);
}

// ── Semantic Search ──────────────────────────────────────────

async function performSemanticSearch() {
  if (!state.currentCollection) return;

  const query = semanticSearchInput.value.trim();
  if (!query) {
    semanticSearchClearBtn.classList.add('hidden');
    applyFilter(filterInput);
    return;
  }

  semanticSearchClearBtn.classList.remove('hidden');
  semanticSearchBtn.classList.add('loading');
  semanticSearchBtn.disabled = true;
  semanticSearchInput.disabled = true;
  if (searchModeTextBtn) searchModeTextBtn.disabled = true;
  if (searchModeImageBtn) searchModeImageBtn.disabled = true;

  try {
    const data = await apiCall(
      `/api/documents/${encodeURIComponent(state.currentCollection)}/search?q=${encodeURIComponent(query)}&limit=50`,
    );
    const rawDocs = (data['documents'] as string[] | undefined) ?? [];
    let searchResults = rawDocs.map((d) => JSON.parse(d) as Document);

    if (state.currentSearchMode === 'image') {
      searchResults = searchResults.filter((doc) => Object.keys(doc).some((key) => isImageField(key)));
    }

    renderTable(searchResults);
  } catch (error) {
    console.error('Semantic search failed:', error);
    dataTableBody.innerHTML = `<tr><td colspan="4" class="error">AI Zoekfout: ${(error as Error).message}</td></tr>`;
  } finally {
    semanticSearchBtn.classList.remove('loading');
    semanticSearchBtn.disabled = false;
    semanticSearchInput.disabled = false;
    if (searchModeTextBtn) searchModeTextBtn.disabled = false;
    if (searchModeImageBtn) searchModeImageBtn.disabled = false;
    semanticSearchInput.focus();
  }
}

// ── Event Listeners ──────────────────────────────────────────

// Connection
connectConfirmBtn.addEventListener('click', () => {
  const fp = dbFilepathInput.value.trim();
  if (fp) void connect(fp);
});
createNewBtn.addEventListener('click', () => {
  const fp = dbFilepathInput.value.trim();
  if (fp) void createNew(fp);
});

// Header dropdown menu
if (headerMenuBtn && headerDropdown) {
  headerMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    headerDropdown.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (
      !headerDropdown.classList.contains('hidden') &&
      !headerDropdown.contains(e.target as Node) &&
      e.target !== headerMenuBtn
    ) {
      headerDropdown.classList.add('hidden');
    }
  });
}

disconnectBtn.addEventListener('click', () => {
  if (headerDropdown) headerDropdown.classList.add('hidden');
  void disconnect();
});
if (resetDbBtn) {
  resetDbBtn.addEventListener('click', () => {
    if (headerDropdown) headerDropdown.classList.add('hidden');
    void resetDb();
  });
}
if (vacuumDbBtn) {
  vacuumDbBtn.addEventListener('click', () => void compactDatabase());
}
if (incrementalCompactionToggle) {
  incrementalCompactionToggle.addEventListener('change', () => {
    void setIncrementalCompactionEnabled(incrementalCompactionToggle.checked);
  });
}

// Toolbar
addDocBtn.addEventListener('click', () => openDocView({ id: '' }, true, true));
refreshBtn.addEventListener('click', () => {
  if (state.currentCollection) void loadDocuments(state.currentCollection);
});
filterInput.addEventListener('input', () => applyFilter(filterInput));

// Search mode toggle
if (searchModeTextBtn && searchModeImageBtn) {
  searchModeTextBtn.addEventListener('click', () => {
    state.currentSearchMode = 'text';
    searchModeTextBtn.classList.add('active');
    searchModeImageBtn.classList.remove('active');
    semanticSearchInput.placeholder = 'Zoek op betekenis...';
  });
  searchModeImageBtn.addEventListener('click', () => {
    state.currentSearchMode = 'image';
    searchModeImageBtn.classList.add('active');
    searchModeTextBtn.classList.remove('active');
    semanticSearchInput.placeholder = 'Zoek foto op beschrijving...';
  });
}

// Semantic search
semanticSearchInput.addEventListener('keyup', (e) => {
  if (e.key === 'Enter') void performSemanticSearch();
});
semanticSearchBtn.addEventListener('click', () => void performSemanticSearch());
semanticSearchClearBtn.addEventListener('click', () => {
  semanticSearchInput.value = '';
  semanticSearchClearBtn.classList.add('hidden');
  applyFilter(filterInput);
});

// New collection
if (newCollectionBtn) newCollectionBtn.addEventListener('click', openNewCollectionModal);
if (newCollectionConfirmBtn) {
  newCollectionConfirmBtn.addEventListener('click', () => createCollection(newCollectionInput?.value ?? ''));
}
if (newCollectionInput) {
  newCollectionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createCollection(newCollectionInput.value);
  });
}

// Document view
docViewBack.addEventListener('click', closeDocView);
docViewEdit.addEventListener('click', enterEditMode);
docViewSave.addEventListener('click', () => void saveDocView());
docViewCancel.addEventListener('click', cancelEditMode);
docViewDelete.addEventListener('click', () => {
  if (state.currentViewDoc && state.currentCollection) {
    void deleteDocument(state.currentViewDoc['id'] as string | number);
  }
});

// Global
document.addEventListener('click', closeAllDropdowns);
modalCloseBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const modal = btn.closest('.modal');
    if (modal) modal.classList.add('hidden');
  });
});

window.setInterval(() => {
  if (connectionStatus.classList.contains('connected')) void updateDatabaseStatus();
}, 5_000);

// Show connect modal on startup
connectModal.classList.remove('hidden');
