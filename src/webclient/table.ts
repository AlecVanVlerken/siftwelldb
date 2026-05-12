// @author Alexandre-Gatien Bienfet
// @date 2026-03-31

import { state } from './state.js';
import type { Document } from './state.js';
import { toDisplayString, formatSize } from './utils.js';

// ── Configuration ────────────────────────────────────────────

interface TableConfig {
  dataTableHead: HTMLElement;
  dataTableBody: HTMLElement;
  onOpenDoc: (doc: Document, editMode: boolean) => void;
  onDeleteDoc: (id: string | number) => void;
}

let cfg: TableConfig;

/**
 * Initializes the document table component.
 *
 * @param {TableConfig} config Configuration containing DOM elements and callbacks.
 *
 * @author Alexandre-Gatien Bienfet
 */
export function initTable(config: TableConfig): void {
  cfg = config;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Applies the current text filter to the documents table.
 *
 * @param {HTMLInputElement} filterInput The input element containing the filter query.
 *
 * @author Alexandre-Gatien Bienfet
 */
export function applyFilter(filterInput: HTMLInputElement): void {
  const query = filterInput.value.trim().toLowerCase();
  if (!query) {
    renderTable(state.allDocuments);
    return;
  }
  const filtered = state.allDocuments.filter((doc) =>
    Object.values(doc).some((v) => String(v).toLowerCase().includes(query)),
  );
  renderTable(filtered);
}

/**
 * Renders the documents table with the given data.
 *
 * @param {Document[]} documents Array of document objects to display.
 *
 * @author Alexandre-Gatien Bienfet
 */
export function renderTable(documents: Document[]): void {
  cfg.dataTableHead.innerHTML = '';
  cfg.dataTableBody.innerHTML = '';

  // Header
  const trHead = document.createElement('tr');
  ['ID', 'Grootte', ''].forEach((label) => {
    const th = document.createElement('th');
    th.textContent = label;
    if (!label) th.className = 'col-actions';
    trHead.appendChild(th);
  });
  cfg.dataTableHead.appendChild(trHead);

  if (documents.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="3" class="empty-row">Geen documenten gevonden</td>';
    cfg.dataTableBody.appendChild(tr);
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

    [tdId, tdSize].forEach((td) => {
      td.style.cursor = 'pointer';
      td.onclick = () => cfg.onOpenDoc(doc, false);
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
      cfg.onOpenDoc(doc, true);
    };

    const deleteItem = document.createElement('button');
    deleteItem.className = 'dropdown-item dropdown-item--danger';
    deleteItem.textContent = 'Verwijderen';
    deleteItem.onclick = (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      cfg.onDeleteDoc(doc['id'] as string | number);
    };

    dropdown.appendChild(editItem);
    dropdown.appendChild(deleteItem);

    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const isOpen = !dropdown.classList.contains('hidden');
      closeAllDropdowns();
      if (!isOpen) dropdown.classList.remove('hidden');
    };

    tdActions.appendChild(menuBtn);
    tdActions.appendChild(dropdown);

    tr.appendChild(tdId);
    tr.appendChild(tdSize);
    tr.appendChild(tdActions);
    cfg.dataTableBody.appendChild(tr);
  });
}

/**
 * Closes all active action dropdown menus in the table.
 *
 * @author Alexandre-Gatien Bienfet
 */
export function closeAllDropdowns(): void {
  document.querySelectorAll('.dropdown').forEach((d) => d.classList.add('hidden'));
}
