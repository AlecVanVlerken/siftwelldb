// @author Alexandre-Gatien Bienfet
// @date 2026-03-31

/**
 * Configuration interface for DocView.
 *
 * @author Alexandre-Gatien Bienfet
 */

import { state } from './state.js';
import type { Document } from './state.js';
import { apiCall } from './api.js';
import { toDisplayString, formatSize, escapeHTML, isImageField } from './utils.js';

// ── Configuration ────────────────────────────────────────────

interface DocViewConfig {
  docView: HTMLElement;
  docViewTitle: HTMLElement;
  docViewFields: HTMLElement;
  docViewContent: HTMLElement;
  docViewEdit: HTMLButtonElement;
  docViewSave: HTMLButtonElement;
  docViewCancel: HTMLButtonElement;
  loadDocuments: (collection: string) => Promise<void>;
  loadCollections: () => Promise<void>;
}

let cfg: DocViewConfig;

type CompressionProfileSummary = {
  id: string;
  kind: 'text' | 'image' | 'binary';
  displayName: string;
  description: string;
};

type CompressionAlgorithm = 'none' | 'gzip' | 'deflate' | 'brotli' | 'zstd-fast' | 'zstd';

type CompressionRecommendation = {
  recommended: CompressionAlgorithm;
  summary: string;
  detectedProfile: CompressionProfileSummary;
  activeProfile: CompressionProfileSummary;
  availableProfiles: CompressionProfileSummary[];
  workload: number;
  ranking: Array<{
    algorithm: CompressionAlgorithm;
    score: number;
    rationale: string;
    benchmark: {
      compressionPercent: number;
      compressMsPerMB: number;
      decompressMsPerMB: number;
    };
    observedCompressionPercent: number | null;
    effectiveCompressionPercent: number;
    beneficialSampleShare: number | null;
    estimatedStoredBytes: number | null;
    storageEstimate: {
      samples: number;
      rawSerializedBytes: number;
      compressedSerializedBytes: number;
      rawBlocks: number;
      compressedBlocks: number;
      blocksSaved: number;
      allocatedBytesSaved: number;
      readAmplification: number;
      writeCost: number;
    } | null;
  }>;
};

let compressionProfiles: CompressionProfileSummary[] = [];
let compressionProfilesPromise: Promise<CompressionProfileSummary[]> | null = null;
let compressionDefaultsCollection: string | null = null;
let compressionDefaults: Record<string, CompressionAlgorithm> = {};
let compressionDefaultsPromise: Promise<Record<string, CompressionAlgorithm>> | null = null;

window.addEventListener('compression-defaults-updated', () => {
  compressionDefaultsCollection = null;
  compressionDefaults = {};
  compressionDefaultsPromise = null;
});

/**
 * Initializes the document view component.
 *
 * @param {DocViewConfig} config The configuration object containing DOM elements and callbacks.
 *
 * @author Alexandre-Gatien Bienfet
 */
export function initDocView(config: DocViewConfig): void {
  cfg = config;
  void ensureCompressionProfilesLoaded();
}

function compressionProfileOptionsHTML(selectedId: string | undefined, autoLabel = 'Automatisch detecteren'): string {
  const autoSelected = selectedId ? '' : ' selected';
  const autoOption = `<option value=""${autoSelected}>${escapeHTML(autoLabel)}</option>`;

  if (compressionProfiles.length === 0) {
    return autoOption;
  }

  return (
    autoOption +
    compressionProfiles
      .map((profile) => {
        const selected = profile.id === selectedId ? ' selected' : '';
        return `<option value="${escapeHTML(profile.id)}"${selected}>${escapeHTML(profile.displayName)}</option>`;
      })
      .join('')
  );
}

function compressionAdvisorControlsHTML(): string {
  return `
    <div class="compression-advisor">
      <div class="compression-advisor-row">
        <label class="compression-inline-label">
          Compressie
          <select class="doc-field-compression" title="Compressie in Database">
            <option value="none">Geen compressie</option>
            <option value="gzip">Gzip</option>
            <option value="deflate">Deflate</option>
            <option value="brotli">Brotli</option>
            <option value="zstd-fast">Zstd snel</option>
            <option value="zstd">Zstd</option>
          </select>
        </label>
        <label class="compression-inline-label">
          Profiel
          <select class="doc-field-profile-override" title="Benchmarkprofiel" data-profile-overridden="false">
            ${compressionProfileOptionsHTML(undefined)}
          </select>
        </label>
      </div>
      <div class="compression-default-notice hidden"></div>
      <div class="compression-advisor-row">
        <label class="compression-workload-label">
          <span>Koud</span>
          <input type="range" class="doc-field-workload" min="0" max="100" value="50" />
          <span>Heet</span>
        </label>
        <span class="doc-field-workload-value">Gebalanceerd</span>
        <button type="button" class="doc-field-recommend-btn btn-secondary">Adviseer</button>
        <button type="button" class="doc-field-apply-recommendation btn-success hidden">Gebruik advies</button>
        <button type="button" class="doc-field-explain-toggle btn-secondary hidden">Leg uit waarom</button>
      </div>
      <div class="compression-advisor-summary">Detecteert profiel en advies...</div>
      <div class="compression-advisor-details hidden"></div>
    </div>`;
}

async function ensureCompressionProfilesLoaded(): Promise<CompressionProfileSummary[]> {
  if (compressionProfiles.length > 0) return compressionProfiles;
  if (!compressionProfilesPromise) {
    compressionProfilesPromise = apiCall('/api/compression/profiles', 'GET')
      .then((result) => {
        compressionProfiles = ((result['profiles'] as CompressionProfileSummary[] | undefined) ?? []).slice();
        return compressionProfiles;
      })
      .catch(() => {
        compressionProfiles = [];
        return compressionProfiles;
      })
      .finally(() => {
        compressionProfilesPromise = null;
        if (state.currentViewDoc && state.isEditMode) {
          renderDocFields(state.currentViewDoc, true);
        }
      });
  }
  return compressionProfilesPromise;
}

async function ensureCompressionDefaultsLoaded(): Promise<Record<string, CompressionAlgorithm>> {
  if (!state.currentCollection) return {};
  if (compressionDefaultsCollection === state.currentCollection) return compressionDefaults;
  if (!compressionDefaultsPromise) {
    const collection = state.currentCollection;
    compressionDefaultsPromise = apiCall(
      `/api/compression/defaults?collection=${encodeURIComponent(collection)}`,
      'GET',
    )
      .then((result) => {
        compressionDefaults = ((result['defaults'] as Record<string, CompressionAlgorithm> | undefined) ?? {});
        compressionDefaultsCollection = collection;
        return compressionDefaults;
      })
      .catch(() => {
        compressionDefaults = {};
        compressionDefaultsCollection = collection;
        return compressionDefaults;
      })
      .finally(() => {
        compressionDefaultsPromise = null;
      });
  }
  return compressionDefaultsPromise;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Opens the document view for a specific document.
 *
 * @param {Document} doc The document to view.
 * @param {boolean} editMode Whether to open in edit mode initially.
 * @param {boolean} [isNew=false] Whether this is a new document.
 *
 * @author Alexandre-Gatien Bienfet
 */
export function openDocView(doc: Document, editMode: boolean, isNew = false): void {
  state.currentViewDoc = doc;
  state.isEditMode = editMode;
  state.isNewDocument = isNew;

  if (isNew) {
    cfg.docViewTitle.innerHTML = `<input type="text" id="doc-view-title-input" placeholder="Titel / Document ID" value="" autocomplete="off">`;
  } else {
    cfg.docViewTitle.textContent = toDisplayString(doc['id']) || 'Document';
  }

  renderDocFields(doc, editMode);
  generateTOC();
  renderInfobox(doc);
  setEditModeUI(editMode);
  cfg.docView.classList.remove('hidden');
}

/**
 * Closes the document view and returns to the table.
 *
 * @author Alexandre-Gatien Bienfet
 */
export function closeDocView(): void {
  cfg.docView.classList.add('hidden');
  state.currentViewDoc = null;
  state.isEditMode = false;
}

/**
 * Transitions the doc view into edit mode.
 *
 * @author Alexandre-Gatien Bienfet
 */
export function enterEditMode(): void {
  if (!state.currentViewDoc) return;
  state.isEditMode = true;
  renderDocFields(state.currentViewDoc, true);
  setEditModeUI(true);
}

/**
 * Cancels edit mode and reverts unsaved changes in the DOM.
 *
 * @author Alexandre-Gatien Bienfet
 */
export function cancelEditMode(): void {
  if (!state.currentViewDoc) return;
  state.isEditMode = false;
  renderDocFields(state.currentViewDoc, false);
  setEditModeUI(false);
}

/**
 * Saves the document view content to the backend.
 *
 * @returns {Promise<void>} Resolves when the document is saved.
 *
 * @author Alexandre-Gatien Bienfet
 */
export async function saveDocView(): Promise<void> {
  if (!state.currentCollection) return;

  const titleInput = document.getElementById('doc-view-title-input') as HTMLInputElement;
  const id = state.isNewDocument ? titleInput?.value.trim() : toDisplayString(state.currentViewDoc!['id']);

  if (!id) {
    alert('Vergeet niet een Document ID (Titel) in te vullen.');
    return;
  }

  const newDoc: Record<string, unknown> = { id };
  const order: string[] = [];
  const compression: Record<string, string> = {};

  cfg.docViewContent.querySelectorAll('.doc-field-section').forEach((sec) => {
    const titleEl = sec.querySelector<HTMLInputElement>('.doc-field-section-title');
    const title = titleEl ? titleEl.value.trim() : sec.querySelector('h2')?.textContent?.trim();
    const textarea = sec.querySelector<HTMLTextAreaElement>('textarea');
    const fileInput = sec.querySelector<HTMLInputElement>('input[type="file"]');
    const posInput = sec.querySelector<HTMLInputElement>('.image-position-value');
    const compSelect = sec.querySelector<HTMLSelectElement>('.doc-field-compression');

    if (!title) return;

    let didAdd = false;

    if (textarea && textarea.value.trim() !== '') {
      let val: unknown = textarea.value;
      try {
        val = JSON.parse(textarea.value);
      } catch {
        /* keep as string */
      }
      newDoc[title] = val;
      if (!order.includes(title)) order.push(title);
      didAdd = true;
    } else if (fileInput) {
      const finalBase64 = fileInput.dataset['newbase64'] || fileInput.dataset['original'];
      if (finalBase64 && isImageField(title)) {
        newDoc[title] = finalBase64;
        if (posInput) newDoc[`_layout_${title}`] = posInput.value;
        if (!order.includes(title)) order.push(title);
        didAdd = true;
      }
    }

    if (didAdd && compSelect) {
      const hasAdvisorDefault = compSelect.dataset['hasCompressionDefault'] === 'true';
      const defaultCompression = compSelect.dataset['defaultCompression'] ?? 'none';
      if (hasAdvisorDefault) {
        if (compSelect.value !== defaultCompression) {
          compression[title] = compSelect.value;
        }
      } else if (compSelect.value !== 'none') {
        compression[title] = compSelect.value;
      }
    }
  });

  if (order.length > 0) newDoc['_order_'] = order.join(',');
  newDoc['title'] = id; // For semantic search indexing

  const reqBody: Record<string, unknown> = { document: newDoc };
  if (Object.keys(compression).length > 0) {
    reqBody['compression'] = compression;
  }

  try {
    if (!state.isNewDocument) {
      await apiCall(
        `/api/documents/${encodeURIComponent(state.currentCollection)}/${encodeURIComponent(id)}`,
        'DELETE',
      );
    }
    await apiCall(`/api/documents/${encodeURIComponent(state.currentCollection)}`, 'POST', reqBody);
    await cfg.loadDocuments(state.currentCollection);
    await cfg.loadCollections();

    if (state.isNewDocument) {
      closeDocView();
    } else {
      const updatedDoc = state.allDocuments.find((d) => String(d['id']) === String(id));
      if (updatedDoc) openDocView(updatedDoc, false);
      else closeDocView();
    }
  } catch (error) {
    alert('Opslaan mislukt: ' + (error as Error).message);
  }
}

// ── Field rendering ──────────────────────────────────────────

function renderDocFields(doc: Document, editMode: boolean): void {
  cfg.docViewFields.innerHTML = '';
  cfg.docViewContent.innerHTML = '';

  // Determine field order
  let keys: string[] = [];
  if (typeof doc['_order_'] === 'string' && doc['_order_'].trim() !== '') {
    keys = doc['_order_'].split(',');
    const otherKeys = Object.keys(doc).filter(
      (k) => k !== 'id' && !k.startsWith('_layout_') && k !== '_order_' && !keys.includes(k),
    );
    keys = keys.concat(otherKeys);
  } else {
    keys = Object.keys(doc).filter((k) => k !== 'id' && !k.startsWith('_layout_') && k !== '_order_');
  }

  const entries = keys.map((key) => [key, doc[key]] as [string, unknown]);

  let contentHTML = '';
  entries.forEach(([key, value]) => {
    if (key === 'title') return; // Hide injected search title

    contentHTML += `<div class="doc-field-section">`;

    if (state.isNewDocument || editMode) {
      const isImg = isImageField(key);
      contentHTML += `<div class="doc-field-header">`;
      if (editMode) {
        contentHTML += `<span class="drag-handle" title="Slepen om te verplaatsen">⠿</span>`;
      }
      if (isImg) {
        contentHTML += `<input type="hidden" class="doc-field-section-title" value="${escapeHTML(key)}">`;
        contentHTML += `<span class="image-field-label">Afbeelding sectie</span>`;
      } else {
        contentHTML += `<input type="text" class="doc-field-section-title" value="${escapeHTML(key)}" placeholder="Sectie Naam">`;
      }

      contentHTML += `<div class="field-actions">
        <button class="remove-field-btn" type="button" title="Sectie verwijderen" onclick="this.closest('.doc-field-section').remove()">✕</button>
      </div></div>`;
      contentHTML += compressionAdvisorControlsHTML();
    } else {
      if (!isImageField(key)) {
        contentHTML += `<h2>${escapeHTML(key)}</h2>`;
      }
    }

    if (isImageField(key)) {
      const layoutVal = doc[`_layout_${key}`];
      const position = typeof layoutVal === 'string' ? layoutVal : 'below';
      const base64 = typeof value === 'string' ? value : '';
      if (editMode) {
        contentHTML += renderImageEditHTML(key, base64, position);
      } else {
        contentHTML += `
          <figure class="doc-image-figure pos-${escapeHTML(position)}">
            <img src="data:image/jpeg;base64,${escapeHTML(base64)}" alt="${escapeHTML(key)}">
          </figure>`;
      }
    } else {
      const displayValue =
        typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : toDisplayString(value);
      if (editMode) {
        contentHTML += `<textarea class="doc-field-value is-object" data-key="${escapeHTML(key)}" data-original="${escapeHTML(displayValue)}">${escapeHTML(displayValue)}</textarea>`;
      } else {
        contentHTML += `<div class="doc-field-value is-object">${escapeHTML(displayValue)}</div>`;
      }
    }
    contentHTML += `</div>`;
  });

  if (editMode) {
    contentHTML += `<div class="doc-add-buttons">
      <button id="add-doc-field-btn">+ Tekst Toevoegen</button>
      <button id="add-doc-image-btn">+ Afbeelding Toevoegen</button>
    </div>`;
  }

  if (!state.isNewDocument) {
    const totalFields = Object.keys(doc).length;
    contentHTML +=
      `<p class="doc-meta" style="clear:both;">Dit document bevat ${totalFields} veld${totalFields !== 1 ? 'en' : ''}. ` +
      `Grootte: ${formatSize(new TextEncoder().encode(JSON.stringify(doc)).length)}.</p>`;
  }

  cfg.docViewContent.innerHTML = contentHTML;

  if (editMode) {
    const addTextBtn = document.getElementById('add-doc-field-btn');
    if (addTextBtn) addTextBtn.onclick = () => addNewFieldToView('text');
    const addImgBtn = document.getElementById('add-doc-image-btn');
    if (addImgBtn) addImgBtn.onclick = () => addNewFieldToView('image');

    attachImageEvents(cfg.docViewContent);
    attachPositionEvents(cfg.docViewContent);
    initializeCompressionAdvisorControls(cfg.docViewContent);
  }
}

// ── Image helpers (shared between renderDocFields & addNewFieldToView) ──

function renderImageEditHTML(key: string, base64: string, position: string): string {
  return `
    <div class="image-upload-area" onclick="this.querySelector('input[type=file]').click()">
      <input type="file" accept="image/jpeg, image/png, image/webp" data-key="${escapeHTML(key)}" data-original="${escapeHTML(base64)}">
      <img src="${base64 ? `data:image/jpeg;base64,${escapeHTML(base64)}` : ''}" class="image-preview-img" style="${base64 ? '' : 'display:none;'}">
      <span class="upload-hint" style="${base64 ? 'display:none;' : ''}">Klik hier om een afbeelding te selecteren</span>
    </div>
    ${positionControlsHTML(position)}`;
}

function positionControlsHTML(active: string): string {
  const positions = [
    { value: 'above', label: 'Boven' },
    { value: 'left', label: 'Links' },
    { value: 'below', label: 'Onder' },
    { value: 'right', label: 'Rechts' },
  ];
  let html = `<div class="image-position-controls">`;
  positions.forEach(({ value, label }) => {
    html += `<button type="button" class="${value === active ? 'active' : ''}" data-pos="${value}">${label}</button>`;
  });
  html += `<input type="hidden" class="image-position-value" value="${escapeHTML(active)}"></div>`;
  return html;
}

function handleFileInputChange(fileInput: HTMLInputElement): void {
  const file = fileInput.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const area = fileInput.closest('.image-upload-area');
    if (!area) return;
    const img = area.querySelector('.image-preview-img') as HTMLImageElement;
    const hint = area.querySelector('.upload-hint') as HTMLElement;
    if (img && hint) {
      const base64URL = e.target?.result as string;
      img.src = base64URL;
      img.style.display = 'block';
      hint.style.display = 'none';
      fileInput.dataset['newbase64'] = base64URL.split(',')[1];
    }
  };
  reader.readAsDataURL(file);
}

function attachImageEvents(container: HTMLElement): void {
  container.querySelectorAll('input[type="file"]').forEach((input) => {
    const fi = input as HTMLInputElement;
    fi.onchange = () => handleFileInputChange(fi);
    fi.onclick = (e) => e.stopPropagation();
  });
}

function attachPositionEvents(container: HTMLElement): void {
  container.querySelectorAll('.image-position-controls').forEach((controls) => {
    const btns = controls.querySelectorAll('button');
    const hiddenInput = controls.querySelector('.image-position-value') as HTMLInputElement;
    btns.forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        btns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        if (hiddenInput) {
          hiddenInput.value = hiddenInput.dataset['pos'] || 'below';
          hiddenInput.setAttribute('value', hiddenInput.value);
        }
      };
    });
  });
}

// ── Dynamic field addition ───────────────────────────────────

function addNewFieldToView(type: 'text' | 'image' = 'text'): void {
  const section = document.createElement('div');
  section.className = 'doc-field-section';
  let fieldName = '';

  // Header row
  const headerDiv = document.createElement('div');
  headerDiv.className = 'doc-field-header';

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.title = 'Slepen om te verplaatsen';
  handle.textContent = '⠿';
  headerDiv.appendChild(handle);

  if (type === 'image') {
    const hiddenTitle = document.createElement('input');
    hiddenTitle.type = 'hidden';
    hiddenTitle.className = 'doc-field-section-title';
    fieldName = `_img_${Date.now()}.jpeg`;
    hiddenTitle.value = fieldName;
    const label = document.createElement('span');
    label.className = 'image-field-label';
    label.textContent = 'Afbeelding sectie';
    headerDiv.appendChild(hiddenTitle);
    headerDiv.appendChild(label);
  } else {
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'doc-field-section-title';
    titleInput.placeholder = 'Sectie Naam';
    headerDiv.appendChild(titleInput);
  }

  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'field-actions';
  const delBtn = document.createElement('button');
  delBtn.className = 'remove-field-btn';
  delBtn.innerHTML = '✕';
  delBtn.type = 'button';
  delBtn.title = 'Sectie verwijderen';
  delBtn.onclick = () => section.remove();
  actionsDiv.appendChild(delBtn);
  headerDiv.appendChild(actionsDiv);
  section.appendChild(headerDiv);

  if (type === 'text') {
    const textarea = document.createElement('textarea');
    textarea.className = 'doc-field-value is-object';
    textarea.placeholder = 'Tekst weergave...';
    section.appendChild(textarea);
  } else {
    // Image upload area
    const uploadArea = document.createElement('div');
    uploadArea.className = 'image-upload-area';
    uploadArea.innerHTML = `
      <input type="file" accept="image/jpeg, image/png, image/webp" data-newbase64="">
      <img src="" class="image-preview-img" style="display:none;">
      <span class="upload-hint">Klik hier om een afbeelding te selecteren</span>
    `;
    uploadArea.onclick = () => {
      const fi = uploadArea.querySelector('input');
      if (fi) fi.click();
    };
    attachImageEvents(uploadArea);

    // Position controls
    const controlsWrapper = document.createElement('div');
    controlsWrapper.innerHTML = positionControlsHTML('below');
    const controls = controlsWrapper.firstElementChild as HTMLElement;
    attachPositionEvents(controls);

    section.appendChild(uploadArea);
    section.appendChild(controls);
  }

  section.insertAdjacentHTML('beforeend', compressionAdvisorControlsHTML());

  const wrapper = cfg.docViewContent.querySelector('.doc-add-buttons');
  if (wrapper) {
    cfg.docViewContent.insertBefore(section, wrapper);
  } else {
    cfg.docViewContent.appendChild(section);
  }

  const inputToFocus = section.querySelector<HTMLInputElement>('input.doc-field-section-title');
  if (inputToFocus && inputToFocus.type !== 'hidden') inputToFocus.focus();

  initializeCompressionAdvisorControls(section);
}

function workloadTextFromValue(value: number): string {
  if (value <= 0.25) return 'Koud';
  if (value >= 0.75) return 'Heet';
  return 'Gebalanceerd';
}

function getSectionFieldName(section: Element): string {
  const titleInput = section.querySelector<HTMLInputElement>('.doc-field-section-title');
  if (titleInput) return titleInput.value.trim();
  return section.querySelector('h2')?.textContent?.trim() ?? '';
}

function getSectionDraftValue(section: Element, fieldName: string): string | undefined {
  const textarea = section.querySelector<HTMLTextAreaElement>('textarea.doc-field-value');
  if (textarea) return textarea.value;

  const fileInput = section.querySelector<HTMLInputElement>('input[type="file"]');
  if (fileInput && isImageField(fieldName)) {
    return fileInput.dataset['newbase64'] || fileInput.dataset['original'] || undefined;
  }

  return undefined;
}

async function applyCompressionDefaultToSection(section: HTMLElement): Promise<void> {
  const fieldName = getSectionFieldName(section);
  const compressionSelect = section.querySelector<HTMLSelectElement>('.doc-field-compression');
  const notice = section.querySelector<HTMLElement>('.compression-default-notice');
  if (!compressionSelect || !notice || !fieldName) return;

  const defaults = await ensureCompressionDefaultsLoaded();
  const defaultCompression = defaults[fieldName];
  if (!defaultCompression) {
    compressionSelect.dataset['hasCompressionDefault'] = 'false';
    compressionSelect.dataset['defaultCompression'] = 'none';
    notice.classList.add('hidden');
    notice.textContent = '';
    return;
  }

  compressionSelect.dataset['hasCompressionDefault'] = 'true';
  compressionSelect.dataset['defaultCompression'] = defaultCompression;
  compressionSelect.value = defaultCompression;
  notice.textContent =
    defaultCompression === 'none'
      ? 'Advisor default active: no compression. Change this field to override for this document.'
      : `Advisor default active: ${defaultCompression}. Change this field to override for this document.`;
  notice.classList.remove('hidden');
}

function renderCompressionExplanation(recommendation: CompressionRecommendation): string {
  const items = recommendation.ranking
    .map((item) => {
      const observed =
        item.observedCompressionPercent === null
          ? 'geen lokale sample'
          : `${item.observedCompressionPercent.toFixed(0)}% lokaal`;
      const storedBytes =
        item.estimatedStoredBytes === null ? 'n.v.t.' : `${item.estimatedStoredBytes.toFixed(0)} B gemiddeld`;
      const blockEstimate =
        item.storageEstimate === null
          ? 'geen blockschatting'
          : `${item.storageEstimate.blocksSaved} blocks bespaard, ${formatSize(
              item.storageEstimate.allocatedBytesSaved,
            )} allocatie bespaard, read x${item.storageEstimate.readAmplification.toFixed(2)}`;
      return `
        <div class="compression-ranking-item">
          <div class="compression-ranking-header">
            <strong>${escapeHTML(item.algorithm)}</strong>
            <span class="compression-score">${item.score.toFixed(2)}</span>
          </div>
          <div class="compression-ranking-meta">
            ${escapeHTML(
              `${item.benchmark.compressionPercent.toFixed(0)}% benchmark compressie, ${item.benchmark.compressMsPerMB.toFixed(1)} ms/MB enc, ${item.benchmark.decompressMsPerMB.toFixed(1)} ms/MB dec, ${observed}, ${storedBytes}, ${blockEstimate}`,
            )}
          </div>
          <p>${escapeHTML(item.rationale)}</p>
        </div>`;
    })
    .join('');

  return `
    <div class="compression-detected-profile">
      Gedetecteerd: <strong>${escapeHTML(recommendation.detectedProfile.displayName)}</strong>
      ${
        recommendation.detectedProfile.id !== recommendation.activeProfile.id
          ? ` | Actief: <strong>${escapeHTML(recommendation.activeProfile.displayName)}</strong>`
          : ''
      }
    </div>
    ${items}`;
}

async function requestCompressionRecommendation(section: HTMLElement, silent = false): Promise<void> {
  if (!state.currentCollection) return;

  const fieldName = getSectionFieldName(section);
  if (!fieldName) return;

  const summary = section.querySelector<HTMLElement>('.compression-advisor-summary');
  const details = section.querySelector<HTMLElement>('.compression-advisor-details');
  const explainBtn = section.querySelector<HTMLButtonElement>('.doc-field-explain-toggle');
  const applyBtn = section.querySelector<HTMLButtonElement>('.doc-field-apply-recommendation');
  const compressionSelect = section.querySelector<HTMLSelectElement>('.doc-field-compression');
  const profileSelect = section.querySelector<HTMLSelectElement>('.doc-field-profile-override');
  const workload = section.querySelector<HTMLInputElement>('.doc-field-workload');

  if (!summary || !details || !explainBtn || !applyBtn || !compressionSelect || !profileSelect || !workload) {
    return;
  }

  summary.textContent = silent ? 'Analyseert...' : 'Advies wordt berekend...';

  try {
    const profileOverride =
      profileSelect.dataset['profileOverridden'] === 'true' && profileSelect.value ? profileSelect.value : undefined;
    const response = await apiCall('/api/compression/recommendation', 'POST', {
      collection: state.currentCollection,
      field: fieldName,
      workload: Number(workload.value) / 100,
      profileOverride,
      draftValue: getSectionDraftValue(section, fieldName),
    });

    const recommendation = response['recommendation'] as CompressionRecommendation;
    const hasManualProfileOverride = profileSelect.dataset['profileOverridden'] === 'true';
    section.dataset['recommendedCompression'] = recommendation.recommended;
    profileSelect.innerHTML = compressionProfileOptionsHTML(
      hasManualProfileOverride ? recommendation.activeProfile.id : undefined,
      `Automatisch: ${recommendation.activeProfile.displayName}`,
    );
    summary.textContent = recommendation.summary;
    details.innerHTML = renderCompressionExplanation(recommendation);
    explainBtn.classList.remove('hidden');
    applyBtn.classList.remove('hidden');
    applyBtn.onclick = () => {
      compressionSelect.value = recommendation.recommended;
      compressionSelect.dispatchEvent(new Event('change'));
      summary.textContent = `Advies toegepast: ${recommendation.recommended}. ${recommendation.summary}`;
    };
  } catch (error) {
    summary.textContent = `Advies mislukt: ${(error as Error).message}`;
    details.classList.add('hidden');
    explainBtn.classList.add('hidden');
    applyBtn.classList.add('hidden');
  }
}

function getAdvisorSections(container: HTMLElement): HTMLElement[] {
  const nested = Array.from(container.querySelectorAll<HTMLElement>('.doc-field-section'));
  if (container.classList.contains('doc-field-section')) {
    return [container, ...nested];
  }
  return nested;
}

function initializeCompressionAdvisorControls(container: HTMLElement): void {
  if (compressionProfiles.length === 0) {
    void ensureCompressionProfilesLoaded();
  }

  for (const section of getAdvisorSections(container)) {
    const workload = section.querySelector<HTMLInputElement>('.doc-field-workload');
    const workloadLabel = section.querySelector<HTMLElement>('.doc-field-workload-value');
    const recommendBtn = section.querySelector<HTMLButtonElement>('.doc-field-recommend-btn');
    const explainBtn = section.querySelector<HTMLButtonElement>('.doc-field-explain-toggle');
    const details = section.querySelector<HTMLElement>('.compression-advisor-details');
    const profileSelect = section.querySelector<HTMLSelectElement>('.doc-field-profile-override');
    const titleInput = section.querySelector<HTMLInputElement>('.doc-field-section-title');
    const compressionSelect = section.querySelector<HTMLSelectElement>('.doc-field-compression');

    if (workload && workloadLabel) {
      workloadLabel.textContent = workloadTextFromValue(Number(workload.value) / 100);
      workload.oninput = () => {
        workloadLabel.textContent = workloadTextFromValue(Number(workload.value) / 100);
      };
    }

    if (profileSelect) {
      if (compressionProfiles.length > 0 && profileSelect.options.length <= 1) {
        profileSelect.innerHTML = compressionProfileOptionsHTML(undefined);
      }
      profileSelect.onchange = () => {
        const summary = section.querySelector<HTMLElement>('.compression-advisor-summary');
        profileSelect.dataset['profileOverridden'] = profileSelect.value ? 'true' : 'false';
        if (summary) summary.textContent = 'Profiel aangepast. Klik op Adviseer om opnieuw te berekenen.';
      };
    }

    if (compressionSelect) {
      compressionSelect.onchange = () => {
        const notice = section.querySelector<HTMLElement>('.compression-default-notice');
        if (notice && compressionSelect.dataset['hasCompressionDefault'] === 'true') {
          const defaultCompression = compressionSelect.dataset['defaultCompression'] ?? 'none';
          if (compressionSelect.value === defaultCompression) {
            notice.textContent =
              defaultCompression === 'none'
                ? 'Advisor default active: no compression. Change this field to override for this document.'
                : `Advisor default active: ${defaultCompression}. Change this field to override for this document.`;
          } else {
            notice.textContent = `Override for this document: ${compressionSelect.value} instead of advisor default ${defaultCompression}.`;
          }
        }
      };
    }

    if (recommendBtn) {
      recommendBtn.onclick = () => {
        void requestCompressionRecommendation(section, false);
      };
    }

    if (explainBtn && details) {
      explainBtn.onclick = () => {
        details.classList.toggle('hidden');
        explainBtn.textContent = details.classList.contains('hidden') ? 'Leg uit waarom' : 'Verberg uitleg';
      };
    }

    if (titleInput && titleInput.type !== 'hidden') {
      titleInput.onchange = () => {
        const summary = section.querySelector<HTMLElement>('.compression-advisor-summary');
        const profile = section.querySelector<HTMLSelectElement>('.doc-field-profile-override');
        if (summary) summary.textContent = 'Veld aangepast. Klik op Adviseer om het profiel opnieuw te detecteren.';
        if (profile) {
          profile.dataset['profileOverridden'] = 'false';
          profile.innerHTML = compressionProfileOptionsHTML(undefined);
        }
        void applyCompressionDefaultToSection(section);
      };
    }

    if (!section.dataset['advisorInitialized']) {
      section.dataset['advisorInitialized'] = 'true';
      void applyCompressionDefaultToSection(section).then(() => requestCompressionRecommendation(section, false));
    }
  }
}

// ── Edit mode UI ─────────────────────────────────────────────

function setEditModeUI(editMode: boolean): void {
  if (editMode) {
    cfg.docViewEdit.classList.add('hidden');
    cfg.docViewSave.classList.remove('hidden');
    cfg.docViewCancel.classList.remove('hidden');

    if (!state.sortableInstance) {
      state.sortableInstance = new Sortable(cfg.docViewContent, {
        animation: 150,
        handle: '.drag-handle',
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
      });
    }
  } else {
    cfg.docViewEdit.classList.remove('hidden');
    cfg.docViewSave.classList.add('hidden');
    cfg.docViewCancel.classList.add('hidden');

    if (state.sortableInstance) {
      state.sortableInstance.destroy();
      state.sortableInstance = null;
    }
  }
}

// ── Wikipedia-style extras ───────────────────────────────────

function generateTOC(): void {
  const tocList = document.getElementById('doc-toc-list');
  if (!tocList) return;
  tocList.innerHTML = '';

  const headings = cfg.docViewContent.querySelectorAll('h2, h3');
  if (headings.length === 0) {
    const emptyLi = document.createElement('li');
    emptyLi.className = 'doc-toc-item';
    emptyLi.textContent = 'Geen secties';
    emptyLi.style.fontStyle = 'italic';
    emptyLi.style.color = 'var(--text-muted)';
    tocList.appendChild(emptyLi);
    return;
  }

  headings.forEach((heading, index) => {
    heading.id = `section-${index}`;
    const level = heading.tagName.toLowerCase();
    const li = document.createElement('li');
    li.className = `doc-toc-item toc-${level}`;

    const a = document.createElement('a');
    a.href = `#${heading.id}`;
    a.textContent = heading.textContent || `Sectie ${index}`;
    a.onclick = (e) => {
      e.preventDefault();
      heading.scrollIntoView({ behavior: 'smooth' });
    };

    li.appendChild(a);
    tocList.appendChild(li);
  });
}

function renderInfobox(doc: Document): void {
  const infobox = document.getElementById('doc-infobox');
  if (!infobox) return;

  if (state.isNewDocument) {
    infobox.innerHTML = '';
    return;
  }

  let html = `<div class="doc-infobox-title">${escapeHTML(toDisplayString(doc['id']) || 'Informatie')}</div>`;

  // Featured image
  const imageKey = Object.keys(doc).find((key) => isImageField(key));
  if (imageKey && typeof doc[imageKey] === 'string' && doc[imageKey]) {
    html += `
      <div class="doc-infobox-image">
        <img src="data:image/jpeg;base64,${escapeHTML(doc[imageKey])}" alt="Afbeelding">
      </div>`;
  }

  html += `<table class="doc-infobox-table"><tbody>`;

  const ignoreKeys = ['Browser', 'browser', 'Inleiding', 'inleiding', 'Summary', 'summary', 'Text', 'text', 'title'];

  for (const [key, value] of Object.entries(doc)) {
    if (key === 'id' || isImageField(key) || key.startsWith('_layout_') || ignoreKeys.includes(key)) continue;
    if (typeof value === 'string' && value.length < 30) {
      html += `<tr><th>${escapeHTML(key)}</th><td>${escapeHTML(value)}</td></tr>`;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      html += `<tr><th>${escapeHTML(key)}</th><td>${escapeHTML(String(value))}</td></tr>`;
    }
  }

  const size = formatSize(new TextEncoder().encode(JSON.stringify(doc)).length);
  html += `<tr><th>Collectie</th><td>${escapeHTML(state.currentCollection || '')}</td></tr>`;
  html += `<tr><th>Grootte (Mem)</th><td>${escapeHTML(size)}</td></tr>`;
  html += `<tr id="infobox-db-size-row"><th>Grootte (Disk)</th><td style="color: grey; font-style: italic;">Berekent...</td></tr>`;

  html += `</tbody></table>`;
  infobox.innerHTML = html;

  if (!state.isNewDocument && state.currentCollection) {
    const docId = toDisplayString(doc['id']);
    apiCall(
      `/api/documents/${encodeURIComponent(state.currentCollection)}/${encodeURIComponent(docId)}/metadata`,
      'GET',
    )
      .then((metaResult) => {
        const row = document.getElementById('infobox-db-size-row');
        if (row && metaResult && typeof metaResult['storedSize'] === 'number') {
          row.innerHTML = `<th>Grootte (Disk)</th><td style="color: green; font-weight: bold;">${escapeHTML(formatSize(metaResult['storedSize']))}</td>`;
          const comps = metaResult['compressions'] as Record<string, string> | undefined;
          if (comps && Object.keys(comps).length > 0) {
            let compHtml = '';
            for (const [k, v] of Object.entries(comps)) {
              if (v !== 'none') {
                compHtml += `<tr><th>${escapeHTML(k)}</th><td style="color: blue;">${escapeHTML(v)}</td></tr>`;
              }
            }
            row.insertAdjacentHTML('afterend', compHtml);
          }
        }
      })
      .catch(() => {
        const row = document.getElementById('infobox-db-size-row');
        if (row) row.innerHTML = `<th>Grootte (Disk)</th><td>Onbekend</td>`;
      });
  }
}

// ── TOC toggle ───────────────────────────────────────────────

const tocToggleBtn = document.getElementById('doc-toc-toggle');
if (tocToggleBtn) {
  tocToggleBtn.addEventListener('click', () => {
    const tocList = document.getElementById('doc-toc-list');
    if (tocList) {
      tocList.classList.toggle('collapsed');
      tocToggleBtn.textContent = tocList.classList.contains('collapsed') ? 'tonen' : 'verbergen';
    }
  });
}
