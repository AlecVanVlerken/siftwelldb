// author: Alexandre-Gatien Bienfet
// date: 2026-02-23

interface Document {
  [key: string]: unknown;
}

// State
let currentCollection: string | null = null;
let collections: string[] = [];
let allDocuments: Document[] = [];
let currentViewDoc: Document | null = null;
let isEditMode = false;
let isNewDocument = false;

// DOM Elements
const connectionStatus = document.getElementById('connection-status') as HTMLElement;
const disconnectBtn = document.getElementById('disconnect-btn') as HTMLButtonElement;
const collectionList = document.getElementById('collection-list') as HTMLUListElement;
const connectModal = document.getElementById('connect-modal') as HTMLElement;
const dbFilepathInput = document.getElementById('db-filepath') as HTMLInputElement;
const connectConfirmBtn = document.getElementById('connect-confirm-btn') as HTMLButtonElement;
const connectError = document.getElementById('connect-error') as HTMLElement;
const dataTableHead = document.querySelector('#data-table thead') as HTMLElement;
const dataTableBody = document.querySelector('#data-table tbody') as HTMLElement;
const addDocBtn = document.getElementById('add-doc-btn') as HTMLButtonElement;
const filterInput = document.getElementById('filter-input') as HTMLInputElement;
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement;
const modalCloseBtns = document.querySelectorAll('.close-btn');
const resetDbBtn = document.getElementById('reset-db-btn') as HTMLButtonElement | null;
const newCollectionBtn = document.getElementById('new-collection-btn') as HTMLButtonElement | null;
const newCollectionModal = document.getElementById('new-collection-modal');
const newCollectionInput = document.getElementById('new-collection-name') as HTMLInputElement | null;
const newCollectionConfirmBtn = document.getElementById('new-collection-confirm-btn') as HTMLButtonElement | null;
const newCollectionError = document.getElementById('new-collection-error');

// Doc view elements
const docView = document.getElementById('doc-view') as HTMLElement;
const docViewTitle = document.getElementById('doc-view-title') as HTMLElement;
const docViewFields = document.getElementById('doc-view-fields') as HTMLElement;
const docViewContent = document.getElementById('doc-view-content') as HTMLElement;
const docViewBack = document.getElementById('doc-view-back') as HTMLButtonElement;
const docViewEdit = document.getElementById('doc-view-edit') as HTMLButtonElement;
const docViewSave = document.getElementById('doc-view-save') as HTMLButtonElement;
const docViewCancel = document.getElementById('doc-view-cancel') as HTMLButtonElement;
const docViewDelete = document.getElementById('doc-view-delete') as HTMLButtonElement;

// ─── API Helper ──────────────────────────────────────────────
async function apiCall(endpoint: string, method: string = 'GET', body?: unknown) {
  const options: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(endpoint, options);
  const data = (await response.json()) as { error?: string; [key: string]: unknown };
  if (!response.ok) throw new Error(data['error'] ?? 'API Error');
  return data;
}

// ─── Utilities ───────────────────────────────────────────────
function toDisplayString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHTML(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Connection ───────────────────────────────────────────────
async function connect(filepath: string) {
  connectError.textContent = '';
  try {
    await apiCall('/api/connect', 'POST', { filepath });
    onConnected(filepath);
    await loadCollections();
  } catch (error) {
    connectError.textContent = (error as Error).message;
  }
}

async function createNew(filepath: string) {
  connectError.textContent = '';
  try {
    await apiCall('/api/create', 'POST', { filepath });
    onConnected(filepath);
    await loadCollections();
  } catch (error) {
    connectError.textContent = (error as Error).message;
  }
}

function onConnected(filepath: string) {
  connectionStatus.textContent = `Connected: ${filepath}`;
  connectionStatus.classList.add('connected');
  disconnectBtn.disabled = false;
  if (resetDbBtn) resetDbBtn.disabled = false;
  if (newCollectionBtn) newCollectionBtn.disabled = false;
  connectModal.classList.add('hidden');
}

async function disconnect() {
  try {
    await apiCall('/api/disconnect', 'POST');
    connectionStatus.textContent = 'Disconnected';
    connectionStatus.classList.remove('connected');
    disconnectBtn.disabled = true;
    if (resetDbBtn) resetDbBtn.disabled = true;
    if (newCollectionBtn) newCollectionBtn.disabled = true;
    collectionList.innerHTML = '';
    dataTableHead.innerHTML = '';
    dataTableBody.innerHTML = '';
    allDocuments = [];
    addDocBtn.disabled = true;
    filterInput.disabled = true;
    filterInput.value = '';
    refreshBtn.disabled = true;
    closeDocView();
    connectModal.classList.remove('hidden');
    currentCollection = null;
  } catch (error) {
    console.error('Disconnect failed:', error);
  }
}

async function resetDb() {
  if (!confirm('Reset the database? This will delete ALL data permanently.')) return;
  try {
    await apiCall('/api/debug/reset', 'POST');
    currentCollection = null;
    allDocuments = [];
    dataTableHead.innerHTML = '';
    dataTableBody.innerHTML = '';
    filterInput.value = '';
    closeDocView();
    await loadCollections();
    alert('Database reset successfully.');
  } catch (error) {
    alert('Reset failed: ' + (error as Error).message);
  }
}

// ─── Collections ─────────────────────────────────────────────
async function loadCollections() {
  try {
    const data = await apiCall('/api/collections');
    collections = (data['collections'] as string[] | undefined) ?? [];
    renderCollectionList();
  } catch (error) {
    console.error('Failed to load collections:', error);
  }
}

function renderCollectionList() {
  collectionList.innerHTML = '';
  if (collections.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Geen collecties';
    li.className = 'empty-hint';
    collectionList.appendChild(li);
    return;
  }
  collections.forEach((col) => {
    const li = document.createElement('li');
    li.textContent = col;
    li.onclick = () => selectCollection(col);
    if (col === currentCollection) li.classList.add('active');
    collectionList.appendChild(li);
  });
}

function selectCollection(collection: string) {
  currentCollection = collection;
  filterInput.value = '';
  closeDocView();
  renderCollectionList();
  addDocBtn.disabled = false;
  filterInput.disabled = false;
  refreshBtn.disabled = false;
  void loadDocuments(collection);
}

// ─── Documents ───────────────────────────────────────────────
async function loadDocuments(collection: string) {
  try {
    const data = await apiCall(`/api/documents/${encodeURIComponent(collection)}`);
    const rawDocs = (data['documents'] as string[] | undefined) ?? [];
    allDocuments = rawDocs.map((d) => JSON.parse(d) as Document);
    applyFilter();
  } catch (error) {
    console.error('Failed to load documents:', error);
    dataTableBody.innerHTML = `<tr><td colspan="4" class="error">Fout bij laden: ${(error as Error).message}</td></tr>`;
  }
}

function applyFilter() {
  const query = filterInput.value.trim().toLowerCase();
  if (!query) {
    renderTable(allDocuments);
    return;
  }
  const filtered = allDocuments.filter((doc) =>
    Object.values(doc).some((v) => String(v).toLowerCase().includes(query)),
  );
  renderTable(filtered);
}

function renderTable(documents: Document[]) {
  dataTableHead.innerHTML = '';
  dataTableBody.innerHTML = '';

  // Header
  const trHead = document.createElement('tr');
  ['ID', 'Grootte', ''].forEach((label) => {
    const th = document.createElement('th');
    th.textContent = label;
    if (!label) th.className = 'col-actions';
    trHead.appendChild(th);
  });
  dataTableHead.appendChild(trHead);

  if (documents.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="3" class="empty-row">Geen documenten gevonden</td>';
    dataTableBody.appendChild(tr);
    return;
  }

  documents.forEach((doc) => {
    const tr = document.createElement('tr');
    tr.className = 'doc-row';

    const id = toDisplayString(doc['id']) || '—';
    const size = formatSize(new TextEncoder().encode(JSON.stringify(doc)).length);

    const tdId = document.createElement('td');
    tdId.textContent = id;
    tdId.className = 'col-id';

    const tdSize = document.createElement('td');
    tdSize.textContent = size;

    // Click on row opens document view
    [tdId, tdSize].forEach((td) => {
      td.style.cursor = 'pointer';
      td.onclick = () => openDocView(doc, false);
    });

    // Three-dot action menu
    const tdActions = document.createElement('td');
    tdActions.className = 'col-actions';

    const menuBtn = document.createElement('button');
    menuBtn.className = 'menu-btn';
    menuBtn.textContent = '⋯';
    menuBtn.setAttribute('aria-label', 'Acties');

    const dropdown = document.createElement('div');
    dropdown.className = 'dropdown hidden';

    const editItem = document.createElement('button');
    editItem.className = 'dropdown-item';
    editItem.textContent = 'Bewerken';
    editItem.onclick = (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      openDocView(doc, true); // Open doc view in edit mode
    };

    const deleteItem = document.createElement('button');
    deleteItem.className = 'dropdown-item dropdown-item--danger';
    deleteItem.textContent = 'Verwijderen';
    deleteItem.onclick = (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      void deleteDocument(doc['id'] as string | number);
    };

    dropdown.appendChild(editItem);
    dropdown.appendChild(deleteItem);

    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const isOpen = !dropdown.classList.contains('hidden');
      closeAllDropdowns();
      if (!isOpen) {
        dropdown.classList.remove('hidden');
      }
    };

    tdActions.appendChild(menuBtn);
    tdActions.appendChild(dropdown);

    tr.appendChild(tdId);
    tr.appendChild(tdSize);
    tr.appendChild(tdActions);
    dataTableBody.appendChild(tr);
  });
}

function closeAllDropdowns() {
  document.querySelectorAll('.dropdown').forEach((d) => d.classList.add('hidden'));
}

// ─── Document View (detail page) ─────────────────────────────
function openDocView(doc: Document, editMode: boolean, isNew = false) {
  currentViewDoc = doc;
  isEditMode = editMode;
  isNewDocument = isNew;

  // Title — ID at the top
  if (isNew) {
    docViewTitle.innerHTML = `<input type="text" id="doc-view-title-input" placeholder="Titel / Document ID" value="" autocomplete="off">`;
  } else {
    const id = toDisplayString(doc['id']) || 'Document';
    docViewTitle.textContent = id;
  }

  // Render fields
  renderDocFields(doc, editMode);

  // Toggle button visibility
  setEditModeUI(editMode);

  // Show the view
  docView.classList.remove('hidden');
}

function renderDocFields(doc: Document, editMode: boolean) {
  docViewFields.innerHTML = '';
  docViewContent.innerHTML = '';

  const entries = Object.entries(doc).filter(([key]) => key !== 'id');

  let contentHTML = '';
  entries.forEach(([key, value]) => {
    contentHTML += `<div class="doc-field-section">`;
    if (isNewDocument || editMode) {
      contentHTML += `<h2><input type="text" class="doc-field-section-title" value="${escapeHTML(key)}" placeholder="Sectie Naam"><button class="remove-field-btn" onclick="this.closest('.doc-field-section').remove()">✕</button></h2>`;
    } else {
      contentHTML += `<h2>${escapeHTML(key)}</h2>`;
    }

    // Convert value to display string; format objects as JSON strings
    const displayValue =
      typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : toDisplayString(value);

    if (editMode) {
      contentHTML += `<textarea class="doc-field-value is-object" data-key="${escapeHTML(key)}" data-original="${escapeHTML(displayValue)}">${escapeHTML(displayValue)}</textarea>`;
    } else {
      contentHTML += `<div class="doc-field-value is-object">${escapeHTML(displayValue)}</div>`;
    }
    contentHTML += `</div>`;
  });

  if (editMode) {
    contentHTML += `<div class="add-field-btn-wrapper">
      <button id="add-doc-field-btn">+ Nieuwe Sectie Toevoegen</button>
    </div>`;
  }

  // Meta info
  if (!isNewDocument) {
    const totalFields = Object.keys(doc).length;
    contentHTML +=
      `<p class="doc-meta">Dit document bevat ${totalFields} veld${totalFields !== 1 ? 'en' : ''}. ` +
      `Grootte: ${formatSize(new TextEncoder().encode(JSON.stringify(doc)).length)}.</p>`;
  }

  docViewContent.innerHTML = contentHTML;

  if (editMode) {
    const addBtn = document.getElementById('add-doc-field-btn');
    if (addBtn) addBtn.onclick = () => addNewFieldToView();
  }
}

function addNewFieldToView() {
  const section = document.createElement('div');
  section.className = 'doc-field-section';

  const h2 = document.createElement('h2');
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'doc-field-section-title';
  titleInput.placeholder = 'Sectie Naam';

  const delBtn = document.createElement('button');
  delBtn.className = 'remove-field-btn';
  delBtn.innerHTML = '✕';
  delBtn.onclick = () => section.remove();

  h2.appendChild(titleInput);
  h2.appendChild(delBtn);

  const textarea = document.createElement('textarea');
  textarea.className = 'doc-field-value is-object';
  textarea.placeholder = 'Tekst weergave...';

  section.appendChild(h2);
  section.appendChild(textarea);

  const wrapper = docViewContent.querySelector('.add-field-btn-wrapper');
  if (wrapper) {
    docViewContent.insertBefore(section, wrapper);
  } else {
    docViewContent.appendChild(section);
  }
  titleInput.focus();
}

function setEditModeUI(editMode: boolean) {
  if (editMode) {
    docViewEdit.classList.add('hidden');
    docViewSave.classList.remove('hidden');
    docViewCancel.classList.remove('hidden');
  } else {
    docViewEdit.classList.remove('hidden');
    docViewSave.classList.add('hidden');
    docViewCancel.classList.add('hidden');
  }
}

function closeDocView() {
  docView.classList.add('hidden');
  currentViewDoc = null;
  isEditMode = false;
}

async function saveDocView() {
  if (!currentCollection) return;

  if (isNewDocument) {
    const titleInput = document.getElementById('doc-view-title-input') as HTMLInputElement;
    const id = titleInput?.value.trim();
    if (!id) {
      alert('Vergeet niet een Document ID (Titel) in te vullen.');
      return;
    }

    const newDoc: Record<string, unknown> = { id };

    const sections = docViewContent.querySelectorAll('.doc-field-section');
    sections.forEach((sec) => {
      const titleEl = sec.querySelector('.doc-field-section-title') as HTMLInputElement;
      const title = titleEl ? titleEl.value.trim() : sec.querySelector('h2')?.textContent?.replace('✕', '').trim();

      const textarea = sec.querySelector('textarea');
      if (title && textarea && textarea.value.trim() !== '') {
        let val: unknown = textarea.value;
        try {
          val = JSON.parse(textarea.value);
        } catch {
          /* keep as string */
        }
        newDoc[title] = val;
      }
    });

    try {
      await apiCall(`/api/documents/${encodeURIComponent(currentCollection)}`, 'POST', { document: newDoc });
      closeDocView();
      await loadDocuments(currentCollection);
    } catch (error) {
      alert('Opslaan mislukt: ' + (error as Error).message);
    }
    return;
  }

  // Existing document update logic
  if (!currentViewDoc) return;
  const id = toDisplayString(currentViewDoc['id']);
  const saves: Promise<unknown>[] = [];

  const textareas = docViewContent.querySelectorAll<HTMLTextAreaElement>('textarea');
  textareas.forEach((textarea) => {
    const sec = textarea.closest('.doc-field-section');
    const titleEl = sec?.querySelector('.doc-field-section-title') as HTMLInputElement;
    const key = titleEl ? titleEl.value.trim() : (textarea.dataset['key'] ?? '');
    const original = textarea.dataset['original'] ?? '';
    const newVal = textarea.value;

    if (newVal !== original && key) {
      let parsed: unknown = newVal;
      try {
        parsed = JSON.parse(newVal);
      } catch {
        /* keep as string */
      }
      saves.push(
        apiCall(`/api/documents/${encodeURIComponent(currentCollection!)}/${encodeURIComponent(id)}/edit`, 'POST', {
          field: key,
          value: parsed,
        }),
      );
    }
  });

  if (saves.length === 0) {
    isEditMode = false;
    renderDocFields(currentViewDoc, false);
    setEditModeUI(false);
    return;
  }

  try {
    await Promise.all(saves);
    await loadDocuments(currentCollection);
    const updatedDoc = allDocuments.find((d) => String(d['id']) === String(currentViewDoc!['id']));
    if (updatedDoc) {
      openDocView(updatedDoc, false);
    } else {
      closeDocView();
    }
  } catch (error) {
    alert('Opslaan mislukt: ' + (error as Error).message);
  }
}

// ─── CRUD ────────────────────────────────────────────────────

async function deleteDocument(id: string | number) {
  if (!currentCollection || !confirm('Wil je dit document verwijderen?')) return;
  try {
    await apiCall(
      `/api/documents/${encodeURIComponent(currentCollection)}/${encodeURIComponent(String(id))}`,
      'DELETE',
    );
    closeDocView();
    await loadDocuments(currentCollection);
  } catch (error) {
    alert('Verwijderen mislukt: ' + (error as Error).message);
  }
}

// ─── New Collection ───────────────────────────────────────────
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
  currentCollection = trimmed;
  renderCollectionList();
  addDocBtn.disabled = false;
  filterInput.disabled = false;
  refreshBtn.disabled = false;
  dataTableHead.innerHTML = '';
  dataTableBody.innerHTML =
    '<tr><td colspan="3">Voeg het eerste document toe om deze collectie aan te maken.</td></tr>';
  openDocView({ id: '' }, true, true);
}

// ─── Event Listeners ─────────────────────────────────────────
connectConfirmBtn.addEventListener('click', () => {
  const fp = dbFilepathInput.value.trim();
  if (fp) void connect(fp);
});

const createNewBtn = document.getElementById('create-new-btn') as HTMLButtonElement;
createNewBtn.addEventListener('click', () => {
  const fp = dbFilepathInput.value.trim();
  if (fp) void createNew(fp);
});

disconnectBtn.addEventListener('click', () => {
  void disconnect();
});
if (resetDbBtn)
  resetDbBtn.addEventListener('click', () => {
    void resetDb();
  });

addDocBtn.addEventListener('click', () => {
  openDocView({ id: '' }, true, true);
});

refreshBtn.addEventListener('click', () => {
  if (currentCollection) void loadDocuments(currentCollection);
});
filterInput.addEventListener('input', () => {
  applyFilter();
});

if (newCollectionBtn) newCollectionBtn.addEventListener('click', openNewCollectionModal);
if (newCollectionConfirmBtn) {
  newCollectionConfirmBtn.addEventListener('click', () => {
    createCollection(newCollectionInput?.value ?? '');
  });
}
if (newCollectionInput) {
  newCollectionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createCollection(newCollectionInput.value);
  });
}

// Doc view event listeners
docViewBack.addEventListener('click', closeDocView);
docViewEdit.addEventListener('click', () => {
  if (currentViewDoc) {
    isEditMode = true;
    renderDocFields(currentViewDoc, true);
    setEditModeUI(true);
  }
});
docViewSave.addEventListener('click', () => {
  void saveDocView();
});
docViewCancel.addEventListener('click', () => {
  if (currentViewDoc) {
    isEditMode = false;
    renderDocFields(currentViewDoc, false);
    setEditModeUI(false);
  }
});
docViewDelete.addEventListener('click', () => {
  if (currentViewDoc && currentCollection) {
    const id = currentViewDoc['id'] as string | number;
    closeDocView();
    void deleteDocument(id);
  }
});

// Close dropdowns when clicking elsewhere
document.addEventListener('click', () => {
  closeAllDropdowns();
});

modalCloseBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const modal = btn.closest('.modal');
    if (modal) modal.classList.add('hidden');
  });
});

connectModal.classList.remove('hidden');
