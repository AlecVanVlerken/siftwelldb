// Client-side logic for SimpleDBMS
// author: Alexandre-Gatien Bienfet

interface Document {
  [key: string]: unknown;
}

// State
let currentCollection: string | null = null;
let collections: string[] = [];
let allDocuments: Document[] = []; // Cache for client-side filter

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
const docModal = document.getElementById('document-modal') as HTMLElement;
const docContent = document.getElementById('doc-content') as HTMLTextAreaElement;
const saveDocBtn = document.getElementById('save-doc-btn') as HTMLButtonElement;
const docError = document.getElementById('doc-error') as HTMLElement;
const docModalTitle = document.getElementById('doc-modal-title') as HTMLElement;
const modalCloseBtns = document.querySelectorAll('.close-btn');
const resetDbBtn = document.getElementById('reset-db-btn') as HTMLButtonElement | null;
const newCollectionBtn = document.getElementById('new-collection-btn') as HTMLButtonElement | null;
const newCollectionModal = document.getElementById('new-collection-modal');
const newCollectionInput = document.getElementById('new-collection-name') as HTMLInputElement | null;
const newCollectionConfirmBtn = document.getElementById('new-collection-confirm-btn') as HTMLButtonElement | null;
const newCollectionError = document.getElementById('new-collection-error');

// API Helper
async function apiCall(endpoint: string, method: string = 'GET', body?: unknown) {
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(endpoint, options);
  const data = (await response.json()) as { error?: string; [key: string]: unknown };
  if (!response.ok) {
    throw new Error(data['error'] ?? 'API Error');
  }
  return data;
}

// --- Connection Functions ---

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
  connectionStatus.style.color = 'green';
  disconnectBtn.disabled = false;
  if (resetDbBtn) resetDbBtn.disabled = false;
  if (newCollectionBtn) newCollectionBtn.disabled = false;
  connectModal.classList.add('hidden');
}

async function disconnect() {
  try {
    await apiCall('/api/disconnect', 'POST');
    connectionStatus.textContent = 'Disconnected';
    connectionStatus.style.color = '';
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
    await loadCollections();
    alert('Database reset successfully.');
  } catch (error) {
    alert('Reset failed: ' + (error as Error).message);
  }
}

// --- Collection Functions ---

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
    li.textContent = 'No collections yet';
    li.style.fontStyle = 'italic';
    li.style.opacity = '0.6';
    li.style.cursor = 'default';
    collectionList.appendChild(li);
    return;
  }
  collections.forEach((col) => {
    const li = document.createElement('li');
    li.textContent = col;
    li.onclick = () => selectCollection(col);
    if (col === currentCollection) {
      li.classList.add('active');
    }
    collectionList.appendChild(li);
  });
}

function selectCollection(collection: string) {
  currentCollection = collection;
  filterInput.value = '';
  renderCollectionList();
  addDocBtn.disabled = false;
  filterInput.disabled = false;
  refreshBtn.disabled = false;
  void loadDocuments(collection);
}

// --- Document Functions ---

async function loadDocuments(collection: string) {
  try {
    const data = await apiCall(`/api/documents/${encodeURIComponent(collection)}`);
    const rawDocs = (data['documents'] as string[] | undefined) ?? [];
    allDocuments = rawDocs.map((d) => JSON.parse(d) as Document);
    applyFilter();
  } catch (error) {
    console.error('Failed to load documents:', error);
    dataTableBody.innerHTML = `<tr><td colspan="100%" class="error">Error loading documents: ${(error as Error).message}</td></tr>`;
  }
}

function applyFilter() {
  const query = filterInput.value.trim().toLowerCase();
  if (!query) {
    renderTable(allDocuments);
    return;
  }
  const filtered = allDocuments.filter((doc) => {
    return Object.values(doc).some((v) => String(v).toLowerCase().includes(query));
  });
  renderTable(filtered);
}

function renderTable(documents: Document[]) {
  dataTableHead.innerHTML = '';
  dataTableBody.innerHTML = '';

  if (documents.length === 0) {
    dataTableBody.innerHTML = '<tr><td colspan="100%">No documents found</td></tr>';
    return;
  }

  // Collect all unique keys
  const keys = new Set<string>();
  documents.forEach((doc) => {
    Object.keys(doc).forEach((k) => keys.add(k));
  });
  // Ensure 'id' is first
  const headers = Array.from(keys).sort((a, b) => {
    if (a === 'id') return -1;
    if (b === 'id') return 1;
    return a.localeCompare(b);
  });

  // Render Headers
  const trHead = document.createElement('tr');
  headers.forEach((key) => {
    const th = document.createElement('th');
    th.textContent = key;
    trHead.appendChild(th);
  });
  const thActions = document.createElement('th');
  thActions.textContent = 'Actions';
  trHead.appendChild(thActions);
  dataTableHead.appendChild(trHead);

  // Render Rows
  documents.forEach((doc) => {
    const tr = document.createElement('tr');
    headers.forEach((key) => {
      const td = document.createElement('td');
      const value = doc[key];
      if (typeof value === 'object' && value !== null) {
        td.textContent = JSON.stringify(value);
      } else if (value !== null && value !== undefined) {
        td.textContent = String(value as string | number | boolean);
      } else {
        td.textContent = '';
      }
      tr.appendChild(td);
    });

    // Actions
    const tdActions = document.createElement('td');

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.style.backgroundColor = '#e74c3c';
    deleteBtn.style.fontSize = '0.8rem';
    deleteBtn.style.padding = '0.2rem 0.5rem';
    deleteBtn.onclick = () => {
      void deleteDocument(doc['id'] as string | number);
    };
    tdActions.appendChild(deleteBtn);

    tr.appendChild(tdActions);
    dataTableBody.appendChild(tr);
  });
}

async function addDocument(content: string) {
  if (!currentCollection) return;
  docError.textContent = '';
  try {
    const doc: unknown = JSON.parse(content);
    await apiCall(`/api/documents/${encodeURIComponent(currentCollection)}`, 'POST', { document: doc });
    docModal.classList.add('hidden');
    docContent.value = '';
    await loadCollections(); // refresh sidebar (shows new collection instantly)
    await loadDocuments(currentCollection);
  } catch (error) {
    docError.textContent = (error as Error).message;
  }
}

async function deleteDocument(id: string | number) {
  if (!currentCollection || !confirm('Are you sure you want to delete this document?')) return;
  try {
    await apiCall(
      `/api/documents/${encodeURIComponent(currentCollection)}/${encodeURIComponent(String(id))}`,
      'DELETE',
    );
    await loadDocuments(currentCollection);
  } catch (error) {
    alert('Failed to delete: ' + (error as Error).message);
  }
}

// --- New Collection ---

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
    newCollectionError.textContent = 'Collection name cannot be empty.';
    return;
  }
  // Close modal and pre-select the collection name.
  // The backend creates the collection on first document insert.
  newCollectionModal.classList.add('hidden');
  currentCollection = trimmed;
  renderCollectionList();
  addDocBtn.disabled = false;
  filterInput.disabled = false;
  refreshBtn.disabled = false;
  dataTableHead.innerHTML = '';
  dataTableBody.innerHTML = '<tr><td colspan="100%">Add the first document to create this collection.</td></tr>';
  docModalTitle.textContent = `Add Document to "${trimmed}"`;
  docError.textContent = '';
  docContent.value = '';
  docModal.classList.remove('hidden');
}

// --- Event Listeners ---

connectConfirmBtn.addEventListener('click', () => {
  const filepath = dbFilepathInput.value.trim();
  if (filepath) void connect(filepath);
});

const createNewBtn = document.getElementById('create-new-btn') as HTMLButtonElement;
createNewBtn.addEventListener('click', () => {
  const filepath = dbFilepathInput.value.trim();
  if (filepath) void createNew(filepath);
});

disconnectBtn.addEventListener('click', () => {
  void disconnect();
});

if (resetDbBtn) {
  resetDbBtn.addEventListener('click', () => {
    void resetDb();
  });
}

addDocBtn.addEventListener('click', () => {
  docModalTitle.textContent = 'Add Document';
  docError.textContent = '';
  docContent.value = '';
  docModal.classList.remove('hidden');
});

saveDocBtn.addEventListener('click', () => {
  void addDocument(docContent.value);
});

refreshBtn.addEventListener('click', () => {
  if (currentCollection) void loadDocuments(currentCollection);
});

filterInput.addEventListener('input', () => {
  applyFilter();
});

if (newCollectionBtn) {
  newCollectionBtn.addEventListener('click', openNewCollectionModal);
}

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

modalCloseBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const modal = btn.closest('.modal');
    if (modal) modal.classList.add('hidden');
  });
});

// Initial state: show connect modal
connectModal.classList.remove('hidden');
