/* eslint-disable */
// @ts-nocheck
import { api } from './api-client.js';
import { $, $$ } from './dom.js';
import { buildDocumentTemplate, compactDocumentImages, validateDocumentInput } from './document-editor.js';
import { detectType, docSize, esc, fmtNum, fmtSize, imageDataUrlFromValue, isImageField } from './format.js';
import { openModal, closeModal } from './modals.js';
import {
  captureRequestContext,
  invalidateRequestContext,
  isCurrentRequestContext,
  resetDisconnectedState,
  state,
} from './state.js';
import { getSqlMutationKind } from './sql-ui.js';
import { mergeScopedModel } from './model-editor.js';

('use strict');

function toast(msg, kind = '', title = '') {
  const div = document.createElement('div');
  div.className = 'toast ' + kind;
  div.innerHTML = (title ? `<strong>${esc(title)}</strong>` : '') + esc(msg);
  $('#toasts').appendChild(div);
  setTimeout(() => div.remove(), 4000);
}

$$('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));

let documentModalMode = 'document';
let documentModalRequest = 0;
let documentModalImagePayloads = {};
let drawerEditImagePayloads = {};
const COMPRESSION_OPTIONS = ['inherit', 'off', 'none', 'gzip', 'deflate', 'brotli', 'zstd-fast', 'zstd'];
const DOCUMENT_PAGE_SIZE = 100;
const documentPages = new Map();
const documentRequests = new Map();
let collectionsRequest = 0;
let drawerRequest = 0;
let searchRequest = 0;
let chatRequest = 0;
let sqlRequest = 0;
let connectionBusy = false;
let maintenanceBusy = false;
let sqlBusy = false;
let modelModalCollection = null;
let modelModalRequest = 0;
let compressionBusy = false;
let compressionDefaultsError = null;
let compressionDefaultsRequest = 0;
let storageEpoch = 0;
let databaseStatusRequest = 0;
let overviewRefreshing = false;
const selectedDocumentIds = new Set();
let allDocumentsSelected = false;
let bulkBusy = false;
let bulkEditContext = null;
const recommendingFields = new Set();

function clearDocumentSelection() {
  selectedDocumentIds.clear();
  allDocumentsSelected = false;
}

function resetConnectionView() {
  overviewRefreshing = false;
  clearDocumentSelection();
  bulkBusy = false;
  recommendingFields.clear();
  modelModalRequest++;
  documentModalRequest++;
  resetDisconnectedState();
  collectionsRequest++;
  drawerRequest++;
  searchRequest++;
  chatRequest++;
  sqlRequest++;
  documentPages.clear();
  documentRequests.clear();
  invalidateStorageCache();
  compressionDefaultsLoadedFor = null;
  pendingSql = '';
  pendingConfirm = null;
  aiBusy = false;
  sqlBusy = false;
  maintenanceBusy = false;
  compressionBusy = false;
  compressionDefaultsError = null;
  compressionDefaultsRequest++;
  documentModalImagePayloads = {};
  drawerEditImagePayloads = {};
  for (const id of ['doc-save', 'mdl-save', 'mdl-gen', 'mdl-reload']) $('#' + id).disabled = false;
  $('#mdl-json').readOnly = false;
  closeDrawer();
  for (const modal of ['modal-document', 'modal-model', 'modal-confirm']) closeModal(modal);
  $('#sb-filter').value = '';
  updateConnState();
  render();
}

function resetSelectionView() {
  overviewRefreshing = false;
  clearDocumentSelection();
  bulkBusy = false;
  recommendingFields.clear();
  closeModal('modal-bulk-edit');
  modelModalRequest++;
  documentModalRequest++;
  invalidateRequestContext();
  searchRequest++;
  chatRequest++;
  aiBusy = false;
  state.search = { ...state.search, query: '', image: null, busy: false, results: null, error: null, elapsedMs: null };
  state.chatHistory = [];
  state.dataFilter = '';
  state.dataSort = null;
  state.compression.recommendations = {};
  state.compression.defaults = {};
  compressionBusy = false;
  compressionDefaultsError = null;
  compressionDefaultsRequest++;
  state.lab.report = null;
  state.lab.error = null;
  state.lab.busy = false;
  compressionDefaultsLoadedFor = null;
  pendingConfirm = null;
  for (const modal of ['modal-document', 'modal-model', 'modal-confirm']) closeModal(modal);
  $('#doc-save').disabled = false;
  for (const id of ['mdl-save', 'mdl-gen', 'mdl-reload']) $('#' + id).disabled = state.modelGenerating;
  closeDrawer();
}

async function loadCollectionDocuments(c, append = false) {
  const context = captureRequestContext('database');
  const request = (documentRequests.get(c) || 0) + 1;
  documentRequests.set(c, request);
  const previous = state.docsByColl[c] || [];
  const limit = append ? DOCUMENT_PAGE_SIZE : Math.min(10000, Math.max(DOCUMENT_PAGE_SIZE, previous.length));
  const offset = append ? previous.length : 0;
  const { documents, total, hasMore } = await api(
    `/api/documents/${encodeURIComponent(c)}?limit=${limit}&offset=${offset}`,
  );
  if (!isCurrentRequestContext(context) || documentRequests.get(c) !== request) return false;
  const parsed = (documents || []).map((d) => JSON.parse(d));
  const next = append ? [...previous, ...parsed] : parsed;
  state.docsByColl[c] = next;
  state.countsByColl[c] = total ?? next.length;
  documentPages.set(c, { hasMore: hasMore ?? next.length < (total ?? next.length), loading: false });
  return true;
}

function imageMimeMetadataField(fieldName) {
  return `_${fieldName}_mime`;
}

// ─────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  const context = captureRequestContext('database');
  try {
    const [status, settings, embed] = await Promise.all([
      api('/api/status'),
      api('/api/settings').catch(() => ({ geminiKeySet: false })),
      api('/api/embeddings/status').catch(() => state.search.embedStatus),
    ]);
    if (!isCurrentRequestContext(context)) return;
    state.connected = status.connected;
    state.filepath = status.filepath;
    state.geminiKeySet = settings.geminiKeySet;
    state.search.embedStatus = embed;
  } catch (e) {
    if (!isCurrentRequestContext(context)) return;
    toast('Could not reach daemon: ' + e.message, 'err');
  }

  updateConnState();
  if (state.connected) {
    closeModal('modal-connect');
    await loadCollections();
    await loadModel();
    await refreshDatabaseStatus();
    render();
  } else {
    openModal('modal-connect');
  }
}

function updateConnState() {
  const ci = $('#conn-info');
  const ct = $('#conn-text');
  if (state.connected) {
    ci.classList.add('ok');
    ct.innerHTML = `<strong>${esc(state.filepath)}</strong>`;
    $('#cm-disconnect').disabled = connectionBusy;
    $('#app').classList.remove('disconnected');
  } else {
    ci.classList.remove('ok');
    ct.textContent = 'Disconnected';
    $('#cm-disconnect').disabled = true;
    $('#app').classList.add('disconnected');
  }
  $('#app').classList.toggle('disconnected', !state.connected || connectionBusy);
  $('#sb-add-collection').disabled = !state.connected || connectionBusy;
  $('#sb-filter').disabled = !state.connected || connectionBusy;
  renderConnectionMaintenanceMenu();
}

function renderConnectionMaintenanceMenu() {
  const status = state.databaseStatus;
  const size = status?.size;
  const inc = status?.incrementalCompaction;
  const connected = state.connected;
  const sizeEl = $('#cm-db-size');
  const autoEl = $('#cm-auto-compact');
  const noteEl = $('#cm-compact-status');
  const manualEl = $('#cm-manual-compact');
  if (sizeEl) sizeEl.textContent = `Database file: ${size ? fmtSize(size.dataFileBytes) : '—'}`;
  if (autoEl) {
    autoEl.disabled = !connected || maintenanceBusy || !!status?.busyOperation;
    autoEl.checked = !!inc?.enabled;
  }
  if (manualEl) manualEl.disabled = !connected || maintenanceBusy || !!status?.busyOperation;
  if (noteEl) {
    if (!connected) noteEl.textContent = 'Open a database to compact.';
    else if (maintenanceBusy || status?.busyOperation) noteEl.textContent = 'Compaction in progress…';
    else if (!inc?.enabled) noteEl.textContent = 'Background compaction off';
    else if (inc.running) noteEl.textContent = 'Auto compact is running an incremental step.';
    else if (inc.lastError) noteEl.textContent = `Incremental compaction error: ${inc.lastError}`;
    else
      noteEl.textContent = inc.lastRunAt
        ? `Auto compact on. Last incremental step ${new Date(inc.lastRunAt).toLocaleTimeString()}.`
        : 'Auto compact on. Incremental steps run when useful.';
  }
}

async function loadCollections() {
  const context = captureRequestContext('database');
  const request = ++collectionsRequest;
  let complete = true;
  try {
    const { collections } = await api('/api/collections');
    if (!isCurrentRequestContext(context) || request !== collectionsRequest) return;
    const nextCollections = collections || [];
    const live = new Set(nextCollections);
    for (const collection of Object.keys(state.docsByColl)) {
      if (!live.has(collection)) {
        delete state.docsByColl[collection];
        documentRequests.set(collection, (documentRequests.get(collection) || 0) + 1);
        documentPages.delete(collection);
      }
    }
    for (const collection of Object.keys(state.countsByColl)) {
      if (!live.has(collection)) delete state.countsByColl[collection];
    }
    state.collections = nextCollections;
    // Pre-load counts in parallel — small ops on each collection.
    await Promise.all(
      state.collections.map(async (c) => {
        try {
          await loadCollectionDocuments(c);
        } catch {
          if (!isCurrentRequestContext(context) || request !== collectionsRequest) return;
          complete = false;
          state.countsByColl[c] = '?';
          state.docsByColl[c] = [];
        }
      }),
    );
    if (!isCurrentRequestContext(context) || request !== collectionsRequest) return;
    if (state.selectedCol && !live.has(state.selectedCol)) {
      resetSelectionView();
      state.selectedCol = null;
      state.tab = 'overview';
      render();
    }
    return complete;
  } catch (e) {
    if (!isCurrentRequestContext(context) || request !== collectionsRequest) return;
    toast('Failed to load collections: ' + e.message, 'err');
    return false;
  }
}

async function runSeedAction(label, task) {
  const context = captureRequestContext('database');
  if (state.seedBusy) {
    toast('A seed operation is already running. Wait for it to finish first.', 'warn');
    return null;
  }
  state.seedBusy = true;
  render();
  try {
    const result = await task();
    if (!isCurrentRequestContext(context)) return null;

    return result;
  } finally {
    if (isCurrentRequestContext(context)) {
      state.seedBusy = false;
      render();
    }
  }
}

async function loadModel() {
  const context = captureRequestContext('database');
  try {
    const { model } = await api('/api/conversational/model');
    if (!isCurrentRequestContext(context)) return;
    state.model = model;
  } catch {
    if (!isCurrentRequestContext(context)) return;
    state.model = null;
  }
}

async function seedDemoEmployees() {
  const context = captureRequestContext();
  try {
    const result = await runSeedAction('employees', () => api('/api/demo/employees', { method: 'POST' }));
    if (!result) return;
    toast(result.message || 'Demo data ready', result.skipped ? '' : 'ok');
    invalidateStorageCache();
    await loadCollections();
    await loadModel();
    if (!isCurrentRequestContext(context)) return;
    if (state.collections.includes('employees')) selectCollection('employees');
    render();
  } catch (e) {
    if (isCurrentRequestContext(context)) toast('Failed to seed demo data: ' + e.message, 'err');
  }
}

async function seedSemanticKnowledgeDemo() {
  const context = captureRequestContext();
  try {
    const result = await runSeedAction('semantic text', () => api('/api/demo/semantic-knowledge', { method: 'POST' }));
    if (!result) return;
    toast(result.message || 'Semantic knowledge demo ready', result.skipped ? '' : 'ok');
    invalidateStorageCache();
    await loadCollections();
    await loadModel();
    if (!isCurrentRequestContext(context)) return;
    if (state.collections.includes(result.collection || 'knowledge'))
      selectCollection(result.collection || 'knowledge');
    render();
  } catch (e) {
    if (isCurrentRequestContext(context)) toast('Failed to seed semantic knowledge demo: ' + e.message, 'err');
  }
}

async function seedSemanticImageDemo() {
  const context = captureRequestContext();
  try {
    const result = await runSeedAction('semantic images', () => api('/api/demo/semantic-images', { method: 'POST' }));
    if (!result) return;
    toast(result.message || 'Semantic image demo ready', result.skipped ? '' : 'ok');
    invalidateStorageCache();
    await loadCollections();
    await loadModel();
    if (!isCurrentRequestContext(context)) return;
    if (state.collections.includes(result.collection || 'photos')) selectCollection(result.collection || 'photos');
    render();
  } catch (e) {
    if (isCurrentRequestContext(context)) toast('Failed to seed semantic image demo: ' + e.message, 'err');
  }
}

function isValidCollectionName(name) {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

function showDocumentModalError(message) {
  const err = $('#doc-err');
  err.textContent = message;
  err.classList.remove('hidden');
}

function readCompressionOverrides(root = document) {
  const overrides = {};
  root.querySelectorAll('[data-doc-compression-field]').forEach((select) => {
    const value = select.value;
    if (value && value !== 'inherit') overrides[select.dataset.docCompressionField] = value;
  });
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function renderDocumentCompressionControls(collection, documentValue, meta) {
  const fields = Object.keys(documentValue).filter(
    (key) =>
      key !== 'id' &&
      !isImageMimeMetadata(key, documentValue) &&
      !isImageField(key, documentValue) &&
      typeof documentValue[key] === 'string',
  );
  if (!fields.length) return '<div class="empty-state" style="padding:10px;"><p>No compressible fields yet.</p></div>';
  const current = meta?.compressions || {};
  const workload = Math.round(state.compression.workload * 100);
  return `<div class="psec" style="margin-top:10px;">
    <h3>Field compression <span class="actions"><label style="font-size:11px;color:var(--t3);text-transform:none;letter-spacing:0;">Workload <span id="doc-cmp-workload-label">${workload}%</span></label></span></h3>
    <div class="pbody">
      <input id="doc-cmp-workload" type="range" min="0" max="100" value="${workload}" style="width:100%;margin-bottom:8px;">
      <p style="font-size:12px;color:var(--t3);margin:0 0 8px;">Choose per-field overrides while editing. <strong>inherit</strong> keeps the collection default; <strong>off</strong> stores this write uncompressed.</p>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${fields
          .map(
            (
              field,
            ) => `<div style="display:grid;grid-template-columns:1fr 145px auto;gap:8px;align-items:center;border:1px solid var(--bd);background:var(--bg2);padding:7px;border-radius:4px;">
          <div><strong style="font-size:12px;">${esc(field)}</strong><div style="font-size:11px;color:var(--t3);">${isImageField(field, documentValue) ? 'image field' : detectType(documentValue[field])}${current[field] ? ` · currently ${esc(current[field])}` : ''}</div></div>
          <select data-doc-compression-field="${esc(field)}" style="height:30px;border:1px solid var(--bd);background:var(--bg);color:var(--t1);border-radius:3px;">
            ${COMPRESSION_OPTIONS.map((option) => `<option value="${option}">${option}</option>`).join('')}
          </select>
          <button class="tbtn" data-doc-cmp-recommend="${esc(field)}" data-doc-cmp-collection="${esc(collection)}" style="border:1px solid var(--bd);background:var(--bg);height:30px;">Recommend</button>
        </div>`,
          )
          .join('')}
      </div>
    </div>
  </div>`;
}

function wireDocumentCompressionControls() {
  $('#doc-cmp-workload')?.addEventListener('input', (event) => {
    state.compression.workload = Number(event.target.value) / 100;
    $('#doc-cmp-workload-label').textContent = `${event.target.value}%`;
  });
  $$('[data-doc-cmp-recommend]').forEach((button) =>
    button.addEventListener('click', async () => {
      const field = button.dataset.docCmpRecommend;
      const collection = button.dataset.docCmpCollection;
      const context = captureRequestContext();
      const workload = state.compression.workload;
      try {
        button.disabled = true;
        button.textContent = '...';
        const { recommendation } = await api('/api/compression/recommendation', {
          method: 'POST',
          body: { collection, field, workload: state.compression.workload, sampleSize: 100 },
        });
        if (!isCurrentRequestContext(context) || !button.isConnected || state.compression.workload !== workload) return;
        const select = document.querySelector(`[data-doc-compression-field="${CSS.escape(field)}"]`);
        const recommended = recommendation?.recommended ?? recommendation?.algorithm;
        if (select && recommended) select.value = recommended;
        toast(`${field}: ${recommended || 'no recommendation'} recommended`, recommended ? 'ok' : 'warn');
      } catch (e) {
        if (isCurrentRequestContext(context) && button.isConnected) toast('Recommendation failed: ' + e.message, 'err');
      } finally {
        button.disabled = false;
        button.textContent = 'Recommend';
      }
    }),
  );
}

function resetDocumentImageAttachment() {
  $('#doc-image-field').value = '';
  $('#doc-image-file').value = '';
  const preview = $('#doc-image-preview');
  preview.classList.add('hidden');
  preview.querySelector('img').src = '';
  preview.querySelector('span').textContent = '';
}

function mergeImageIntoJsonText(textarea, fieldName, dataUrl, mime, imagePayloads) {
  const parsed = validateDocumentInput(textarea.value, { requireId: false, imagePayloads });
  if (!parsed.ok) throw new Error(parsed.error);
  const [, base64 = dataUrl] = dataUrl.match(/^data:image\/[a-z0-9.+-]+;base64,(.*)$/i) || [];
  parsed.value[fieldName] = base64;
  parsed.value[imageMimeMetadataField(fieldName)] = mime;
  const compacted = compactDocumentImages(parsed.value);
  Object.keys(imagePayloads).forEach((key) => delete imagePayloads[key]);
  Object.assign(imagePayloads, compacted.imagePayloads);
  textarea.value = JSON.stringify(compacted.document, null, 2);
}

async function attachImageToDocumentJson({ textarea, fieldInput, fileInput, preview, imagePayloads, error }) {
  const context = captureRequestContext();
  const current = () =>
    isCurrentRequestContext(context) &&
    textarea.isConnected &&
    (textarea.id === 'doc-json'
      ? documentModalImagePayloads === imagePayloads
      : drawerEditImagePayloads === imagePayloads);
  const file = fileInput.files?.[0];
  if (!file) return;
  const mime = file.type && file.type.startsWith('image/') ? file.type : 'image/jpeg';
  const fieldName = (fieldInput.value || 'image').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(fieldName) || fieldName.startsWith('_')) {
    error('Image field must be a normal field name such as image, photo, avatar, or cover.');
    fileInput.value = '';
    return;
  }
  try {
    const dataUrl = await readFileDataUrl(file);
    if (!current() || textarea.closest('.modal-bg')?.classList.contains('hidden')) return;
    mergeImageIntoJsonText(textarea, fieldName, dataUrl, mime, imagePayloads);
    fieldInput.value = fieldName;
    preview.querySelector('img').src = dataUrl;
    preview.querySelector('span').textContent = `${file.name} attached as ${fieldName} (${mime})`;
    preview.classList.remove('hidden');
  } catch (e) {
    if (!current()) return;
    error('Image attach failed: ' + e.message);
    fileInput.value = '';
  }
}

function openCollectionDocumentModal() {
  if (!state.connected) return;
  documentModalRequest++;
  $('#doc-save').disabled = false;
  documentModalMode = 'collection';
  $('#doc-modal-title').firstChild.textContent = 'Add collection';
  $('#doc-modal-sub').textContent = 'Collections are created by inserting their first JSON document.';
  $('#doc-collection-wrap').classList.remove('hidden');
  $('#doc-collection').value = '';
  documentModalImagePayloads = {};
  $('#doc-json').value = JSON.stringify({ id: 'first-document' }, null, 2);
  resetDocumentImageAttachment();
  $('#doc-err').classList.add('hidden');
  openModal('modal-document');
  $('#doc-collection').focus();
}

function openAddDocumentModal() {
  if (!state.selectedCol) {
    toast('Select a collection first.', 'warn');
    return;
  }
  documentModalRequest++;
  $('#doc-save').disabled = false;
  documentModalMode = 'document';
  $('#doc-modal-title').firstChild.textContent = 'Add document';
  $('#doc-modal-sub').textContent = `Insert one JSON document into ${state.selectedCol}.`;
  $('#doc-collection-wrap').classList.add('hidden');
  $('#doc-collection').value = state.selectedCol;
  const compacted = compactDocumentImages(
    buildDocumentTemplate(state.selectedCol, state.docsByColl[state.selectedCol] || []),
  );
  documentModalImagePayloads = compacted.imagePayloads;
  $('#doc-json').value = JSON.stringify(compacted.document, null, 2);
  resetDocumentImageAttachment();
  $('#doc-err').classList.add('hidden');
  openModal('modal-document');
  $('#doc-json').focus();
}

async function saveDocumentModal() {
  if (!state.connected || $('#doc-save').disabled) return;
  const context = captureRequestContext();
  const request = documentModalRequest;
  const mode = documentModalMode;
  const collection = $('#doc-collection').value.trim();
  if (!collection) {
    showDocumentModalError('Collection name is required.');
    return;
  }
  if (!isValidCollectionName(collection)) {
    showDocumentModalError('Start the collection name with a letter; use only letters, numbers and underscores.');
    return;
  }

  const parsed = validateDocumentInput($('#doc-json').value, { imagePayloads: documentModalImagePayloads });
  if (!parsed.ok) {
    showDocumentModalError(parsed.error);
    return;
  }

  const save = $('#doc-save');
  save.disabled = true;
  try {
    await api(`/api/documents/${encodeURIComponent(collection)}`, {
      method: 'POST',
      body: { document: parsed.value },
    });
    if (!isCurrentRequestContext(context)) return;
    invalidateStorageCache(collection);
    await loadCollections();
    if (!isCurrentRequestContext(context)) return;
    invalidateSemanticSearch(collection);
    if (request !== documentModalRequest || $('#modal-document').classList.contains('hidden')) {
      render();
      return;
    }
    toast(mode === 'collection' ? 'Collection created' : 'Document inserted', 'ok');
    closeModal('modal-document');
    resetSelectionView();
    state.selectedCol = collection;
    state.tab = 'data';
    state.selectedDoc = null;
    render();
    const created = (state.docsByColl[collection] || []).find((doc) => doc.id === parsed.value.id);
    if (created) openDrawer(created, (state.docsByColl[collection] || []).indexOf(created));
  } catch (e) {
    if (!isCurrentRequestContext(context) || request !== documentModalRequest) return;
    showDocumentModalError('Save failed: ' + e.message);
  } finally {
    if (isCurrentRequestContext(context) && request === documentModalRequest) save.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────
function selectCollection(c) {
  if (!state.connected || !state.collections.includes(c)) return;
  resetSelectionView();
  state.selectedCol = c;
  state.tab = 'overview';
  state.dataFilter = '';
  state.dataSort = null;
  state.search.query = '';
  state.search.image = null;
  state.search.busy = false;
  state.search.results = null;
  state.search.error = null;
  state.search.elapsedMs = null;
  state.chatHistory = [];
  state.selectedDoc = null;
  state.compression.recommendations = {};
  state.compression.defaults = {};
  state.lab.collection = c;
  state.lab.report = null;
  state.lab.error = null;
  compressionDefaultsLoadedFor = null;
  closeDrawer();
  render();
}
function selectRoot() {
  resetSelectionView();
  state.selectedCol = null;
  state.tab = 'overview';
  state.selectedDoc = null;
  state.search.query = '';
  state.search.image = null;
  state.search.busy = false;
  state.search.results = null;
  state.search.error = null;
  state.search.elapsedMs = null;
  state.chatHistory = [];
  closeDrawer();
  render();
}

// ─────────────────────────────────────────────────────────────────
// Renderers
// ─────────────────────────────────────────────────────────────────
function render() {
  renderTree();
  renderTabs();
  renderTab();
}

function getExplore(c) {
  if (!state.model || !state.model.explores) return null;
  return state.model.explores.find((e) => e.collection === c) || null;
}

function collectionFields(c) {
  const docs = state.docsByColl[c] || [];
  return Array.from(new Set(docs.flatMap((doc) => Object.keys(doc).filter((key) => !isImageMimeMetadata(key, doc)))));
}

function isImageMimeMetadata(key, doc) {
  const match = key.match(/^_(.+)_mime$/);
  return !!match && doc[match[1]] !== undefined;
}

function invalidateSemanticSearch(c) {
  if (c !== state.selectedCol) return;
  searchRequest++;
  state.search.busy = false;
  state.search.results = null;
  state.search.elapsedMs = null;
  state.search.error = null;
}

const ICONS = {
  server: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
  coll: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/></svg>`,
  field: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
};

// A collection is expanded if treeExpanded[c] === true. We default a
// newly selected collection to expanded so the first click feels right,
// but afterwards the user is in full control via the arrow.
function isCollExpanded(c) {
  if (c in state.treeExpanded) return state.treeExpanded[c];
  return state.selectedCol === c;
}

function renderTree() {
  const filter = $('#sb-filter').value.trim().toLowerCase();
  const colls = state.collections.filter((c) => !filter || c.toLowerCase().includes(filter));
  if (!state.connected) {
    $('#tree').innerHTML = `<div class="empty">Not connected. Use the connection dialog to open a database.</div>`;
    return;
  }
  // Only one database is ever connected, so there is no "database
  // node" in this tree — the connection pill in the top bar shows
  // which file is open. The explorer is just the collections list.
  let h = '';
  if (colls.length === 0) {
    h += `<div class="empty" style="padding-left:8px;">${filter ? 'No matches.' : 'No collections yet.'}${filter ? '' : '<br><button class="tbtn pri" id="tree-add-collection" style="margin-top:10px;">Add collection</button>'}</div>`;
  } else {
    for (const c of colls) {
      const isOn = state.selectedCol === c;
      const expanded = isCollExpanded(c);
      const count = state.countsByColl[c];
      h += `<button class="tn ${isOn ? 'on' : ''}" data-c="${esc(c)}" style="padding-left:8px;">
        <span class="ch" data-toggle="${esc(c)}" title="${expanded ? 'Collapse' : 'Expand'}">${expanded ? '▾' : '▸'}</span><span class="ic coll">${ICONS.coll}</span><span class="name">${esc(c)}</span><span class="ct">${count === undefined ? '…' : count}</span>
        <span class="x" data-del="${esc(c)}" title="Drop collection">✕</span>
      </button>`;
      if (expanded) {
        const fieldNames = collectionFields(c);
        h += `<div class="tn" style="padding-left:24px;color:var(--t3);"><span class="ch"> </span><span class="ic field">${ICONS.field}</span><span class="name">Fields</span><span class="ct">${fieldNames.length}</span></div>`;
        for (const f of fieldNames) {
          h += `<div class="tn" style="padding-left:40px;color:var(--t2);"><span class="ch"> </span><span class="ic field">${ICONS.field}</span><span class="name">${esc(f)}</span></div>`;
        }
      }
    }
  }
  $('#tree').innerHTML = h;
  $('#tree-add-collection')?.addEventListener('click', openCollectionDocumentModal);
  $$('#tree [data-c]').forEach((n) =>
    n.addEventListener('click', (e) => {
      if (e.target.closest('[data-del]')) return;
      // The chevron-arrow is purely an expand/collapse affordance; row
      // body still selects.
      if (e.target.closest('[data-toggle]')) {
        e.stopPropagation();
        const c = e.target.closest('[data-toggle]').dataset.toggle;
        state.treeExpanded[c] = !isCollExpanded(c);
        renderTree();
        return;
      }
      selectCollection(n.dataset.c);
    }),
  );
  $$('#tree [data-del]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmAction(
        `Drop collection “${b.dataset.del}”?`,
        'This permanently removes every document in it.',
        async () => {
          const context = captureRequestContext('database');
          try {
            await api(`/api/collections/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
            if (!isCurrentRequestContext(context)) return;
            toast(`Dropped “${b.dataset.del}”`, 'ok');
            invalidateStorageCache(b.dataset.del);
            documentPages.delete(b.dataset.del);
            await loadCollections();
            if (!isCurrentRequestContext(context)) return;
            await loadModel();
            await refreshDatabaseStatus();
            render();
          } catch (err) {
            if (!isCurrentRequestContext(context)) return;
            toast(err.message, 'err');
          }
        },
      );
    }),
  );
}

function renderTabs() {
  const otabs = $('#otabs');
  const dis = !state.selectedCol;
  otabs.innerHTML = `
    <button class="ot ${state.tab === 'overview' ? 'on' : ''}" data-t="overview"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></span>Overview</button>
    <button class="ot ${state.tab === 'data' ? 'on' : ''}" data-t="data" ${dis ? 'disabled' : ''}><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/></svg></span>Data${state.selectedCol ? `<span class="badge">${(state.docsByColl[state.selectedCol] || []).length}</span>` : ''}</button>
    <button class="ot ${state.tab === 'fields' ? 'on' : ''}" data-t="fields" ${dis ? 'disabled' : ''}><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></span>Fields</button>
    <button class="ot ${state.tab === 'compression' ? 'on' : ''}" data-t="compression" ${dis ? 'disabled' : ''}>Compression</button>
    <button class="ot ${state.tab === 'lab' ? 'on' : ''}" data-t="lab" ${dis ? 'disabled' : ''}><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 2v6L4 19a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3L14 8V2"/><path d="M8 14h8"/></svg></span>Lab</button>
    <button class="ot ${state.tab === 'sql' ? 'on' : ''}" data-t="sql"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></span>Query Language</button>
    <button class="ot ${state.tab === 'search' ? 'on' : ''}" data-t="search" ${dis ? 'disabled' : ''}><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4-4"/></svg></span>Semantic Search</button>
    <button class="ot ${state.tab === 'ai' ? 'on' : ''}" data-t="ai"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>AI Chat</button>
    <div class="sp"></div>
    <div class="meta">${state.selectedCol ? `Selected · <strong style="color:var(--ac)">${esc(state.selectedCol)}</strong>` : ''}</div>`;
  $$('.ot[data-t]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.hasAttribute('disabled')) return;
      state.tab = b.dataset.t;
      renderTabs();
      renderTab();
    }),
  );
}

function renderTab() {
  destroyAiCharts();
  if (!state.connected) {
    $('#cnt').innerHTML = '';
    return;
  }
  if (state.tab === 'overview') renderOverview();
  else if (state.tab === 'data') renderData();
  else if (state.tab === 'fields') renderFields();
  else if (state.tab === 'compression') renderCompression();
  else if (state.tab === 'lab') renderLab();
  else if (state.tab === 'sql') renderSql();
  else if (state.tab === 'search') renderSemanticSearch();
  else if (state.tab === 'ai') renderAi();
  else {
    state.tab = 'overview';
    renderOverview();
  }
}

// ─────────────────────────────────────────────────────────────────
// Overview
// ─────────────────────────────────────────────────────────────────
// Per-collection storage cache for the overview tab. Loaded lazily
// when a collection is opened so we don't pay the cost upfront for
// every collection in the sidebar.
const storageCache = new Map();
async function getCollectionStorage(c) {
  const context = captureRequestContext('database');
  const epoch = storageEpoch;
  if (storageCache.has(c)) return storageCache.get(c);
  try {
    const s = await api(`/api/collections/${encodeURIComponent(c)}/storage`);
    if (!isCurrentRequestContext(context) || epoch !== storageEpoch) return null;
    storageCache.set(c, s);
    return s;
  } catch {
    if (isCurrentRequestContext(context) && epoch === storageEpoch) storageCache.set(c, null);
    return null;
  }
}
function invalidateStorageCache(c) {
  storageEpoch++;
  if (c) storageCache.delete(c);
  else storageCache.clear();
}

async function refreshDatabaseStatus() {
  if (!state.connected) return null;
  const context = captureRequestContext('database');
  const request = ++databaseStatusRequest;
  try {
    const status = await api('/api/database/status');
    if (!isCurrentRequestContext(context) || request !== databaseStatusRequest) return null;
    if (!status.connected) {
      resetConnectionView();
      openModal('modal-connect');
      return null;
    }
    if (status.filepath !== state.filepath) {
      resetConnectionView();
      state.connected = true;
      state.filepath = status.filepath;
      state.databaseStatus = status;
      const reopened = captureRequestContext('database');
      await loadCollections();
      await loadModel();
      if (!isCurrentRequestContext(reopened)) return null;
      updateConnState();
      render();
      return status;
    }
    state.databaseStatus = status;
  } catch {
    if (!isCurrentRequestContext(context) || request !== databaseStatusRequest) return null;
    state.databaseStatus = null;
  }
  renderConnectionMaintenanceMenu();
  return state.databaseStatus;
}

async function runManualCompaction() {
  if (!state.connected || maintenanceBusy) return;
  const context = captureRequestContext('database');
  maintenanceBusy = true;
  renderConnectionMaintenanceMenu();
  try {
    toast('Full vacuum compaction started. The UI may pause briefly.', '', 'Compaction');
    const result = await api('/api/database/vacuum', { method: 'POST' });
    if (!isCurrentRequestContext(context)) return;

    toast(`Vacuum complete: ${fmtSize(result.before.dataFileBytes)} → ${fmtSize(result.after.dataFileBytes)}`, 'ok');
    closeDrawer();
    invalidateStorageCache();
    await refreshDatabaseStatus();
    await loadCollections();
    if (!isCurrentRequestContext(context)) return;
    render();
  } catch (e) {
    if (!isCurrentRequestContext(context)) return;
    toast('Full vacuum compaction failed: ' + e.message, 'err');
    await refreshDatabaseStatus();
  } finally {
    if (isCurrentRequestContext(context)) {
      maintenanceBusy = false;
      renderConnectionMaintenanceMenu();
    }
  }
}

async function setAutoCompaction(enabled) {
  if (!state.connected || maintenanceBusy) return;
  const context = captureRequestContext('database');
  maintenanceBusy = true;
  renderConnectionMaintenanceMenu();
  try {
    const result = await api('/api/database/incremental-compaction/settings', { method: 'POST', body: { enabled } });
    if (!isCurrentRequestContext(context)) return;

    state.databaseStatus = { ...(state.databaseStatus || {}), incrementalCompaction: result.incrementalCompaction };
    renderConnectionMaintenanceMenu();
    toast(result.message || 'Background incremental compaction updated', 'ok');
    if (!state.selectedCol && state.tab === 'overview') renderOverview();
  } catch (e) {
    if (!isCurrentRequestContext(context)) return;
    toast('Background incremental compaction setting failed: ' + e.message, 'err');
    await refreshDatabaseStatus();
  } finally {
    if (isCurrentRequestContext(context)) {
      maintenanceBusy = false;
      renderConnectionMaintenanceMenu();
    }
  }
}

function renderDatabaseTools(status = state.databaseStatus) {
  const size = status?.size;
  return `<div class="psec">
    <h3>Database status <span class="actions"><button class="tbtn" id="db-refresh-status" ${overviewRefreshing ? 'disabled' : ''} style="border:1px solid var(--bd);background:var(--bg2);">${overviewRefreshing ? 'Refreshing…' : 'Refresh overview'}</button></span></h3>
    <div class="pbody">
      <div class="kpis" style="margin-bottom:12px;">
        <div class="kpi"><div class="l">Database file</div><div class="v">${fmtSize(size?.dataFileBytes)}</div><div class="d">${size ? `${size.usedBlocks ?? 0} used · ${size.freeBlocks ?? 0} free blocks` : 'status unavailable'}</div></div>
        <div class="kpi"><div class="l">Amplification</div><div class="v">${size?.amplification ? size.amplification.toFixed(2) : '—'}</div><div class="d">${size?.freeTailBlocks ?? 0} free tail block${size?.freeTailBlocks === 1 ? '' : 's'}</div></div>
        <div class="kpi"><div class="l">Semantic indexes</div><div class="v" style="font-size:15px;">${status?.semanticIndexes?.length ?? 0}</div><div class="d">${status?.semanticIndexes?.length ? status.semanticIndexes.map((x) => esc(x)).join(', ') : 'none yet'}</div></div>
      </div>
    </div>
  </div>`;
}

async function refreshOverview() {
  if (!state.connected || overviewRefreshing) return;
  const context = captureRequestContext();
  overviewRefreshing = true;
  if (state.tab === 'overview') renderOverview();
  try {
    invalidateStorageCache();
    clearDocumentSelection();
    const collectionsLoaded = await loadCollections();
    const status = await refreshDatabaseStatus();
    if (!isCurrentRequestContext(context)) return;
    toast(
      status && collectionsLoaded
        ? 'Overview refreshed: documents, counts and storage reloaded.'
        : 'Overview could not be refreshed completely. Try again.',
      status && collectionsLoaded ? 'ok' : 'err',
    );
  } finally {
    if (isCurrentRequestContext(context)) {
      overviewRefreshing = false;
      if (state.tab === 'overview') render();
    }
  }
}

function wireDatabaseTools() {
  $('#db-refresh-status')?.addEventListener('click', refreshOverview);
}

function renderOverview() {
  const c = state.selectedCol;
  const context = captureRequestContext();
  if (!c) {
    const totalDocs = state.collections.reduce(
      (s, x) => s + (typeof state.countsByColl[x] === 'number' ? state.countsByColl[x] : 0),
      0,
    );
    $('#cnt').innerHTML = `<div class="ov">
      <h1><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg></span><span class="name">${esc(state.filepath || '—')}</span></h1>
      <p class="ovsub"><span><strong>${state.collections.length}</strong> collection${state.collections.length === 1 ? '' : 's'}</span><span><strong>${totalDocs.toLocaleString()}</strong> document${totalDocs === 1 ? '' : 's'}</span></p>
      ${renderDatabaseTools()}
      <div class="psec">
        <h3>Demo datasets</h3>
        <div class="pbody" style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="tbtn" data-seed-demo ${state.seedBusy ? 'disabled' : ''} style="border:1px solid var(--bd);background:var(--bg2);">${state.seedBusy ? 'Seeding...' : 'Seed employees'}</button>
          <button class="tbtn" data-seed-semantic-text ${state.seedBusy ? 'disabled' : ''} style="border:1px solid var(--bd);background:var(--bg2);">${state.seedBusy ? 'Seeding...' : 'Seed semantic text demo'}</button>
          <button class="tbtn" data-seed-semantic-images ${state.seedBusy ? 'disabled' : ''} style="border:1px solid var(--bd);background:var(--bg2);">${state.seedBusy ? 'Seeding...' : 'Seed semantic image demo'}</button>
        </div>
      </div>
      <div class="psec">
        <h3>Collections <span class="actions"><button class="tbtn pri" data-add-collection>Add collection</button></span></h3>
        <div>${
          state.collections.length === 0
            ? `<div class="empty-state"><h4>No collections yet</h4><p>This database is empty. Add a collection by inserting its first JSON document, open the <strong>Query Language</strong> tab, or seed one of the built-in demo datasets.</p><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;"><button class="tbtn pri" data-add-collection>Add collection</button><button class="tbtn" data-open-sql style="border:1px solid var(--bd);background:var(--bg2);">Open Query Language tab</button></div></div>`
            : state.collections
                .map((x) => {
                  const ex = getExplore(x);
                  const n = state.countsByColl[x];
                  return `<div class="prow" data-root-collection="${esc(x)}" style="grid-template-columns:200px 80px 1fr;cursor:pointer;"><div class="k" style="color:var(--ac);font-family:Consolas,monospace;">${esc(x)}</div><div class="v num" style="text-align:right;">${n === undefined ? '…' : n}</div><div class="v" style="font-family:Segoe UI;color:var(--t2)">${ex && ex.description ? esc(ex.description) : ex ? esc(ex.label) : '<em style="color:var(--t4);font-style:normal;">—</em>'}</div></div>`;
                })
                .join('')
        }</div>
      </div>
    </div>`;
    document.querySelector('[data-open-sql]')?.addEventListener('click', () => {
      state.tab = 'sql';
      renderTabs();
      renderTab();
    });
    $$('[data-add-collection]').forEach((b) => b.addEventListener('click', openCollectionDocumentModal));
    document.querySelector('[data-seed-demo]')?.addEventListener('click', seedDemoEmployees);
    document.querySelector('[data-seed-semantic-text]')?.addEventListener('click', seedSemanticKnowledgeDemo);
    document.querySelector('[data-seed-semantic-images]')?.addEventListener('click', seedSemanticImageDemo);
    $$('[data-root-collection]').forEach((row) =>
      row.addEventListener('click', () => {
        selectCollection(row.dataset.rootCollection);
      }),
    );
    wireDatabaseTools();
    if (!state.databaseStatus) {
      refreshDatabaseStatus().then((status) => {
        if (status && isCurrentRequestContext(context) && state.tab === 'overview') renderOverview();
      });
    }
    return;
  }

  const docs = state.docsByColl[c] || [];
  const fields = collectionFields(c);
  const totalSize = docs.reduce((s, d) => s + docSize(d), 0);
  const explore = getExplore(c);
  const count = state.countsByColl[c] ?? docs.length;

  $('#cnt').innerHTML = `<div class="ov">
    <div class="crumb"><a id="ov-back">All collections</a> ›</div>
    <h1><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/></svg></span><span class="name">${esc(c)}</span></h1>
    ${explore && explore.description ? `<p class="ovdesc">${esc(explore.description)}</p>` : ''}
    <p class="ovsub"><span><strong>${count}</strong> documents</span><span><strong>${fields.length}</strong> fields in loaded documents</span></p>
    <div class="kpis">
      <div class="kpi"><div class="l">Documents</div><div class="v">${count}</div><div class="d">${docs.length} loaded</div></div>
      <div class="kpi" title="JSON bytes for the loaded documents."><div class="l">Loaded JSON</div><div class="v">${fmtSize(totalSize)}</div><div class="d">avg ${fmtSize(docs.length ? totalSize / docs.length : 0)}/loaded doc</div></div>
      <div class="kpi" id="kpi-stored" title="Loading on-disk storage info…"><div class="l">Stored size</div><div class="v" style="font-size:14px;color:var(--t3);">loading…</div><div class="d">on-disk reservation</div></div>
    </div>
    <div class="psec"><h3>General <span class="actions"><button class="tbtn" id="ov-refresh" ${overviewRefreshing ? 'disabled' : ''}>${overviewRefreshing ? 'Refreshing…' : 'Refresh overview'}</button></span></h3><div>
      <div class="prow"><div class="k">Name</div><div class="v id">${esc(c)}</div></div>
      <div class="prow"><div class="k">Document count</div><div class="v num">${count}</div></div>
      <div class="prow"><div class="k">Field count (introspected)</div><div class="v num">${fields.length}</div></div>
    </div></div>
    <div class="psec"><h3>Storage breakdown</h3><div id="ov-storage"><div style="padding:16px;color:var(--t3);font-size:12px;">Loading…</div></div></div>
  </div>`;
  $('#ov-back')?.addEventListener('click', selectRoot);
  $('#ov-refresh')?.addEventListener('click', refreshOverview);
  (async () => {
    const s = await getCollectionStorage(c);
    if (!isCurrentRequestContext(context) || state.tab !== 'overview') return;
    const stored = s ? s.recordBytes : null;
    const kpi = $('#kpi-stored');
    if (kpi) {
      if (stored == null) {
        kpi.querySelector('.v').innerHTML = `<small style="color:var(--t3)">unavailable</small>`;
      } else {
        const f = fmtSize(stored);
        kpi.querySelector('.v').innerHTML =
          f.replace(/^([\d.]+)\s*/, (_, n) => `${n} <small>`) + (f.endsWith('B') ? '</small>' : '</small>');
        kpi.querySelector('.d').textContent = `avg ${fmtSize(s.documentCount ? stored / s.documentCount : 0)}/doc`;
        kpi.title = s.notes.records;
      }
    }
    const host = $('#ov-storage');
    if (host && s) {
      host.innerHTML = `
        <div class="prow" title="${esc(s.notes.records)}"><div class="k">Records</div><div class="v num">${fmtSize(s.recordBytes)} <small>(${s.documentCount} documents)</small></div></div>
        <div class="prow"><div class="k">Block size</div><div class="v num">${s.blockSize} B</div></div>
      `;
    } else if (host) {
      host.innerHTML = `<div style="padding:14px;color:var(--t3);font-size:12px;">Storage info unavailable.</div>`;
    }
  })();
}

// ─────────────────────────────────────────────────────────────────
// Data
// ─────────────────────────────────────────────────────────────────
async function refreshDocs(c) {
  const context = captureRequestContext('database');
  try {
    return await loadCollectionDocuments(c);
  } catch (e) {
    if (!isCurrentRequestContext(context)) return false;
    toast('Reload failed: ' + e.message, 'err');
    return false;
  }
}

function compareSortValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  if (typeof a === 'string' && typeof b === 'string') {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
  const as = typeof a === 'string' ? a : JSON.stringify(a);
  const bs = typeof b === 'string' ? b : JSON.stringify(b);
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}

function sortDocsForGrid(docs) {
  const sort = state.dataSort;
  if (!sort) return docs;
  const dir = sort.dir === 'desc' ? -1 : 1;
  return [...docs].sort((a, b) => dir * compareSortValues(a[sort.col], b[sort.col]));
}

function cycleSort(col) {
  const cur = state.dataSort;
  if (!cur || cur.col !== col) state.dataSort = { col, dir: 'asc' };
  else if (cur.dir === 'asc') state.dataSort = { col, dir: 'desc' };
  else state.dataSort = null;
}

function renderData() {
  const c = state.selectedCol;
  const context = captureRequestContext();
  const page = documentPages.get(c);
  const allDocs = state.docsByColl[c] || [];
  const filter = (state.dataFilter || '').trim().toLowerCase();
  const filtered = filter
    ? allDocs.filter((d) => Object.values(d).some((v) => v != null && String(v).toLowerCase().includes(filter)))
    : allDocs;
  const docs = sortDocsForGrid(filtered);
  // Column order is derived once from the unsorted, unfiltered document
  // list so that the headers stay stable across sort and filter changes.
  // Without this, the union-of-keys order depended on which document
  // happened to be first after sorting.
  const keys = collectionFields(c);
  $('#cnt').innerHTML = `<div style="display:flex;flex-direction:column;height:100%;">
    <div class="dt-bar">
      <div class="dt-search">
        <div class="w">
          <svg class="si" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4-4"/></svg>
          <input id="dt-filter" placeholder="Filter rows…" value="${esc(state.dataFilter || '')}"/>
          ${filter ? `<button class="clear" id="dt-filter-clear" title="Clear">✕</button>` : ''}
        </div>
      </div>
      <button class="tbtn pri" id="dt-add-document" title="Insert a JSON document"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>Add document</button>
      <button class="tbtn" id="dt-refresh" title="Reload from server"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v9h-9"/></svg>Reload</button>
      ${page?.hasMore ? `<button class="tbtn" id="dt-more" ${page.loading ? 'disabled' : ''}>${page.loading ? 'Loading…' : 'Load more'}</button>` : ''}
      <div class="dt-meta">${filter ? `${docs.length} matches · ` : ''}${allDocs.length} loaded / ${state.countsByColl[c] ?? '?'} rows</div>
    </div>
    <div class="dt-bar bulk-bar">
      <strong id="dt-selection-count">${allDocumentsSelected ? `Entire collection selected (${state.countsByColl[c] ?? '?'} rows)` : `${selectedDocumentIds.size} selected`}</strong>
      <button class="tbtn" id="dt-select-visible" ${bulkBusy ? 'disabled' : ''}>Select visible rows (${docs.length})</button>
      <button class="tbtn" id="dt-select-all" ${bulkBusy ? 'disabled' : ''}>Select entire collection</button>
      <button class="tbtn" id="dt-clear-selection" ${bulkBusy ? 'disabled' : ''}>Clear selection</button>
      <button class="tbtn" id="dt-bulk-edit" ${bulkBusy || (!allDocumentsSelected && !selectedDocumentIds.size) ? 'disabled' : ''}>Edit field</button>
      <button class="tbtn danger" id="dt-bulk-delete" ${bulkBusy || (!allDocumentsSelected && !selectedDocumentIds.size) ? 'disabled' : ''}>${bulkBusy ? 'Working…' : 'Delete selected'}</button>
    </div>
    <div class="tw" id="dg-host"></div>
  </div>`;
  renderDataGrid(docs, keys);
  $('#dt-select-visible').addEventListener('click', () => {
    allDocumentsSelected = false;
    docs.forEach((doc) => selectedDocumentIds.add(String(doc.id)));
    renderData();
  });
  $('#dt-select-all').addEventListener('click', () => {
    selectedDocumentIds.clear();
    allDocumentsSelected = true;
    renderData();
  });
  $('#dt-clear-selection').addEventListener('click', () => {
    clearDocumentSelection();
    renderData();
  });
  $('#dt-bulk-delete').addEventListener('click', () => confirmBulkMutation());
  $('#dt-bulk-edit').addEventListener('click', () => {
    bulkEditContext = captureRequestContext();
    $('#bulk-field').innerHTML = keys
      .filter((field) => field !== 'id' && !allDocs.some((doc) => isImageField(field, doc)))
      .map((field) => `<option value="${esc(field)}">${esc(field)}</option>`)
      .join('');
    $('#bulk-value').value = '';
    $('#bulk-edit-error').classList.add('hidden');
    $('#bulk-scope').textContent = allDocumentsSelected
      ? 'All documents, including unloaded pages. The field must exist on every target.'
      : `${selectedDocumentIds.size} selected documents. The field must exist on every target.`;
    openModal('modal-bulk-edit');
  });
  $('#dt-add-document').addEventListener('click', openAddDocumentModal);
  $('#dt-refresh').addEventListener('click', async () => {
    clearDocumentSelection();
    await refreshDocs(c);
    if (isCurrentRequestContext(context) && state.tab === 'data') render();
  });
  $('#dt-more')?.addEventListener('click', async () => {
    if (page.loading) return;
    page.loading = true;
    renderData();
    try {
      await loadCollectionDocuments(c, true);
    } catch (e) {
      if (isCurrentRequestContext(context)) toast('Load failed: ' + e.message, 'err');
    } finally {
      page.loading = false;
      if (isCurrentRequestContext(context) && state.tab === 'data') render();
    }
  });
  const filterEl = $('#dt-filter');
  let filterTimer = null;
  filterEl.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      if (!isCurrentRequestContext(context) || state.tab !== 'data') return;
      state.dataFilter = filterEl.value;
      renderData();
      const newEl = $('#dt-filter');
      if (newEl) {
        newEl.focus();
        newEl.setSelectionRange(filterEl.value.length, filterEl.value.length);
      }
    }, 150);
  });
  $('#dt-filter-clear')?.addEventListener('click', () => {
    state.dataFilter = '';
    renderData();
  });
}

function renderDataGrid(docs, keys) {
  if (docs.length === 0) {
    $('#dg-host').innerHTML = `<div class="dg"><div class="loader">No documents.</div></div>`;
    return;
  }
  const unionKeys = keys || [];
  const sample = (k) => {
    for (const d of docs) if (d[k] != null) return d[k];
    return null;
  };
  // Type badges: dim grey lowercase monospace, no badge for unknown/null-only columns.
  const typeBadge = (v) =>
    v == null ? '' : typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : typeof v === 'string' ? 's' : '';
  const sort = state.dataSort;
  $('#dg-host').innerHTML = `<table class="dg">
    <thead><tr><th class="selection-cell"><input type="checkbox" id="dt-select-page" aria-label="Select visible documents" ${bulkBusy ? 'disabled' : ''}></th><th class="rn">#</th>${unionKeys
      .map((k) => {
        const tb = k === 'id' ? 'pk' : typeBadge(sample(k));
        const isSorted = sort && sort.col === k;
        const arrow = isSorted ? (sort.dir === 'asc' ? '▲' : '▼') : '';
        const sortCls = isSorted ? ` sorted ${sort.dir}` : '';
        return `<th class="sortable${sortCls}" data-sort-key="${esc(k)}" title="Click to sort by ${esc(k)}"><div class="ti">${esc(k)}${tb ? `<span class="tb ${tb === 'pk' ? 'pk' : ''}">${tb}</span>` : ''}<span class="sort-ind">${arrow}</span></div></th>`;
      })
      .join('')}</tr></thead>
    <tbody>${docs
      .map((d, i) => {
        const isOn = state.selectedDoc && d.id === state.selectedDoc.id;
        return `<tr data-i="${i}" data-id="${esc(d.id)}" ${isOn ? 'class="on"' : ''}><td class="selection-cell"><input type="checkbox" data-select-document="${esc(d.id)}" aria-label="Select document ${esc(d.id)}" ${allDocumentsSelected || selectedDocumentIds.has(String(d.id)) ? 'checked' : ''} ${bulkBusy ? 'disabled' : ''}></td><td class="rn">${i + 1}</td>${unionKeys
          .map((k) => {
            const v = d[k];
            if (v === undefined || v === null) return `<td class="cnu">[NULL]</td>`;
            if (typeof v === 'number') return `<td class="cn">${fmtNum(v)}</td>`;
            if (typeof v === 'boolean') return `<td class="cb ${v ? 't' : 'f'}">${v}</td>`;
            if (k === 'id') return `<td class="ck">${esc(v)}</td>`;
            const imageUrl = imageDataUrlFromValue(k, v, d);
            if (imageUrl) return `<td class="ci"><img src="${esc(imageUrl)}" alt=""></td>`;
            return `<td class="cs">${esc(String(v))}</td>`;
          })
          .join('')}</tr>`;
      })
      .join('')}</tbody>
  </table>`;
  const pageCheckbox = $('#dt-select-page');
  const selectedVisible = docs.filter((doc) => allDocumentsSelected || selectedDocumentIds.has(String(doc.id))).length;
  pageCheckbox.checked = selectedVisible === docs.length;
  pageCheckbox.indeterminate = selectedVisible > 0 && selectedVisible < docs.length;
  pageCheckbox.addEventListener('change', () => {
    if (allDocumentsSelected) clearDocumentSelection();
    docs.forEach((doc) =>
      pageCheckbox.checked ? selectedDocumentIds.add(String(doc.id)) : selectedDocumentIds.delete(String(doc.id)),
    );
    renderData();
  });
  $$('[data-select-document]').forEach((checkbox) => {
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', () => {
      if (allDocumentsSelected) {
        clearDocumentSelection();
        // Leaving collection-wide selection creates an explicit selection of loaded rows only.
        (state.docsByColl[state.selectedCol] || []).forEach((doc) => selectedDocumentIds.add(String(doc.id)));
        toast('Selection now covers loaded rows only.', 'warn');
      }
      checkbox.checked
        ? selectedDocumentIds.add(checkbox.dataset.selectDocument)
        : selectedDocumentIds.delete(checkbox.dataset.selectDocument);
      renderData();
    });
  });
  $$('.dg tbody tr').forEach((tr) =>
    tr.addEventListener('click', () => openDrawer(docs[parseInt(tr.dataset.i, 10)], parseInt(tr.dataset.i, 10))),
  );
  $$('.dg thead th.sortable').forEach((th) =>
    th.addEventListener('click', () => {
      cycleSort(th.dataset.sortKey);
      renderData();
    }),
  );
}

function confirmBulkMutation(edit) {
  if (bulkBusy || (!allDocumentsSelected && !selectedDocumentIds.size)) return;
  const context = captureRequestContext();
  const collection = state.selectedCol;
  const selection = allDocumentsSelected
    ? { all: true }
    : {
        ids: [...selectedDocumentIds].map(
          (id) => (state.docsByColl[collection] || []).find((doc) => String(doc.id) === id)?.id ?? id,
        ),
      };
  const scope = allDocumentsSelected
    ? `ALL documents in ${collection}, including unloaded pages`
    : `${selection.ids.length} selected documents in ${collection}`;
  confirmAction(
    edit ? 'Edit selected documents' : 'Delete selected documents',
    edit
      ? `Set ${edit.field} to ${JSON.stringify(edit.value)} on ${scope}?`
      : `Permanently delete ${scope}? This cannot be undone.`,
    async () => {
      if (!isCurrentRequestContext(context) || bulkBusy) return;
      bulkBusy = true;
      closeDrawer();
      if (state.tab === 'data') renderData();
      try {
        const result = await api(`/api/documents/${encodeURIComponent(collection)}/bulk-${edit ? 'edit' : 'delete'}`, {
          method: 'POST',
          body: { ...selection, ...(edit || {}) },
        });
        if (!isCurrentRequestContext(context)) return;
        clearDocumentSelection();
        toast(`${edit ? 'Updated' : 'Deleted'} ${result.affected} documents`, 'ok');
      } catch (error) {
        if (!isCurrentRequestContext(context)) return;
        toast(`Bulk operation failed: ${error.message}. Reloading to show the current data.`, 'err');
      } finally {
        if (isCurrentRequestContext(context)) {
          invalidateStorageCache(collection);
          invalidateSemanticSearch(collection);
          await refreshDocs(collection);
          await refreshDatabaseStatus();
          if (isCurrentRequestContext(context)) {
            bulkBusy = false;
            render();
          }
        }
      }
    },
  );
}

$('#bulk-edit-save').addEventListener('click', () => {
  if (!bulkEditContext || !isCurrentRequestContext(bulkEditContext)) return;
  try {
    const value = JSON.parse($('#bulk-value').value);
    if (
      !['string', 'number', 'boolean'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw new Error('Use a JSON string, number or boolean. For example: "shipped", 25 or true.');
    }
    const field = $('#bulk-field').value;
    if (!field) throw new Error('Choose a field.');
    closeModal('modal-bulk-edit');
    confirmBulkMutation({ field, value });
  } catch (error) {
    $('#bulk-edit-error').textContent = error.message;
    $('#bulk-edit-error').classList.remove('hidden');
  }
});

function openDrawer(doc, idx) {
  state.selectedDoc = doc;
  state.selectedDocIndex = idx;
  renderDrawer();
  $('#drawer').classList.add('on');
  $$('.dg tbody tr').forEach((tr) => tr.classList.remove('on'));
  $$(`.dg tbody tr[data-i="${idx}"]`).forEach((tr) => tr.classList.add('on'));
}
function closeDrawer() {
  drawerRequest++;
  state.selectedDoc = null;
  state.selectedDocIndex = null;
  $('#drawer').classList.remove('on');
  state.selectedDoc = null;
}
$('#dr-close').addEventListener('click', closeDrawer);

async function renderDrawer() {
  const d = state.selectedDoc;
  if (!d) return;
  const context = captureRequestContext();
  const request = ++drawerRequest;
  $('#dr-title').textContent = String(d.id ?? '(no id)');
  const c = state.selectedCol;
  let meta = null;
  try {
    meta = await api(`/api/documents/${encodeURIComponent(c)}/${encodeURIComponent(String(d.id))}/metadata`);
  } catch {
    meta = null;
  }
  if (!isCurrentRequestContext(context) || request !== drawerRequest || state.selectedDoc !== d) return;
  const keys = Object.keys(d).filter((k) => !isImageMimeMetadata(k, d));
  const compsText =
    meta && meta.compressions && Object.keys(meta.compressions).length > 0
      ? Object.entries(meta.compressions)
          .map(([k, v]) => `${esc(k)}: <em style="font-style:normal;color:var(--ac)">${esc(v)}</em>`)
          .join(', ')
      : '<em style="color:var(--t3);">none</em>';
  const jsonSizeTip = 'Document size as JSON for client-side display. Computed from the in-memory object.';
  const storedSizeTip = meta
    ? `Physical disk reservation walked from the document's block chain: chainLength × blockSize (${meta.blockSize} bytes). Excludes shared index entries.`
    : '';
  $('#dr-body').innerHTML = `
    <div class="dr-stats">
      <div class="dr-stat" title="${esc(jsonSizeTip)}"><div class="l">JSON size</div><div class="v">${fmtSize(docSize(d))}</div></div>
      <div class="dr-stat" title="${esc(storedSizeTip)}"><div class="l">Stored size</div><div class="v">${meta ? `${fmtSize(meta.storedSize)} <small>on disk</small>` : '<small>—</small>'}</div></div>
    </div>
    <div class="prow" style="grid-template-columns:130px 1fr;padding:7px 0;border:none;font-size:12px"><div class="k">Compression</div><div class="v" style="font-family:Consolas;color:var(--t2)">${compsText}</div></div>
    <div style="margin-top:14px;font-size:10.5px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Fields</div>
    ${keys
      .map((k) => {
        const v = d[k];
        let cls = 'cs',
          html;
        if (v == null) {
          cls = 'nu';
          html = '[NULL]';
        } else if (typeof v === 'number') {
          cls = 'num';
          html = fmtNum(v);
        } else if (typeof v === 'boolean') {
          cls = 'bool';
          html = String(v);
        } else if (k === 'id') {
          cls = 'id';
          html = esc(v);
        } else if (imageDataUrlFromValue(k, v, d)) {
          cls = 'img';
          html = `<img src="${esc(imageDataUrlFromValue(k, v, d))}" alt="">`;
        } else {
          html = `<span data-edit="${esc(k)}">${esc(String(v))}</span>`;
        }
        return `<div class="fld-row" data-k="${esc(k)}"><div class="k">${esc(k)}</div><div class="v ${cls}">${html}</div></div>`;
      })
      .join('')}
  `;
}

$('#dr-edit').addEventListener('click', () => {
  const d = state.selectedDoc;
  if (!d) return;
  const request = ++drawerRequest;
  const context = captureRequestContext();
  const c = state.selectedCol;
  const cleanDoc = { ...d };
  const compactedDoc = compactDocumentImages(cleanDoc);
  drawerEditImagePayloads = compactedDoc.imagePayloads;
  const jsonStr = JSON.stringify(compactedDoc.document, null, 2);
  $('#dr-body').innerHTML = `
    <div class="dr-stats"><div class="dr-stat" style="grid-column:1/-1;"><div class="l">Editing</div><div class="v" style="font-size:13px;font-family:Consolas;color:var(--ac);">${esc(d.id)}</div></div></div>
    <div style="font-size:11px;color:var(--t3);margin-bottom:6px;line-height:1.4;">Edit as JSON. Strings need quotes; numbers and booleans don't. The <code style="font-size:11px;background:var(--bg);padding:0 4px;border-radius:2px;">id</code> field is read-only and must not change.</div>
    <textarea id="dr-edit-json" spellcheck="false" style="width:100%;min-height:320px;padding:9px 11px;font-family:Consolas,monospace;font-size:12px;line-height:1.5;border:1px solid var(--bd);border-radius:3px;background:var(--bg2);resize:vertical;">${esc(jsonStr)}</textarea>
    <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end;margin-top:10px;">
      <div>
        <label style="font-size:11px;color:var(--t3);font-weight:700;">Attach image field</label>
        <input type="text" id="dr-image-field" placeholder="e.g. photo" style="width:100%;height:32px;border:1px solid var(--bd);border-radius:3px;background:var(--bg2);padding:0 9px;"/>
      </div>
      <label class="tbtn" style="border:1px solid var(--bd);background:var(--bg2);height:32px;justify-content:center;">
        Choose image
        <input type="file" id="dr-image-file" accept="image/*" style="display:none;"/>
      </label>
    </div>
    <div id="dr-image-preview" class="hidden" style="display:flex;gap:8px;align-items:center;margin-top:8px;font-size:12px;color:var(--t3);">
      <img alt="" style="max-width:72px;max-height:54px;border:1px solid var(--bd);border-radius:3px;object-fit:cover;"/>
      <span></span>
    </div>
    ${renderDocumentCompressionControls(c, cleanDoc, null)}
    <div class="err hidden" id="dr-edit-err" style="margin-top:8px;padding:7px 10px;background:var(--rdb);color:var(--rd);border-radius:3px;font-size:11.5px;font-family:Consolas,monospace;white-space:pre-wrap;"></div>
    <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">
      <button class="tbtn sec" id="edit-cancel" style="border:1px solid var(--bd);background:var(--bg2);">Cancel</button>
      <button class="tbtn pri" id="edit-save">Save</button>
    </div>
  `;
  $('#edit-cancel').addEventListener('click', () => renderDrawer());
  wireDocumentCompressionControls();
  $('#dr-image-file').addEventListener('change', () =>
    attachImageToDocumentJson({
      textarea: $('#dr-edit-json'),
      fieldInput: $('#dr-image-field'),
      fileInput: $('#dr-image-file'),
      preview: $('#dr-image-preview'),
      imagePayloads: drawerEditImagePayloads,
      error: (message) => {
        const errEl = $('#dr-edit-err');
        errEl.classList.remove('hidden');
        errEl.textContent = message;
      },
    }),
  );
  $('#edit-save').addEventListener('click', async () => {
    if (
      !isCurrentRequestContext(context) ||
      request !== drawerRequest ||
      state.selectedDoc !== d ||
      $('#edit-save').disabled
    )
      return;
    const errEl = $('#dr-edit-err');
    errEl.classList.add('hidden');
    let parsed;
    const validated = validateDocumentInput($('#dr-edit-json').value, {
      existingId: d.id,
      imagePayloads: drawerEditImagePayloads,
    });
    if (!validated.ok) {
      errEl.classList.remove('hidden');
      errEl.textContent = validated.error;
      return;
    }
    parsed = validated.value;
    const compression = readCompressionOverrides($('#dr-body'));
    if (JSON.stringify(parsed) === JSON.stringify(cleanDoc) && !compression) {
      toast('No changes.', 'warn');
      renderDrawer();
      return;
    }
    const save = $('#edit-save');
    save.disabled = true;
    try {
      await api(`/api/documents/${encodeURIComponent(c)}/${encodeURIComponent(String(d.id))}/edit`, {
        method: 'POST',
        body: { document: parsed, compression },
      });
      if (!isCurrentRequestContext(context)) return;
      if (request !== drawerRequest || state.selectedDoc !== d) {
        invalidateStorageCache(c);
        await refreshDocs(c);
        if (isCurrentRequestContext(context) && state.tab === 'data') renderData();
        await refreshDatabaseStatus();
        return;
      }
      toast('Document updated', 'ok');
      invalidateStorageCache(c);
      await refreshDocs(c);
      if (!isCurrentRequestContext(context) || request !== drawerRequest || state.selectedDoc !== d) return;
      invalidateSemanticSearch(c);
      const refreshed = (state.docsByColl[c] || []).find((x) => x.id === d.id);
      if (refreshed) {
        state.selectedDoc = refreshed;
        renderDrawer();
      }
      renderTree();
      if (state.tab === 'data') renderData();
      else if (state.tab === 'search') renderSemanticSearch();
      await refreshDatabaseStatus();
    } catch (e) {
      if (!isCurrentRequestContext(context) || request !== drawerRequest) return;
      errEl.classList.remove('hidden');
      errEl.textContent = 'Save failed: ' + e.message;
    } finally {
      save.disabled = false;
    }
  });
});

$('#dr-del').addEventListener('click', () => {
  const d = state.selectedDoc;
  if (!d) return;
  const c = state.selectedCol;
  const context = captureRequestContext();
  confirmAction(`Delete document “${d.id}”?`, 'This cannot be undone.', async () => {
    if (!isCurrentRequestContext(context)) return;
    try {
      await api(`/api/documents/${encodeURIComponent(c)}/${encodeURIComponent(String(d.id))}`, {
        method: 'DELETE',
      });
      if (!isCurrentRequestContext(context)) return;
      toast('Document deleted', 'ok');
      closeDrawer();
      invalidateStorageCache(c);
      await loadCollections();
      if (!isCurrentRequestContext(context)) return;
      invalidateSemanticSearch(c);
      await refreshDatabaseStatus();
      render();
    } catch (e) {
      if (!isCurrentRequestContext(context)) return;
      toast('Delete failed: ' + e.message, 'err');
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Fields
// ─────────────────────────────────────────────────────────────────
function renderFields() {
  const c = state.selectedCol;
  const context = captureRequestContext();
  const storage = storageCache.get(c);
  const indexed = new Set(storage?.indexedFields || []);
  const docs = state.docsByColl[c] || [];
  if (docs.length === 0) {
    $('#cnt').innerHTML =
      `<div class="flds"><div class="empty-state"><h4>No documents to introspect</h4><p>Insert a document to see what fields exist and their types.</p></div></div>`;
    return;
  }
  const explore = getExplore(c);
  const explored = new Map((explore?.fields || []).map((f) => [f.name, f]));
  const fieldKeys = collectionFields(c);
  const rows = fieldKeys
    .map((k) => {
      const presentCount = docs.reduce((n, d) => n + (d[k] != null ? 1 : 0), 0);
      const sample = docs.find((d) => d[k] != null)?.[k];
      const t = detectType(sample);
      const m = explored.get(k);
      const sampleStr =
        sample == null
          ? '—'
          : typeof sample === 'string'
            ? `"${sample.slice(0, 60)}"`
            : typeof sample === 'object'
              ? JSON.stringify(sample).slice(0, 60)
              : String(sample);
      const covLabel =
        presentCount === docs.length ? `${docs.length} / ${docs.length}` : `${presentCount} / ${docs.length}`;
      const covCls = presentCount === docs.length ? '' : 'partial';
      const hasDesc = !!(m && m.description);
      return `<div class="fr ${hasDesc ? 'has-desc' : ''}">
      <div class="r">
        <div class="nm">${esc(k)}${k === 'id' ? '<span class="pk">PK</span>' : ''}</div>
        <div class="ty">${t} · ${k === 'id' || indexed.has(k) ? 'indexed' : storage ? 'not indexed' : '…'}</div>
        <div class="cov ${covCls}">${covLabel}</div>
        <div class="sm">${esc(sampleStr)}</div>
      </div>
      ${hasDesc ? `<div class="desc">${esc(m.description)}</div>` : ''}
    </div>`;
    })
    .join('');
  $('#cnt').innerHTML = `<div class="flds">
    <h2>Fields<span class="ct">${fieldKeys.length} field${fieldKeys.length === 1 ? '' : 's'} · ${docs.length} document${docs.length === 1 ? '' : 's'}</span></h2>
    <div class="flds-table">
      <div class="h"><div>Name</div><div>Type</div><div>Coverage</div><div>Sample</div></div>
      ${rows}
    </div>
  </div>`;
  if (!storageCache.has(c)) {
    getCollectionStorage(c).then(() => {
      if (isCurrentRequestContext(context) && state.tab === 'fields') renderFields();
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// Compression
// ─────────────────────────────────────────────────────────────────
let compressionDefaultsLoadedFor = null;

async function loadCompressionDefaults(c) {
  const context = captureRequestContext();
  const request = ++compressionDefaultsRequest;
  try {
    const { defaults } = await api(`/api/compression/defaults?collection=${encodeURIComponent(c)}`);
    if (!isCurrentRequestContext(context) || request !== compressionDefaultsRequest) return;
    state.compression.defaults = defaults || {};
    compressionDefaultsError = null;
    compressionDefaultsLoadedFor = c;
  } catch (e) {
    if (!isCurrentRequestContext(context) || request !== compressionDefaultsRequest) return;
    compressionDefaultsError = 'Could not load defaults: ' + e.message;
    compressionDefaultsLoadedFor = c;
  }
}

async function recommendFieldCompression(field) {
  const c = state.selectedCol;
  if (!c || recommendingFields.has(field)) return;
  const context = captureRequestContext();
  const workload = state.compression.workload;
  recommendingFields.add(field);
  if (state.tab === 'compression') renderCompression();
  try {
    const { recommendation } = await api('/api/compression/recommendation', {
      method: 'POST',
      body: {
        collection: c,
        field,
        workload: state.compression.workload,
        sampleSize: 100,
      },
    });
    if (!isCurrentRequestContext(context) || state.compression.workload !== workload) return;
    state.compression.recommendations[field] = recommendation;
    toast(`${field}: recommended ${recommendation.recommended}. The saved default has not been changed.`, 'ok');
    if (state.tab === 'compression') renderCompression();
  } catch (e) {
    if (!isCurrentRequestContext(context)) return;
    toast(`Compression recommendation failed for ${field}: ${e.message}`, 'err');
  } finally {
    if (isCurrentRequestContext(context)) {
      recommendingFields.delete(field);
      if (state.tab === 'compression') renderCompression();
    }
  }
}

async function applyCompressionAdvice() {
  const c = state.selectedCol;
  if (!c || compressionBusy) return;
  const context = captureRequestContext();
  compressionBusy = true;
  if (state.tab === 'compression') renderCompression();
  try {
    const result = await api('/api/compression/lab/apply-advice', {
      method: 'POST',
      body: { collection: c, workload: state.compression.workload, sampleSize: 100 },
    });
    if (!isCurrentRequestContext(context)) return;
    toast(`Applied compression defaults for ${result.fields} fields. Future writes use this policy.`, 'ok');
    await loadCompressionDefaults(c);
    if (isCurrentRequestContext(context) && state.tab === 'compression') renderCompression();
  } catch (e) {
    if (!isCurrentRequestContext(context)) return;
    toast('Apply advice failed: ' + e.message, 'err');
  } finally {
    if (isCurrentRequestContext(context)) {
      compressionBusy = false;
      if (state.tab === 'compression') renderCompression();
    }
  }
}

function renderRecommendationCard(field, recommendation) {
  if (!recommendation) return `<div class="empty" style="padding:10px 0;color:var(--t3);">No recommendation yet.</div>`;
  const top = recommendation.ranking || [];
  return `<div style="margin-top:10px;">
    <p class="control-help">Analysis for <strong>${esc(field)}</strong>. ${recommendation.recommended === 'none' ? 'Keeping this field uncompressed is recommended for this sample and workload; short values often save no storage blocks.' : 'This is advice only. Choose the recommended codec in the saved-default dropdown to use it on future writes.'}</p>
    <div class="prow" style="grid-template-columns:150px 1fr;"><div class="k">Recommended</div><div class="v"><strong style="color:var(--ac)">${esc(recommendation.recommended)}</strong> <span style="font-family:Segoe UI;color:var(--t3);">${esc(recommendation.summary)}</span></div></div>
    <div class="prow" style="grid-template-columns:150px 1fr;"><div class="k">Detected profile</div><div class="v">${esc(recommendation.activeProfile?.displayName || recommendation.detectedProfile?.displayName || '—')}</div></div>
    <table class="dg" style="margin-top:8px;"><thead><tr><th>Algorithm</th><th>Score</th><th>Blocks saved</th><th>Bytes saved</th><th>Write ms</th></tr></thead>
      <tbody>${top
        .slice(0, 6)
        .map(
          (r) =>
            `<tr><td class="ck">${esc(r.algorithm)}</td><td class="cn">${Number(r.score || 0).toFixed(2)}</td><td class="cn">${fmtNum(r.storageEstimate?.blocksSaved ?? r.blocksSaved ?? 0)}</td><td class="cn">${fmtSize((r.storageEstimate?.rawSerializedBytes ?? 0) - (r.storageEstimate?.compressedSerializedBytes ?? 0) || r.bytesSaved || 0)}</td><td class="cn">${Number(r.storageEstimate?.writeCost ?? r.writeCostMs ?? 0).toFixed(1)}</td></tr>`,
        )
        .join('')}</tbody>
    </table>
  </div>`;
}

function renderCompression() {
  const c = state.selectedCol;
  const context = captureRequestContext();
  if (!c) {
    $('#cnt').innerHTML =
      `<div class="ov"><div class="empty-state"><h4>Select a collection</h4><p>Compression recommendations are calculated from collection fields.</p></div></div>`;
    return;
  }
  const docs = state.docsByColl[c] || [];
  const fields = collectionFields(c).filter(
    (field) => field !== 'id' && docs.some((doc) => typeof doc[field] === 'string' && !isImageField(field, doc)),
  );
  const defaults = state.compression.defaults || {};
  const defaultsUnavailable = compressionDefaultsLoadedFor !== c || !!compressionDefaultsError;
  $('#cnt').innerHTML = `<div class="ov">
    <div class="crumb"><a id="cmp-back">All collections</a> ›</div>
    <h1><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h10M4 17h7"/></svg></span><span class="name">${esc(c)} compression</span></h1>
    <p class="ovsub"><span><strong>${fields.length}</strong> text fields in loaded rows</span><span>Analysis samples up to <strong>100</strong> documents</span><span>Defaults affect <strong>future writes</strong></span></p>
    <p class="control-help">Each row is a document field. Changing its saved-default dropdown saves immediately. Analyze field compares codecs using the data and workload; it does not change the saved default. Existing documents keep their current compression.</p>
    <div class="psec">
      <h3>Advisor settings <span class="actions"><button class="tbtn pri" id="cmp-apply-all" ${compressionBusy ? 'disabled' : ''}>${compressionBusy ? 'Saving…' : 'Recommend & save all defaults'}</button></span></h3>
      <div class="pbody">
        <label style="font-size:11px;color:var(--t3);font-weight:700;">Workload hotness: <span id="cmp-workload-label">${Math.round(state.compression.workload * 100)}%</span></label>
        <input id="cmp-workload" type="range" min="0" max="100" value="${Math.round(state.compression.workload * 100)}" style="width:100%;margin:8px 0 4px;">
        <p style="font-size:12px;color:var(--t3);margin:0;">Cold workloads favor smaller files; hot workloads weigh read/write cost more heavily.</p>
      </div>
    </div>
    <div class="psec">
      <h3>Field recommendations <span class="actions"><button class="tbtn" id="cmp-refresh-defaults" ${compressionBusy ? 'disabled' : ''} title="Read the saved codecs from the database; this does not reset or recompress data." style="border:1px solid var(--bd);background:var(--bg2);">Reload saved defaults</button></span></h3>
      ${compressionDefaultsError ? `<div class="err">${esc(compressionDefaultsError)}</div>` : ''}
      <div>${
        fields.length === 0
          ? `<div class="empty-state"><h4>No fields</h4><p>Add documents with non-id fields to get recommendations.</p></div>`
          : fields
              .map(
                (field) => `
        <div style="padding:12px 16px;border-bottom:1px solid var(--bg3);">
          <div style="display:flex;align-items:center;gap:10px;">
            <strong class="mono" style="color:var(--ac);">${esc(field)}</strong>
            <span style="font-size:12px;color:var(--t3);">Saved default</span>
            <select data-cmp-default="${esc(field)}" ${compressionBusy || defaultsUnavailable ? 'disabled' : ''} aria-label="Default compression for ${esc(field)}">${COMPRESSION_OPTIONS.filter(
              (x) => x !== 'inherit' && x !== 'off',
            )
              .map((codec) => `<option ${codec === (defaults[field] || 'none') ? 'selected' : ''}>${codec}</option>`)
              .join('')}</select>
            <button class="tbtn pri" data-cmp-field="${esc(field)}" ${recommendingFields.has(field) ? 'disabled' : ''} style="margin-left:auto;">${recommendingFields.has(field) ? 'Analyzing…' : 'Analyze field'}</button>
          </div>
          ${renderRecommendationCard(field, state.compression.recommendations[field])}
        </div>`,
              )
              .join('')
      }</div>
    </div>
  </div>`;
  $('#cmp-back')?.addEventListener('click', selectRoot);
  $('#cmp-workload')?.addEventListener('input', (e) => {
    state.compression.workload = Number(e.target.value) / 100;
    state.compression.recommendations = {};
    $('#cmp-workload-label').textContent = `${e.target.value}%`;
  });
  $('#cmp-workload')?.addEventListener('change', renderCompression);
  $('#cmp-apply-all')?.addEventListener('click', applyCompressionAdvice);
  $('#cmp-refresh-defaults')?.addEventListener('click', async () => {
    $('#cmp-refresh-defaults').disabled = true;
    $('#cmp-refresh-defaults').textContent = 'Reloading…';
    await loadCompressionDefaults(c);
    if (isCurrentRequestContext(context)) {
      if (!compressionDefaultsError) toast('Saved defaults reloaded from the database.', 'ok');
      if (state.tab === 'compression') renderCompression();
    }
  });
  $$('[data-cmp-default]').forEach((select) =>
    select.addEventListener('change', async () => {
      if (compressionBusy || defaultsUnavailable) return;
      compressionBusy = true;
      compressionDefaultsRequest++;
      $$('[data-cmp-default], #cmp-apply-all').forEach((control) => (control.disabled = true));
      try {
        const { defaults } = await api('/api/compression/defaults', {
          method: 'PUT',
          body: {
            collection: c,
            defaults: { ...state.compression.defaults, [select.dataset.cmpDefault]: select.value },
          },
        });
        if (!isCurrentRequestContext(context)) return;
        state.compression.defaults = defaults;
        toast('Compression default saved', 'ok');
      } catch (e) {
        if (!isCurrentRequestContext(context)) return;
        toast('Save failed: ' + e.message, 'err');
        select.value = state.compression.defaults[select.dataset.cmpDefault] || 'none';
      } finally {
        if (isCurrentRequestContext(context)) {
          compressionBusy = false;
          if (state.tab === 'compression') renderCompression();
        }
      }
    }),
  );
  $$('[data-cmp-field]').forEach((button) =>
    button.addEventListener('click', () => recommendFieldCompression(button.dataset.cmpField)),
  );
  if (compressionDefaultsLoadedFor !== c) {
    loadCompressionDefaults(c).then(() => {
      if (isCurrentRequestContext(context) && state.tab === 'compression') renderCompression();
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// Compression Lab
// ─────────────────────────────────────────────────────────────────
function renderLabPolicyChart(report) {
  if (!report?.policies) return '';
  const policies = Object.entries(report.policies);
  const max = Math.max(...policies.map(([, p]) => p.totalBytes || 0), 1);
  return `<div style="display:grid;gap:8px;">${policies
    .map(([key, policy]) => {
      const pct = Math.max(4, Math.round(((policy.totalBytes || 0) / max) * 100));
      return `<div>
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;"><strong>${esc(key)}</strong><span>${fmtSize(policy.totalBytes)} · ${fmtNum(policy.totalBlocks)} blocks · saved ${fmtNum(policy.blocksSavedVsRaw)}</span></div>
      <div style="height:10px;background:var(--bg3);border-radius:99px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:${key === 'advisor-mix' ? 'var(--gr)' : 'var(--ac)'};"></div></div>
    </div>`;
    })
    .join('')}</div>`;
}

async function runCompressionLabReport() {
  if (state.lab.busy) return;
  const context = captureRequestContext();
  const collection = state.selectedCol;
  if (!collection) {
    state.lab.error = 'Select a collection first.';
    renderLab();
    return;
  }
  state.lab.collection = collection;
  state.lab.busy = true;
  state.lab.error = null;
  const workload = state.lab.workload;
  renderLab();
  try {
    const { report } = await api('/api/compression/lab/recommend-collection', {
      method: 'POST',
      body: { collection, workload: state.lab.workload, sampleSize: 100 },
    });
    if (!isCurrentRequestContext(context)) return;
    if (state.lab.workload === workload) state.lab.report = report;
  } catch (e) {
    if (!isCurrentRequestContext(context)) return;
    state.lab.error = e.message;
  } finally {
    if (isCurrentRequestContext(context)) {
      state.lab.busy = false;
      if (state.tab === 'lab') renderLab();
    }
  }
}

async function applyLabAdvice() {
  if (state.lab.busy || compressionBusy) return;
  const collection = state.selectedCol;
  if (!collection) {
    toast('Select a collection first.', 'warn');
    return;
  }
  const context = captureRequestContext();
  state.lab.busy = true;
  compressionBusy = true;
  renderLab();
  try {
    const result = await api('/api/compression/lab/apply-advice', {
      method: 'POST',
      body: { collection, workload: state.lab.workload, sampleSize: 100 },
    });
    if (!isCurrentRequestContext(context)) return;
    toast(
      `Saved advisor defaults for ${result.fields} fields in ${collection}. Existing documents were not recompressed.`,
      'ok',
    );
    if (collection === state.selectedCol) await loadCompressionDefaults(collection);
  } catch (e) {
    if (!isCurrentRequestContext(context)) return;
    toast('Apply lab advice failed: ' + e.message, 'err');
  } finally {
    if (isCurrentRequestContext(context)) {
      state.lab.busy = false;
      compressionBusy = false;
      if (state.tab === 'lab') renderLab();
    }
  }
}

function renderLab() {
  const report = state.lab.report;
  const collection = state.selectedCol;
  if (!collection) {
    $('#cnt').innerHTML =
      `<div class="ov"><div class="empty-state"><h4>Select a collection</h4><p>The Compression Lab is collection-scoped. Pick a collection in the object explorer, then open the Lab tab.</p></div></div>`;
    return;
  }
  if (state.lab.collection !== collection) {
    state.lab.collection = collection;
    state.lab.report = null;
    state.lab.error = null;
  }
  $('#cnt').innerHTML = `<div class="ov">
    <div class="crumb"><a id="lab-back">All collections</a> › <span>${esc(collection)}</span></div>
    <h1><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 2v6L4 19a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3L14 8V2"/><path d="M8 14h8"/></svg></span><span class="name">${esc(collection)} lab</span></h1>
    <p class="ovsub"><span>Compare field-level compression policies</span><span>Apply defaults for future writes in this collection</span></p>
    <div class="psec">
      <h3>Scenario <span class="actions"><button class="tbtn pri" id="lab-run" ${state.lab.busy ? 'disabled' : ''}>${state.lab.busy ? 'Working…' : 'Analyze collection'}</button><button class="tbtn" id="lab-apply" style="border:1px solid var(--bd);background:var(--bg2);" ${report && !state.lab.busy ? '' : 'disabled'}>Save advised defaults</button></span></h3>
      <p class="control-help">Analyze collection produces a read-only estimate for the selected collection. Save advised defaults affects future writes; it does not recompress existing records. Policy chart sizes are estimates, not measured file sizes.</p>
      <div class="pbody" style="display:grid;gap:10px;">
        <div style="display:grid;grid-template-columns:1fr;gap:10px;">
          <div><label style="font-size:11px;color:var(--t3);font-weight:700;">Workload: <span id="lab-workload-label">${Math.round(state.lab.workload * 100)}%</span></label><input id="lab-workload" type="range" min="0" max="100" value="${Math.round(state.lab.workload * 100)}" style="width:100%;"></div>
        </div>
        ${state.lab.busy ? `<div class="loader">Computing compression report…</div>` : ''}
        ${state.lab.error ? `<div class="err">${esc(state.lab.error)}</div>` : ''}
      </div>
    </div>
    ${
      report
        ? `<div class="kpis">
      <div class="kpi"><div class="l">Baseline</div><div class="v">${fmtSize(report.baseline?.totalBytes)}</div><div class="d">${fmtNum(report.baseline?.totalBlocks || 0)} blocks</div></div>
      <div class="kpi"><div class="l">Advisor</div><div class="v">${fmtSize(report.policies?.['advisor-mix']?.totalBytes)}</div><div class="d">${fmtNum(report.policies?.['advisor-mix']?.blocksSavedVsRaw || 0)} blocks saved</div></div>
      <div class="kpi"><div class="l">Fields</div><div class="v">${report.perField?.length || 0}</div><div class="d">recommended defaults</div></div>
    </div>
    <div class="psec"><h3>Policy comparison</h3><div class="pbody">${renderLabPolicyChart(report)}</div></div>
    <div class="psec"><h3>Per-field advice</h3><div>${(report.perField || [])
      .map(
        (field) => `
      <div class="prow" style="grid-template-columns:170px 110px 1fr;">
        <div class="k mono">${esc(field.field)}</div>
        <div class="v"><strong style="color:var(--ac)">${esc(field.recommended)}</strong></div>
        <div class="v" style="font-family:Segoe UI;color:var(--t2);">${esc(field.rationale || field.summary || '')}</div>
      </div>`,
      )
      .join('')}</div></div>`
        : `<div class="empty-state"><h4>No lab report yet</h4><p>Run a report for <strong>${esc(collection)}</strong>. If every recommendation is <code>none</code>, the sampled fields are probably small scalar values where compression would not save blocks.</p></div>`
    }
  </div>`;
  $('#lab-back')?.addEventListener('click', selectRoot);
  $('#lab-run')?.addEventListener('click', runCompressionLabReport);
  $('#lab-apply')?.addEventListener('click', applyLabAdvice);
  $('#lab-workload')?.addEventListener('input', (e) => {
    state.lab.workload = Number(e.target.value) / 100;
    state.lab.report = null;
    $('#lab-workload-label').textContent = `${e.target.value}%`;
  });
  $('#lab-workload')?.addEventListener('change', renderLab);
}

// ─────────────────────────────────────────────────────────────────
// Schema model (modal opened from AI Chat header)
// ─────────────────────────────────────────────────────────────────
function modelModalJsonForCurrentContext() {
  if (!state.model) return '';
  if (!state.selectedCol) return JSON.stringify(state.model, null, 2);
  const explore = getExplore(state.selectedCol);
  return explore ? JSON.stringify({ explores: [explore] }, null, 2) : '';
}

function modelModalStatusForCurrentContext() {
  if (!state.model) return 'No model loaded';
  if (state.selectedCol && !getExplore(state.selectedCol)) {
    return `No schema model for ${state.selectedCol}. Generate from data to create one.`;
  }
  return `${state.model.explores.length} explore${state.model.explores.length === 1 ? '' : 's'} · ${state.model.explores.reduce((s, e) => s + e.fields.length, 0)} fields total`;
}

function refreshModelModal() {
  $('#mdl-json').value = modelModalJsonForCurrentContext();
  $('#mdl-err').classList.add('hidden');
  $('#mdl-status').textContent = modelModalStatusForCurrentContext();
}

function openModelModal() {
  modelModalRequest++;
  for (const id of ['mdl-save', 'mdl-reload', 'mdl-gen']) $('#' + id).disabled = state.modelGenerating;
  modelModalCollection = state.selectedCol;
  refreshModelModal();
  openModal('modal-model');
}

async function generateModel() {
  if (!state.connected || state.modelGenerating) return;
  const context = captureRequestContext('database');
  const modalRequest = modelModalRequest;
  state.modelGenerating = true;
  $('#mdl-gen').disabled = true;
  $('#mdl-save').disabled = true;
  $('#mdl-reload').disabled = true;
  $('#mdl-json').readOnly = true;
  if (state.tab === 'ai') renderAi();
  if (state.geminiKeySet) {
    toast('Generating schema model… this may take ~20s', '', 'Generating');
  } else {
    toast(
      'No Gemini key — generating a basic introspected model (no descriptions/synonyms). Set a key later to enrich it.',
      'warn',
      'Generating',
    );
  }
  try {
    const { model, enriched } = await api('/api/conversational/model/generate', { method: 'POST' });
    if (!isCurrentRequestContext(context)) return;
    state.model = model;
    if (state.selectedCol) state.modelPromptDismissed[state.selectedCol] = false;
    if (enriched) toast('Schema model generated and enriched.', 'ok');
    else toast('Basic schema model generated. Descriptions/synonyms not added — set a Gemini key to enrich.', 'warn');
  } catch (e) {
    if (!isCurrentRequestContext(context)) return;
    await loadModel();
    toast('Generation failed: ' + e.message, 'err');
  } finally {
    if (isCurrentRequestContext(context)) {
      state.modelGenerating = false;
      $('#mdl-gen').disabled = false;
      $('#mdl-save').disabled = false;
      $('#mdl-reload').disabled = false;
      $('#mdl-json').readOnly = false;
      if (modalRequest === modelModalRequest && !$('#modal-model').classList.contains('hidden')) refreshModelModal();
      render();
    }
  }
}
// Wire the model modal once at startup (the buttons live in a fixed
// modal, not inside the tab content, so they're registered just once).
$('#mdl-gen').addEventListener('click', generateModel);
$('#mdl-save').addEventListener('click', async () => {
  if (!state.connected || $('#mdl-save').disabled) return;
  const context = captureRequestContext();
  const request = modelModalRequest;
  const raw = $('#mdl-json').value;
  let edited;
  try {
    edited = mergeScopedModel(JSON.parse(raw), state.model, modelModalCollection);
  } catch (e) {
    $('#mdl-err').classList.remove('hidden');
    $('#mdl-err').textContent = 'Invalid JSON: ' + e.message;
    return;
  }
  $('#mdl-err').classList.add('hidden');
  $('#mdl-save').disabled = true;
  try {
    const { model } = await api('/api/conversational/model', {
      method: 'PUT',
      body: { model: JSON.stringify(edited) },
    });
    if (!isCurrentRequestContext(context)) return;
    state.model = model;
    toast('Model saved', 'ok');
    if (request === modelModalRequest) closeModal('modal-model');
    render();
  } catch (e) {
    if (!isCurrentRequestContext(context) || request !== modelModalRequest) return;
    $('#mdl-err').classList.remove('hidden');
    $('#mdl-err').textContent = e.message;
  } finally {
    if (isCurrentRequestContext(context) && request === modelModalRequest) $('#mdl-save').disabled = false;
  }
});
$('#mdl-reload').addEventListener('click', async () => {
  if (!state.connected || $('#mdl-reload').disabled) return;
  const context = captureRequestContext();
  const request = modelModalRequest;
  $('#mdl-reload').disabled = true;
  try {
    const { model } = await api('/api/conversational/model');
    if (!isCurrentRequestContext(context) || request !== modelModalRequest) return;
    state.model = model;
    refreshModelModal();
    toast('Model reloaded', 'ok');
  } catch (e) {
    if (!isCurrentRequestContext(context) || request !== modelModalRequest) return;
    $('#mdl-err').textContent = 'Reload failed: ' + e.message;
    $('#mdl-err').classList.remove('hidden');
  } finally {
    if (isCurrentRequestContext(context) && request === modelModalRequest) $('#mdl-reload').disabled = false;
  }
});

// ─────────────────────────────────────────────────────────────────
// SQL
// ─────────────────────────────────────────────────────────────────
let pendingSql = '';

function renderSql() {
  const last = state.sqlHistory[0];
  $('#cnt').innerHTML = `<div class="sql-pane">
    <div class="sql-tools">
      <button class="tbtn pri" id="sql-run" ${sqlBusy ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>${sqlBusy ? 'Running…' : 'Run (Ctrl+Enter)'}</button>
      <button class="tbtn" id="sql-clear"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>Clear</button>
      <button class="tbtn" id="sql-example">Example: SELECT</button>
      ${state.selectedCol ? `<button class="tbtn" id="sql-prefill">SELECT * FROM ${esc(state.selectedCol)}</button>` : ''}
      <div class="meta">
        ${
          last
            ? last.ok
              ? `<span><strong>${last.rowCount}</strong> row${last.rowCount === 1 ? '' : 's'}</span><span class="ok-pill">${esc(last.kind)} · ${last.elapsedMs} ms</span>`
              : `<span class="err-pill">error</span>`
            : `<span style="color:var(--t4);font-style:italic;">no query run yet</span>`
        }
      </div>
    </div>
    <div class="sql-editor" id="sql-edit" contenteditable="true" spellcheck="false">${pendingSql ? esc(pendingSql) : ''}</div>
    <div class="sql-results" id="sql-out">${renderSqlOut(last)}${renderSqlHistory()}</div>
  </div>`;
  const editor = $('#sql-edit');
  editor.addEventListener('input', () => {
    pendingSql = editor.innerText;
  });
  editor.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      runSql();
    }
  });
  $('#sql-run').addEventListener('click', runSql);
  $('#sql-clear').addEventListener('click', () => {
    pendingSql = '';
    editor.innerText = '';
  });
  $('#sql-example').addEventListener('click', () => {
    const ex = state.selectedCol
      ? `SELECT *\n  FROM ${state.selectedCol}\n LIMIT 25;`
      : 'SELECT *\n  FROM <collection>\n LIMIT 25;';
    pendingSql = ex;
    editor.innerText = pendingSql;
  });
  if (state.selectedCol) {
    $('#sql-prefill').addEventListener('click', () => {
      pendingSql = `SELECT * FROM ${state.selectedCol} LIMIT 100;`;
      editor.innerText = pendingSql;
    });
  }
  if (pendingSql) editor.innerText = pendingSql;
  $$('#sql-out .item').forEach((el) =>
    el.addEventListener('click', () => {
      pendingSql = el.dataset.sql;
      editor.innerText = pendingSql;
    }),
  );
}

async function runSql() {
  if (!state.connected || sqlBusy) return;
  const sql = pendingSql.trim();
  if (!sql) {
    toast('Type a query first.', 'warn');
    return;
  }
  const kind = getSqlMutationKind(sql);
  if (kind) {
    confirmAction(`Run a ${kind} statement?`, `${kind} statements modify the database. Continue?`, () =>
      runSqlNow(sql),
    );
    return;
  }
  await runSqlNow(sql);
}
async function runSqlNow(sql) {
  if (!state.connected || sqlBusy) return;
  const context = captureRequestContext('database');
  const request = ++sqlRequest;
  sqlBusy = true;
  if (state.tab === 'sql') renderSql();
  try {
    const result = await api('/api/query', { method: 'POST', body: { sql } });
    if (!isCurrentRequestContext(context) || request !== sqlRequest) return;
    state.sqlHistory.unshift({
      sql,
      ok: true,
      ts: Date.now(),
      rowCount: result.rowCount,
      elapsedMs: result.elapsedMs,
      kind: result.kind,
      rows: result.rows,
    });
    state.sqlHistory = state.sqlHistory.slice(0, 10);
    if (['insert', 'update', 'delete'].includes(result.kind)) {
      toast(`${result.kind.toUpperCase()} ok`, 'ok');
      invalidateStorageCache();
      closeDrawer();
      invalidateSemanticSearch(state.selectedCol);
      await loadCollections();
      await refreshDatabaseStatus();
      if (!isCurrentRequestContext(context)) return;
      renderTree();
      renderTabs();
    }
  } catch (e) {
    if (!isCurrentRequestContext(context) || request !== sqlRequest) return;
    state.sqlHistory.unshift({ sql, ok: false, ts: Date.now(), error: e.message });
    state.sqlHistory = state.sqlHistory.slice(0, 10);
  } finally {
    if (isCurrentRequestContext(context) && request === sqlRequest) {
      sqlBusy = false;
      if (state.tab === 'sql') renderSql();
    }
  }
}

function renderSqlOut(last) {
  if (!last) return '';
  if (!last.ok) return `<div class="err">${esc(last.error)}</div>`;
  if (last.kind !== 'select' && last.kind !== 'explain')
    return `<div class="rhead"><span class="ok-pill">${esc(last.kind)}</span><strong>${last.rowCount}</strong> row${last.rowCount === 1 ? '' : 's'} affected · ${last.elapsedMs} ms</div>`;
  const rows = last.rows || [];
  if (rows.length === 0)
    return `<div class="rhead"><strong>0</strong> rows · ${last.elapsedMs} ms</div><div style="padding:20px;text-align:center;color:var(--t3);font-size:12px;">No rows returned.</div>`;
  const cols = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  return `<div class="rhead"><strong>${last.rowCount}</strong> row${last.rowCount === 1 ? '' : 's'} · <span class="pill">${esc(last.kind)}</span> · <span class="pill">${last.elapsedMs} ms</span></div>
  <table class="dg"><thead><tr><th class="rn">#</th>${cols
    .map((c) => {
      const v = rows[0][c];
      const tb =
        c === 'id'
          ? 'pk'
          : typeof v === 'number'
            ? 'n'
            : typeof v === 'boolean'
              ? 'b'
              : typeof v === 'string'
                ? 's'
                : '';
      return `<th><div class="ti">${esc(c)}${tb ? `<span class="tb ${tb === 'pk' ? 'pk' : ''}">${tb}</span>` : ''}</div></th>`;
    })
    .join('')}</tr></thead>
  <tbody>${rows
    .map(
      (r, i) =>
        `<tr><td class="rn">${i + 1}</td>${cols
          .map((c) => {
            const v = r[c];
            if (v == null) return '<td class="cnu">[NULL]</td>';
            if (typeof v === 'number') return `<td class="cn">${fmtNum(v)}</td>`;
            return `<td class="cs">${esc(String(v))}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('')}</tbody></table>`;
}
function renderSqlHistory() {
  if (state.sqlHistory.length <= 1) return '';
  return `<div class="sql-history"><h4>History</h4>${state.sqlHistory
    .slice(1)
    .map(
      (h) =>
        `<div class="item" data-sql="${esc(h.sql)}"><span class="${h.ok ? 'ok' : 'ko'}">${h.ok ? 'OK' : 'ERR'}</span><span class="qq">${esc(h.sql.replace(/\s+/g, ' '))}</span><span class="when">${h.ok ? `${h.rowCount} rows · ${h.elapsedMs}ms` : 'error'}</span></div>`,
    )
    .join('')}</div>`;
}

// ─────────────────────────────────────────────────────────────────
// Semantic Search
// ─────────────────────────────────────────────────────────────────
let embeddingStatusRequest = 0;
let searchController = null;
let chatController = null;

async function pollEmbedStatus() {
  const context = captureRequestContext('database');
  const request = ++embeddingStatusRequest;
  try {
    const s = await api('/api/embeddings/status');
    if (!isCurrentRequestContext(context) || request !== embeddingStatusRequest) return;
    state.search.embedStatus = s;
  } catch {
    /* leave previous status */
  }
}

function cancelSemanticSearch() {
  searchRequest++;
  searchController?.abort();
  searchController = null;
  state.search.busy = false;
  state.search.results = null;
  state.search.error = null;
  state.search.elapsedMs = null;
}

function embedStatusPill(mode = state.search.mode || 'text', hasImageUpload = !!state.search.image) {
  const indexStatus =
    hasImageUpload || mode === 'image'
      ? state.search.embedStatus.indexes?.image
      : state.search.embedStatus.indexes?.text;
  const s = indexStatus?.state || state.search.embedStatus.state;
  const label = hasImageUpload || mode === 'image' ? 'CLIP image index' : 'MiniLM text index';
  if (s === 'ready') return { cls: 'ok', label: `${label} · ready` };
  if (s === 'loading') return { cls: 'warn', label: `${label} · loading…` };
  if (s === 'error') return { cls: 'bad', label: `${label} · error` };
  return { cls: '', label: `${label} · loads on first search` };
}

function renderSemanticSearch() {
  if (!state.connected || state.tab !== 'search') return;
  const c = state.selectedCol;
  const s = state.search;
  const mode = s.mode || 'text';
  const pill = embedStatusPill(mode, !!s.image);
  const imageDocCount = c ? (state.docsByColl[c] || []).filter(hasImageField).length : 0;
  const placeholders = {
    text: 'Zoek op betekenis...',
    image: 'Zoek foto op beschrijving...',
  };
  const modeHelp = {
    text: 'Semantic text search uses MiniLM over text fields.',
    image: s.image
      ? 'Image-to-image search uses CLIP over image fields.'
      : 'Photo search uses CLIP over image fields only.',
  };

  // The embedding model loads lazily on first query; we don't preload on
  // tab open because the user might just be browsing. We refresh
  // status when they actually run a query.
  $('#cnt').innerHTML = `<div class="ss">
    <div class="ss-head">
      <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4-4"/></svg></div>
      <div class="ttl"><strong>Semantic search</strong><span class="sub">${esc(modeHelp[mode])}</span></div>
      <div class="meta"><span class="dot ${pill.cls}" title="Selected model state. Loads on the first query and stays warm afterwards."><strong>${esc(pill.label.split(' · ')[0])}</strong>${esc(pill.label.split(' · ')[1] || '')}</span></div>
    </div>
    <div class="ss-bar">
      <div class="modes ss-modes">
        ${['text', 'image'].map((m) => `<button class="${mode === m ? 'on' : ''}" data-ss-mode="${m}">${m === 'text' ? 'Tekst' : 'Foto'}</button>`).join('')}
      </div>
      <input type="text" id="ss-q" placeholder="${c ? esc(placeholders[mode]) : 'Select a collection in the sidebar first…'}" value="${esc(s.query)}" ${c && !s.busy ? '' : 'disabled'}/>
      ${
        mode === 'image'
          ? `<label class="attach ${s.image ? 'has-image' : ''}" title="Attach an image for image-to-image search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>
        ${s.image ? esc(s.image.name) : 'Attach image'}
        <input type="file" id="ss-img" accept="image/*" style="display:none;" ${c ? '' : 'disabled'}/>
      </label>
      ${s.image ? `<button type="button" class="clear-img" id="ss-img-clear" title="Remove attached image" aria-label="Remove attached image">✕</button>` : ''}`
          : ''
      }
      <button class="go" id="ss-go" ${c && !s.busy ? '' : 'disabled'}>Search</button>
    </div>
    <div class="ss-status">
      ${s.image ? `<span class="preview"><img src="${esc(s.image.dataUrl)}" alt=""/> using image embedding</span>` : ''}
      ${!s.image && s.query ? `<span>${mode === 'image' ? 'searching the CLIP image index by description' : 'using MiniLM text embedding'}</span>` : ''}
      ${!s.image && !s.query && mode === 'image' ? `<span>Foto mode searches the CLIP image index; ${imageDocCount} image document${imageDocCount === 1 ? '' : 's'} in the loaded page.</span>` : ''}
      ${s.elapsedMs != null ? `<span>· ${s.elapsedMs} ms</span>` : ''}
      ${s.results ? `<span>· ${s.results.length} result${s.results.length === 1 ? '' : 's'}</span>` : ''}
    </div>
    <div class="ss-body" id="ss-body">${renderSemanticSearchBody(c, s)}</div>
  </div>`;

  $('#ss-q')?.addEventListener('input', (e) => {
    if (state.search.busy) cancelSemanticSearch();
    state.search.query = e.target.value;
  });
  $('#ss-q')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !state.search.busy) runSemanticSearch();
  });
  $('#ss-go')?.addEventListener('click', () => {
    if (!state.search.busy) runSemanticSearch();
  });
  $('#ss-img')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    cancelSemanticSearch();
    const context = captureRequestContext();
    const request = searchRequest;
    const search = state.search;
    search.image = null;
    if (!f.type.startsWith('image/')) {
      search.error = 'Choose an image file.';
      renderSemanticSearch();
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      search.error = 'Choose an image smaller than 10 MB.';
      renderSemanticSearch();
      return;
    }
    try {
      const dataUrl = await readFileDataUrl(f);
      if (!isCurrentRequestContext(context) || request !== searchRequest || state.search !== search) return;
      const b64 = dataUrl.split(',', 2)[1] || '';
      search.image = { name: f.name, dataUrl, buffer: b64 };
    } catch (err) {
      if (!isCurrentRequestContext(context) || request !== searchRequest || state.search !== search) return;
      search.error = err.message || 'The image could not be read.';
    }
    renderSemanticSearch();
  });
  $('#ss-img-clear')?.addEventListener('click', () => {
    cancelSemanticSearch();
    state.search.image = null;
    renderSemanticSearch();
  });
  $$('[data-ss-mode]').forEach((button) =>
    button.addEventListener('click', () => {
      if (state.search.mode === button.dataset.ssMode) return;
      cancelSemanticSearch();
      state.search.mode = button.dataset.ssMode;
      state.search.results = null;
      state.search.error = null;
      state.search.elapsedMs = null;
      if (state.search.mode === 'text') state.search.image = null;
      renderSemanticSearch();
    }),
  );
  $$('#ss-body [data-idx]').forEach((el) =>
    el.addEventListener('click', () => {
      const i = parseInt(el.dataset.idx, 10);
      const doc = s.results && s.results[i];
      if (!doc) return;
      try {
        openDrawer(JSON.parse(doc), i);
      } catch {
        /* invalid json */
      }
    }),
  );
  $('#ss-rebuild-indexes')?.addEventListener('click', () => {
    confirmAction(
      'Rebuild semantic indexes?',
      'This runs manual compaction. It rewrites the database and rebuilds records, B+ trees, and semantic indexes using the current dual-index layout.',
      runManualCompaction,
    );
  });
}

function renderSemanticSearchBody(c, s) {
  if (!c) {
    return `<div class="ss-empty"><h4>Pick a collection to search</h4><p>Semantic search ranks documents in the selected collection by similarity to your query. Text search loads MiniLM; photo and image search load CLIP. The first use may need a model download.</p></div>`;
  }
  if (s.error) {
    return `<div class="ss-empty"><h4>Search failed</h4><p style="color:var(--rd)">${esc(s.error)}</p></div>`;
  }
  if (s.busy) {
    const kind = s.image || s.mode === 'image' ? 'image' : 'text';
    const indexStatus = s.embedStatus.indexes?.[kind];
    const loading = (indexStatus?.state || s.embedStatus.state) === 'loading';
    const label = kind === 'image' ? 'CLIP image model' : 'MiniLM text model';
    return `<div class="ss-loading"><span class="spin"></span>${loading ? `Loading ${label}…` : 'Searching…'}</div>`;
  }
  const missingIndex = semanticMissingIndex(c, s.mode || 'text', !!s.image);
  if (missingIndex && !s.results) {
    return `<div class="ss-empty"><h4>${esc(missingIndex.title)}</h4><p>${missingIndex.body}</p><button class="tbtn pri" id="ss-rebuild-indexes" style="margin-top:12px;">Rebuild semantic indexes</button></div>`;
  }
  if (!s.results) {
    return `<div class="ss-empty"><h4>Ready when you are</h4><p>Type a query and press Search. Tekst uses the MiniLM text index; Foto uses the CLIP image index.</p></div>`;
  }
  if (s.results.length === 0) {
    if ((s.mode || 'text') === 'image') {
      const imageDocCount = (state.docsByColl[c] || []).filter(hasImageField).length;
      if (imageDocCount === 0) {
        return `<div class="ss-empty"><h4>No photo matches</h4><p>No matches were returned from the CLIP image index. The loaded page has no detected image fields. Add image documents or rebuild an existing image index.</p></div>`;
      }
      return `<div class="ss-empty"><h4>No photo matches</h4><p>No matches were returned from the CLIP image index. Try a different description or image, or rebuild the semantic indexes for existing data.</p></div>`;
    }
    return `<div class="ss-empty"><h4>No results</h4><p>The collection doesn't have any documents that semantically match. Try broader keywords or a different image.</p></div>`;
  }
  const rows = s.results.map(parseSemanticResult);
  const cols = semanticResultColumns(rows, s.mode || 'text');
  if (cols.length === 0) cols.push('result');
  return `<div class="sql-results ss-table">
    <div class="rhead"><strong>${s.results.length}</strong> result${s.results.length === 1 ? '' : 's'} · <span class="pill">semantic</span></div>
    <table class="dg"><thead><tr><th class="rn">#</th>${cols
      .map((c) => {
        const sample = rows.find((r) => r[c] != null)?.[c];
        const type = c === 'id' ? 'pk' : semanticTypeBadge(sample);
        return `<th><div class="ti">${esc(c)}${type ? `<span class="tb ${type === 'pk' ? 'pk' : ''}">${type}</span>` : ''}</div></th>`;
      })
      .join('')}</tr></thead>
    <tbody>${rows.map((r, i) => `<tr data-idx="${i}" title="Open document"><td class="rn">${i + 1}</td>${cols.map((c) => renderSemanticCell(c, r[c], r)).join('')}</tr>`).join('')}</tbody></table>
  </div>`;
}

function semanticMissingIndex(collection, mode, hasImageUpload) {
  const indexes = state.databaseStatus?.semanticIndexes;
  if (!Array.isArray(indexes)) return null;
  const needed = hasImageUpload || mode === 'image' ? `${collection}::image` : `${collection}::text`;
  if (indexes.includes(needed)) return null;
  const legacy = indexes.includes(collection);
  const kind = needed.endsWith('::image') ? 'CLIP image' : 'MiniLM text';
  return {
    title: `${kind} index missing`,
    body: legacy
      ? `This database still has the old legacy semantic index for <code>${esc(collection)}</code>, but the new search uses <code>${esc(needed)}</code>. Run a manual compact/rebuild to recreate semantic indexes with the new layout.`
      : `No <code>${esc(needed)}</code> index exists yet. Insert or replace matching documents, or run a manual compact/rebuild to recreate semantic indexes for existing data.`,
  };
}

function parseSemanticResult(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return { result: parsed };
  } catch {
    return { result: raw };
  }
}

function semanticResultColumns(rows, mode = 'text') {
  const seen = new Set();
  const cols = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key.startsWith('_') || seen.has(key)) continue;
      seen.add(key);
      cols.push(key);
    }
  }
  return cols.sort((a, b) => {
    if (a === 'id') return -1;
    if (b === 'id') return 1;
    if (mode === 'image') {
      const ai = rows.some((row) => isImageField(a, row));
      const bi = rows.some((row) => isImageField(b, row));
      if (ai && !bi) return -1;
      if (!ai && bi) return 1;
    }
    return 0;
  });
}

function semanticTypeBadge(value) {
  const t = detectType(value);
  if (t === 'number') return 'n';
  if (t === 'boolean') return 'b';
  if (t === 'string') return 's';
  return '';
}

function renderSemanticCell(key, value, row = null) {
  if (value == null) return '<td class="cnu">[NULL]</td>';
  if (typeof value === 'number') return `<td class="cn">${fmtNum(value)}</td>`;
  if (typeof value === 'boolean') return `<td class="cb">${value ? 'true' : 'false'}</td>`;
  if (typeof value === 'object') return `<td class="ck">${esc(JSON.stringify(value))}</td>`;
  const imageUrl = imageDataUrlFromValue(key, value, row);
  if (imageUrl) return `<td class="ci"><img src="${esc(imageUrl)}" alt=""></td>`;
  return `<td class="cs">${esc(String(value))}</td>`;
}

function hasImageField(doc) {
  return !!doc && typeof doc === 'object' && Object.keys(doc).some((key) => isImageField(key, doc));
}

function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error || new Error('The file could not be read.'));
    r.onabort = () => reject(new Error('The file read was cancelled.'));
    r.onload = () => resolve(r.result);
    r.readAsDataURL(file);
  });
}

async function runSemanticSearch() {
  const c = state.selectedCol;
  const s = state.search;
  if (!state.connected || state.tab !== 'search' || !c || s.busy) return;
  if (!s.query.trim() && !s.image) {
    s.error = 'Type a query or attach an image first.';
    renderSemanticSearch();
    return;
  }
  s.busy = true;
  s.error = null;
  s.results = null;
  s.elapsedMs = null;
  const context = captureRequestContext();
  const request = ++searchRequest;
  const controller = new AbortController();
  searchController?.abort();
  searchController = controller;
  const isCurrent = () => isCurrentRequestContext(context) && request === searchRequest && state.search === s;
  const mode = s.mode || 'text';
  const image = s.image;
  const query = s.query.trim();
  if (mode === 'text' || mode === 'image' || s.image) {
    const kind = s.image || mode === 'image' ? 'image' : 'text';
    // Kick off only the model needed by this search mode.
    void api('/api/embeddings/preload', { method: 'POST', body: { kind } }).catch(() => undefined);
  }
  renderSemanticSearch();
  // Poll status while busy so the pill animates from "loading" to "ready".
  const statusTimer = setInterval(async () => {
    if (!isCurrent()) {
      clearInterval(statusTimer);
      return;
    }
    await pollEmbedStatus();
    if (isCurrent()) renderSemanticSearch();
  }, 1500);
  const t0 = performance.now();
  try {
    let resp;
    if (image) {
      resp = await api(`/api/documents/${encodeURIComponent(c)}/search/image?limit=20`, {
        method: 'POST',
        body: { image: image.buffer },
        signal: controller.signal,
      });
    } else if (mode === 'image') {
      const q = encodeURIComponent(query);
      resp = await api(`/api/documents/${encodeURIComponent(c)}/search/photos?q=${q}&limit=10`, {
        signal: controller.signal,
      });
    } else {
      const q = encodeURIComponent(query);
      resp = await api(`/api/documents/${encodeURIComponent(c)}/search?q=${q}&limit=20`, {
        signal: controller.signal,
      });
    }
    if (!isCurrent()) return;
    const docs = Array.isArray(resp.documents) ? resp.documents : [];
    s.results = docs;
    s.elapsedMs = Math.round(performance.now() - t0);
  } catch (err) {
    if (!isCurrent()) return;
    s.error = err.message || String(err);
  } finally {
    clearInterval(statusTimer);
    if (isCurrent()) {
      searchController = null;
      s.busy = false;
      renderSemanticSearch();
      await Promise.all([pollEmbedStatus(), refreshDatabaseStatus()]);
      if (isCurrent()) renderSemanticSearch();
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// AI Chat
// ─────────────────────────────────────────────────────────────────
let aiBusy = false;

function renderAi() {
  if (!state.connected || state.tab !== 'ai') return;
  destroyAiCharts();
  const c = state.selectedCol;
  const exploreForCol = c ? getExplore(c) : null;
  // The collection needs a schema-model entry to chat. If the user
  // hasn't already dismissed the prompt, we show a Y/N card. If they
  // dismissed it, the chat stays disabled until they generate one.
  const needsModelForCol = !!c && !exploreForCol && !state.modelGenerating;
  const promptForCol = needsModelForCol && !state.modelPromptDismissed[c];

  const schemaReady = !!state.model && !!exploreForCol && !state.modelGenerating;
  const canChat = state.geminiKeySet && schemaReady && !aiBusy;
  const empty = state.chatHistory.length === 0;

  $('#cnt').innerHTML = `<div class="ai-pane">
    <div class="ai-head">
      <div class="ic">AI</div>
      <div class="ttl"><strong>Conversational analytics</strong><div class="sub">Context: <strong style="color:var(--ac)">${esc(c || '—')}</strong></div></div>
      <div class="meta">
        <span class="dot ${state.geminiKeySet ? 'ok' : 'bad'}" title="${state.geminiKeySet ? 'A Gemini API key is configured. Validity is verified on first chat.' : 'No Gemini API key configured.'}"><strong>LLM</strong>${state.geminiKeySet ? 'key set' : 'no key'}</span>
        <span class="dot ${exploreForCol ? 'ok' : 'warn'}" title="${exploreForCol ? 'Schema model loaded for this collection.' : 'No schema model defined for this collection yet.'}"><strong>Schema</strong>${exploreForCol ? 'ready' : c ? 'missing' : '—'}</span>
        <button class="tbtn" id="ai-model" title="View or edit the schema model JSON" style="padding:4px 10px;font-size:11px;border:1px solid var(--bd);background:var(--bg2);" ${aiBusy || state.modelGenerating ? 'disabled' : ''}>Edit schema model</button>
        <button class="tbtn" id="ai-clear" style="padding:4px 10px;font-size:11px;">Clear chat</button>
      </div>
    </div>
    <div class="ai-body" id="ai-body">${
      state.modelGenerating
        ? renderModelGeneratingCard(c)
        : promptForCol
          ? renderModelPromptCard(c)
          : empty
            ? renderAiEmpty(c, exploreForCol)
            : state.chatHistory.map((m, i) => renderAiMessage(m, i)).join('')
    }</div>
    <div class="ai-input">
      <input id="ai-q" placeholder="${
        schemaReady && !state.geminiKeySet
          ? 'Schema ready — configure Gemini API key to chat…'
          : !state.geminiKeySet
            ? 'Configure Gemini API key first…'
            : !c
              ? 'Select a collection in the sidebar…'
              : !exploreForCol
                ? 'Generate a schema model for this collection first…'
                : state.modelGenerating
                  ? 'Generating schema model…'
                  : 'Ask about your data…'
      }" ${canChat ? '' : 'disabled'}/>
      <button id="ai-send" ${canChat ? '' : 'disabled'}>Send</button>
    </div>
  </div>`;
  $('#ai-clear').addEventListener('click', () => {
    chatRequest++;
    chatController?.abort();
    chatController = null;
    aiBusy = false;
    state.chatHistory = [];
    renderAi();
  });
  $('#ai-model').addEventListener('click', openModelModal);
  $('#ai-empty-settings')?.addEventListener('click', () => openModal('modal-settings'));
  $('#ai-q')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !aiBusy) sendChat();
  });
  $('#ai-send')?.addEventListener('click', () => {
    if (!aiBusy) sendChat();
  });
  $$('#ai-body .example').forEach((b) =>
    b.addEventListener('click', () => {
      if (!canChat) return;
      $('#ai-q').value = b.dataset.q;
      sendChat();
    }),
  );
  $$('#ai-body .chip').forEach((b) =>
    b.addEventListener('click', () => {
      if (!canChat) return;
      $('#ai-q').value = b.dataset.q;
      sendChat();
    }),
  );
  $$('#ai-body .didyou li').forEach((li) =>
    li.addEventListener('click', () => {
      if (!canChat) return;
      $('#ai-q').value = li.textContent;
      sendChat();
    }),
  );
  $$('#ai-body .open-sql').forEach((b) =>
    b.addEventListener('click', () => {
      pendingSql = b.dataset.sql;
      state.tab = 'sql';
      renderTabs();
      renderTab();
    }),
  );
  $$('#ai-body .qch canvas').forEach((cv) => {
    try {
      const spec = JSON.parse(cv.dataset.chart);
      drawChart(cv, spec.chart, spec.data);
    } catch {
      cv.replaceWith(document.createTextNode('Chart unavailable. The result data is shown above.'));
    }
  });
  // Wiring for the per-collection model-generation prompt card.
  $('#ai-model-yes')?.addEventListener('click', generateModel);
  $('#ai-model-no')?.addEventListener('click', () => {
    if (c) state.modelPromptDismissed[c] = true;
    renderAi();
  });
  $('#ai-model-settings')?.addEventListener('click', () => openModal('modal-settings'));

  const body = $('#ai-body');
  body.scrollTop = body.scrollHeight;
}

function renderModelGeneratingCard(c) {
  if (state.geminiKeySet) {
    return `<div class="ai-empty"><h4>Generating schema model</h4><p>Inspecting <strong>${esc(state.filepath || '—')}</strong> and enriching with Gemini. This usually takes around 20 seconds. The chat input will unlock automatically when it's done.</p></div>`;
  }
  return `<div class="ai-empty"><h4>Generating basic schema model</h4><p>Introspecting <strong>${esc(state.filepath || '—')}</strong> directly from the data. No Gemini key set, so descriptions and synonyms will be skipped — you can set a key later and regenerate.</p></div>`;
}

function renderModelPromptCard(c) {
  // The schema model is never generated automatically — neither on
  // connect, nor on first AI-chat open. The user has to opt in. This
  // card is what they see when no model exists yet for the selected
  // collection.
  const keyHint = state.geminiKeySet
    ? `<p style="font-size:11.5px;color:var(--t3);margin-top:6px;">Generation runs against <strong>${esc(state.filepath || 'the connected database')}</strong>, samples a few documents per collection, then asks Gemini to add field descriptions and synonyms.</p>`
    : `<p style="font-size:11.5px;color:var(--t3);margin-top:6px;">No Gemini key set. You can still generate a basic model from the data alone (field names, types, sample values). For descriptions and chat, set the key from the connection pill in the top-right.</p>`;
  return `<div class="ai-empty">
    <h4>No schema model for <span class="mono" style="color:var(--ac)">${esc(c)}</span> yet</h4>
    <p>The schema model is a small JSON file that lists every field, its type, and (optionally) what it means. The AI chat needs it to answer questions; it is also used in the Fields tab. <strong>It is never generated automatically — you decide when.</strong></p>
    ${keyHint}
    <div style="display:flex;gap:8px;justify-content:center;margin-top:8px;">
      <button class="tbtn pri" id="ai-model-yes">${state.geminiKeySet ? 'Generate now' : 'Generate basic model'}</button>
      ${!state.geminiKeySet ? `<button class="tbtn" id="ai-model-settings" style="border:1px solid var(--bd);background:var(--bg2);">Set Gemini key first</button>` : ''}
      <button class="tbtn" id="ai-model-no" style="border:1px solid var(--bd);background:var(--bg2);">Not now</button>
    </div>
  </div>`;
}

function renderAiEmpty(c, exploreForCol) {
  if (!c) {
    return `<div class="ai-empty"><h4>Pick a collection</h4><p>Select a collection in the sidebar to chat about its data.</p></div>`;
  }
  if (!exploreForCol) {
    return `<div class="ai-empty"><h4>Chat is paused</h4><p>This collection doesn't have a schema model yet. <button class="tbtn" id="ai-model-yes" style="border:1px solid var(--bd);background:var(--bg2);padding:4px 10px;">Generate one now</button> to enable chat.</p></div>`;
  }
  if (!state.geminiKeySet) {
    return `<div class="ai-empty"><h4>Configure Gemini to chat</h4><p>The schema model is ready. Add a Gemini API key to ask questions about this collection.</p><button class="tbtn pri" id="ai-empty-settings">Configure Gemini key</button></div>`;
  }
  const examples = [
    `How many records are in ${c}?`,
    'What are the distinct categories and their counts?',
    'Show me the top 5 by some metric',
    'Compare the largest groups in this collection',
  ];
  return `<div class="ai-empty"><h4>Ask a question about your data</h4><p>Type a question in plain English. The AI will translate it to the query language, run it, and explain the result with a chart and follow-up suggestions.</p><div class="examples">${examples.map((q) => `<button class="example" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`;
}

function renderAiMessage(m, i) {
  if (m.role === 'user') {
    return `<div class="msg u"><div class="who">You</div><div class="bub">${esc(m.text)}</div></div>`;
  }
  if (m.thinking)
    return `<div class="msg a"><div class="who">AI</div><div class="bub thinking"><span class="spin"></span><span class="lbl">${esc(m.text)}</span></div></div>`;
  if (m.error) return `<div class="msg a"><div class="who">AI</div><div class="bub err">${esc(m.error)}</div></div>`;
  const r = m.response || {};
  let h = '';
  if (r.query) {
    h += `<div class="q"><div class="qhead">Generated Query<span class="open-sql" data-sql="${esc(r.query)}">Open in Query Language editor →</span></div><div class="qcode">${esc(r.query)}</div></div>`;
  }
  if (r.interpretation) h += `<div class="in">${esc(r.interpretation)}</div>`;
  if (r.data && r.data.length > 0) {
    const cols = Object.keys(r.data[0]).filter((key) => !key.startsWith('_'));
    h += `<table class="qt"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${r.data
      .slice(0, 30)
      .map((row) => `<tr>${cols.map((c) => renderAiResultCell(c, row[c], row)).join('')}</tr>`)
      .join(
        '',
      )}${r.data.length > 30 ? `<tr><td colspan="${cols.length}" style="text-align:center;color:var(--t3);">+ ${r.data.length - 30} more rows</td></tr>` : ''}</tbody></table>`;
  }
  if (r.chart && r.chart.type && r.chart.type !== 'none' && r.data && r.data.length > 0) {
    const id = `chart-${i}-${Date.now()}`;
    h += `<div class="qch"><canvas id="${id}" data-chart='${esc(JSON.stringify({ chart: r.chart, data: r.data }))}'></canvas></div>`;
  }
  if (r.summary) h += `<div class="sum">${esc(r.summary)}</div>`;
  if (r.anomaly) h += `<div class="anom">${esc(r.anomaly)}</div>`;
  if (r.didYouMean && r.didYouMean.length > 0)
    h += `<div class="didyou"><strong>Did you mean…</strong><ul>${r.didYouMean.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>`;
  if (r.suggestions && r.suggestions.length > 0) {
    h += `<div class="chips">${r.suggestions.map((s) => `<button class="chip" data-q="${esc(s.text)}" ${aiBusy || !state.geminiKeySet || state.modelGenerating ? 'disabled' : ''}><span class="l">${esc(s.type)}</span>${esc(s.text)}</button>`).join('')}</div>`;
  }
  if (r.error)
    h =
      `<div class="anom" style="border-color:var(--rd);background:var(--rdb);color:var(--rd);">${esc(r.error)}</div>` +
      h;
  return `<div class="msg a"><div class="who">AI</div><div class="bub">${h || '<em style="color:var(--t3)">(empty response)</em>'}</div></div>`;
}

function renderAiResultCell(key, value, row = null) {
  if (value === undefined || value === null) return '<td class="cnu">[NULL]</td>';
  if (typeof value === 'number') return `<td class="cn">${fmtNum(value)}</td>`;
  if (typeof value === 'boolean') return `<td class="cb ${value ? 't' : 'f'}">${value}</td>`;

  const imageUrl = imageDataUrlFromValue(key, value, row);
  if (imageUrl) {
    const bytes = Math.max(
      0,
      Math.floor((String(value).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').length * 3) / 4),
    );
    return `<td class="ci"><img src="${esc(imageUrl)}" alt="${esc(key)}"><span>${fmtSize(bytes)}</span></td>`;
  }

  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const compact = text && text.length > 180 ? `${text.slice(0, 177)}...` : text;
  return `<td>${esc(compact ?? '')}</td>`;
}

async function sendChat() {
  if (!state.connected || state.tab !== 'ai' || !state.selectedCol) return;
  const input = $('#ai-q');
  const q = input?.value.trim();
  if (!q || aiBusy) return;
  if (!state.geminiKeySet || !getExplore(state.selectedCol) || state.modelGenerating) {
    renderAi();
    return;
  }
  const context = captureRequestContext();
  const collection = state.selectedCol;
  const request = ++chatRequest;
  const controller = new AbortController();
  chatController?.abort();
  chatController = controller;
  const isCurrent = () => isCurrentRequestContext(context) && request === chatRequest;
  const history = state.chatHistory
    .filter((m) => !m.thinking && (m.role === 'user' || (m.role === 'assistant' && m.response)))
    .map((m) => ({
      role: m.role,
      text: m.role === 'user' ? m.text : `Query: ${m.response.query}\nResult: ${m.response.summary}`,
    }));
  input.value = '';
  aiBusy = true;
  state.chatHistory.push({ role: 'user', text: q });
  const pending = { role: 'assistant', text: 'Thinking', thinking: true };
  state.chatHistory.push(pending);
  renderAi();
  try {
    const response = await api('/api/conversational/ask', {
      method: 'POST',
      body: { question: q, history, collection },
      signal: controller.signal,
    });
    if (!isCurrent()) return;
    state.chatHistory = state.chatHistory.filter((m) => m !== pending);
    state.chatHistory.push({ role: 'assistant', response });
  } catch (e) {
    if (!isCurrent()) return;
    state.chatHistory = state.chatHistory.filter((m) => m !== pending);
    state.chatHistory.push({ role: 'assistant', error: e.message || String(e) });
  } finally {
    if (isCurrent()) {
      chatController = null;
      aiBusy = false;
      renderAi();
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Chart rendering (Chart.js)
// ─────────────────────────────────────────────────────────────────
const PALETTE = ['#2c5aa0', '#0a8f4e', '#b06d00', '#6d4ab8', '#c02929', '#3771c8', '#1a8a8f', '#a3a83a'];
const aiCharts = new Map();

function destroyAiCharts() {
  for (const chart of aiCharts.values()) chart.destroy();
  aiCharts.clear();
}

function drawChart(canvas, chart, data) {
  if (!chart || !Array.isArray(data) || data.length === 0 || !Array.isArray(chart.yColumns) || !chart.yColumns.length)
    return;
  const previous = aiCharts.get(canvas);
  if (previous) {
    previous.destroy();
    aiCharts.delete(canvas);
  }
  for (const [oldCanvas, instance] of aiCharts) {
    if (!oldCanvas.isConnected) {
      instance.destroy();
      aiCharts.delete(oldCanvas);
    }
  }
  if (typeof globalThis.Chart !== 'function') {
    canvas.replaceWith(document.createTextNode('Chart unavailable. The result data is shown above.'));
    return;
  }
  const labels = data.map((r) => String(r[chart.xColumn] ?? ''));
  let datasets;
  if (chart.seriesColumn) {
    const seriesVals = Array.from(new Set(data.map((r) => String(r[chart.seriesColumn]))));
    const xVals = Array.from(new Set(labels));
    datasets = seriesVals.map((sv, i) => ({
      label: sv,
      data: xVals.map((xv) => {
        const row = data.find((r) => String(r[chart.xColumn]) === xv && String(r[chart.seriesColumn]) === sv);
        return row ? Number(row[chart.yColumns[0]]) || 0 : 0;
      }),
      backgroundColor: PALETTE[i % PALETTE.length],
      borderColor: PALETTE[i % PALETTE.length],
      borderWidth: 1,
    }));
    canvas._labels = xVals;
  } else {
    datasets = chart.yColumns.map((y, i) => ({
      label: y,
      data: data.map((r) => Number(r[y]) || 0),
      backgroundColor:
        chart.type === 'pie' || chart.type === 'doughnut'
          ? data.map((_, j) => PALETTE[j % PALETTE.length])
          : PALETTE[i % PALETTE.length],
      borderColor: PALETTE[i % PALETTE.length],
      borderWidth: 1,
    }));
    canvas._labels = labels;
  }
  const instance = new globalThis.Chart(canvas, {
    type: chart.type,
    data: { labels: canvas._labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#475569', font: { size: 11 } } },
        title: chart.title
          ? { display: true, text: chart.title, color: '#1f2937', font: { size: 13, weight: '500' } }
          : { display: false },
      },
      scales:
        chart.type === 'pie' || chart.type === 'doughnut'
          ? {}
          : {
              x: { ticks: { color: '#6b7589', font: { size: 11 } }, grid: { color: '#e9eef4' } },
              y: { ticks: { color: '#6b7589', font: { size: 11 } }, grid: { color: '#e9eef4' }, beginAtZero: true },
            },
    },
  });
  aiCharts.set(canvas, instance);
}

// ─────────────────────────────────────────────────────────────────
// Confirm modal
// ─────────────────────────────────────────────────────────────────
let pendingConfirm = null;
function confirmAction(title, msg, onConfirm) {
  const context = captureRequestContext();
  $('#confirm-title').textContent = title;
  $('#confirm-msg').textContent = msg;
  pendingConfirm = () => {
    if (isCurrentRequestContext(context)) return onConfirm();
  };
  openModal('modal-confirm');
}
$('#confirm-ok').addEventListener('click', () => {
  closeModal('modal-confirm');
  if (pendingConfirm) {
    const fn = pendingConfirm;
    pendingConfirm = null;
    fn();
  }
});

// ─────────────────────────────────────────────────────────────────
// Toolbar / global handlers
// ─────────────────────────────────────────────────────────────────
$('#sb-filter').addEventListener('input', renderTree);

// Resizable sidebar
const SB_W_KEY = 'pgstudio.sidebar.width';
const SB_W_MIN = 200,
  SB_W_MAX = 600;
function applySidebarWidth(px) {
  const w = Math.max(SB_W_MIN, Math.min(SB_W_MAX, px));
  document.documentElement.style.setProperty('--sb-w', w + 'px');
  return w;
}
(() => {
  const saved = parseInt(localStorage.getItem(SB_W_KEY) || '', 10);
  if (!isNaN(saved)) applySidebarWidth(saved);
})();
(() => {
  const h = $('#sb-resize');
  let dragging = false;
  h.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    h.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const x = e.clientX;
    const w = applySidebarWidth(x);
    localStorage.setItem(SB_W_KEY, String(w));
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    h.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// Connection pill dropdown
function closeConnMenu() {
  $('#conn-menu').classList.add('hidden');
  $('#conn-info').classList.remove('open');
}
function toggleConnMenu() {
  const m = $('#conn-menu');
  const open = m.classList.toggle('hidden');
  $('#conn-info').classList.toggle('open', !open);
}
$('#conn-info').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleConnMenu();
});
document.addEventListener('click', (e) => {
  if (!$('#conn-wrap').contains(e.target)) closeConnMenu();
});
$('#cm-key').addEventListener('click', () => {
  closeConnMenu();
  $('#set-gemini-key').value = '';
  $('#set-gemini-err').classList.add('hidden');
  $('#set-gemini-ok').classList.add('hidden');
  openModal('modal-settings');
});
$('#cm-manual-compact')?.addEventListener('click', () => {
  closeConnMenu();
  confirmAction(
    'Run full vacuum compaction?',
    'This rewrites fresh files, rebuilds indexes, and reopens the database. It is the heaviest compaction option.',
    runManualCompaction,
  );
});

$('#cm-auto-compact')?.addEventListener('change', (event) => {
  setAutoCompaction(event.target.checked);
});
$('#cm-disconnect').addEventListener('click', async () => {
  if (connectionBusy || !state.connected) return;
  closeConnMenu();
  connectionBusy = true;
  invalidateRequestContext('database');
  updateConnState();
  try {
    await api('/api/disconnect', { method: 'POST' });
    resetConnectionView();
    toast('Disconnected', 'ok');
    openModal('modal-connect');
  } catch (e) {
    toast(e.message, 'err');
    let status = null;
    try {
      status = await api('/api/status');
    } catch {
      // Leave the connection dialog usable if the daemon is unreachable.
    }
    resetConnectionView();
    if (status?.connected) {
      state.connected = true;
      state.filepath = status.filepath;
      await loadCollections();
      await loadModel();
      await refreshDatabaseStatus();
      render();
    } else openModal('modal-connect');
  } finally {
    connectionBusy = false;
    updateConnState();
  }
});
$('#sb-add-collection').addEventListener('click', openCollectionDocumentModal);
$('#doc-save').addEventListener('click', saveDocumentModal);
$('#doc-image-file').addEventListener('change', () =>
  attachImageToDocumentJson({
    textarea: $('#doc-json'),
    fieldInput: $('#doc-image-field'),
    fileInput: $('#doc-image-file'),
    preview: $('#doc-image-preview'),
    imagePayloads: documentModalImagePayloads,
    error: showDocumentModalError,
  }),
);

// Connect modal
async function connectDatabase(mode) {
  if (connectionBusy) return;
  const fp = $('#connect-filepath').value.trim();
  if (!fp) {
    $('#connect-err').classList.remove('hidden');
    $('#connect-err').textContent = 'Provide a file path.';
    return;
  }
  connectionBusy = true;
  for (const id of ['connect-open', 'connect-create', 'connect-demo']) $('#' + id).disabled = true;
  $('#connect-filepath').disabled = true;
  $('#connect-err').classList.add('hidden');
  resetConnectionView();
  try {
    const endpoint = mode === 'open' ? '/api/connect' : '/api/create';
    const { message } = await api(endpoint, { method: 'POST', body: { filepath: fp } });
    const status = await api('/api/status');
    if (!status.connected) throw new Error('The database did not open.');
    state.connected = status.connected;
    state.filepath = status.filepath;
    state.databaseStatus = status;
    toast(message, 'ok');
    closeModal('modal-connect');
    updateConnState();
    await loadCollections();
    await loadModel();
    if (mode === 'demo') await seedDemoEmployees();
    render();
  } catch (e) {
    // A failed switch may have closed the old connection. Reconcile with the daemon.
    try {
      const status = await api('/api/status');
      if (status.connected) {
        state.connected = true;
        state.filepath = status.filepath;
        state.databaseStatus = status;
        await loadCollections();
        await loadModel();
        render();
      } else resetConnectionView();
    } catch {
      resetConnectionView();
    }
    openModal('modal-connect');
    $('#connect-err').classList.remove('hidden');
    $('#connect-err').textContent = e.message;
  } finally {
    connectionBusy = false;
    for (const id of ['connect-open', 'connect-create', 'connect-demo']) $('#' + id).disabled = false;
    $('#connect-filepath').disabled = false;
    updateConnState();
  }
}
$('#connect-open').addEventListener('click', () => connectDatabase('open'));
for (const [id, mode] of [
  ['connect-create', 'create'],
  ['connect-demo', 'demo'],
]) {
  $('#' + id).addEventListener('click', () => {
    if (connectionBusy) return;
    confirmAction('Create database?', 'An existing file at this path will be replaced.', () => connectDatabase(mode));
  });
}

// Settings modal
$('#set-save-gemini').addEventListener('click', async () => {
  const save = $('#set-save-gemini');
  if (save.disabled) return;
  const key = $('#set-gemini-key').value.trim();
  if (!key) {
    $('#set-gemini-err').classList.remove('hidden');
    $('#set-gemini-err').textContent = 'Provide a key.';
    return;
  }
  save.disabled = true;
  $('#set-gemini-ok').classList.add('hidden');
  try {
    await api('/api/settings/gemini-key', { method: 'POST', body: { key } });
    state.geminiKeySet = true;
    $('#set-gemini-key').value = '';
    $('#set-gemini-ok').classList.remove('hidden');
    $('#set-gemini-err').classList.add('hidden');
    updateConnState();
    renderTabs();
    renderTab();
  } catch (e) {
    $('#set-gemini-err').classList.remove('hidden');
    $('#set-gemini-err').textContent = e.message;
  } finally {
    save.disabled = false;
  }
});
// Start
bootstrap();
let statusPolling = false;
setInterval(async () => {
  if (!state.connected || connectionBusy || statusPolling) return;
  statusPolling = true;
  try {
    const status = await refreshDatabaseStatus();
    if (status && !state.selectedCol && state.tab === 'overview') renderOverview();
  } finally {
    statusPolling = false;
  }
}, 5000);
