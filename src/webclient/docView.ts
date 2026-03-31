// author: Alexandre-Gatien Bienfet
// date: 2026-02-23
//
// Wikipedia-style document detail view for the SimpleDBMS webclient
// Handles viewing, editing, creating documents, TOC and infobox.

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

export function initDocView(config: DocViewConfig): void {
  cfg = config;
}

// ── Public API ───────────────────────────────────────────────

export function openDocView(doc: Document, editMode: boolean, isNew = false): void {
  state.currentViewDoc = doc;
  state.isEditMode = editMode;
  state.isNewDocument = isNew;

  if (isNew) {
    cfg.docViewTitle.innerHTML =
      `<input type="text" id="doc-view-title-input" placeholder="Titel / Document ID" value="" autocomplete="off">`;
  } else {
    cfg.docViewTitle.textContent = toDisplayString(doc['id']) || 'Document';
  }

  renderDocFields(doc, editMode);
  generateTOC();
  renderInfobox(doc);
  setEditModeUI(editMode);
  cfg.docView.classList.remove('hidden');
}

export function closeDocView(): void {
  cfg.docView.classList.add('hidden');
  state.currentViewDoc = null;
  state.isEditMode = false;
}

export function enterEditMode(): void {
  if (!state.currentViewDoc) return;
  state.isEditMode = true;
  renderDocFields(state.currentViewDoc, true);
  setEditModeUI(true);
}

export function cancelEditMode(): void {
  if (!state.currentViewDoc) return;
  state.isEditMode = false;
  renderDocFields(state.currentViewDoc, false);
  setEditModeUI(false);
}

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

  cfg.docViewContent.querySelectorAll('.doc-field-section').forEach((sec) => {
    const titleEl = sec.querySelector('.doc-field-section-title') as HTMLInputElement;
    const title = titleEl ? titleEl.value.trim() : sec.querySelector('h2')?.textContent?.trim();
    const textarea = sec.querySelector('textarea');
    const fileInput = sec.querySelector('input[type="file"]') as HTMLInputElement | null;
    const posInput = sec.querySelector('.image-position-value') as HTMLInputElement | null;

    if (!title) return;

    if (textarea && textarea.value.trim() !== '') {
      let val: unknown = textarea.value;
      try { val = JSON.parse(textarea.value); } catch { /* keep as string */ }
      newDoc[title] = val;
      if (!order.includes(title)) order.push(title);
    } else if (fileInput) {
      const finalBase64 = fileInput.dataset['newbase64'] || fileInput.dataset['original'];
      if (finalBase64 && isImageField(title)) {
        newDoc[title] = finalBase64;
        if (posInput) newDoc[`_layout_${title}`] = posInput.value;
        if (!order.includes(title)) order.push(title);
      }
    }
  });

  if (order.length > 0) newDoc['_order_'] = order.join(',');
  newDoc['title'] = id; // For semantic search indexing

  try {
    if (!state.isNewDocument) {
      await apiCall(
        `/api/documents/${encodeURIComponent(state.currentCollection)}/${encodeURIComponent(id)}`,
        'DELETE',
      );
    }
    await apiCall(`/api/documents/${encodeURIComponent(state.currentCollection)}`, 'POST', { document: newDoc });
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
    keys = (doc['_order_'] as string).split(',');
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
    } else {
      if (!isImageField(key)) {
        contentHTML += `<h2>${escapeHTML(key)}</h2>`;
      }
    }

    if (isImageField(key)) {
      const position = String(doc[`_layout_${key}`] || 'below');
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
          hiddenInput.value = (btn as HTMLButtonElement).dataset['pos'] || 'below';
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
    hiddenTitle.value = `_img_${Date.now()}.jpeg`;
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

  const wrapper = cfg.docViewContent.querySelector('.doc-add-buttons');
  if (wrapper) {
    cfg.docViewContent.insertBefore(section, wrapper);
  } else {
    cfg.docViewContent.appendChild(section);
  }

  const inputToFocus = section.querySelector('input.doc-field-section-title') as HTMLInputElement | null;
  if (inputToFocus && inputToFocus.type !== 'hidden') inputToFocus.focus();
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
        <img src="data:image/jpeg;base64,${escapeHTML(doc[imageKey] as string)}" alt="Afbeelding">
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
  html += `<tr><th>Grootte</th><td>${escapeHTML(size)}</td></tr>`;
  html += `</tbody></table>`;
  infobox.innerHTML = html;
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
