/* eslint-disable */
// @ts-nocheck
import { api } from './api-client.js';
import { $, $$ } from './dom.js';
import { detectType, docSize, esc, fmtNum, fmtSize, isImageField } from './format.js';
import { openModal, closeModal } from './modals.js';
import { resetDisconnectedState, state } from './state.js';
import { getSqlMutationKind } from './sql-ui.js';

'use strict';

function toast(msg, kind = '', title = '') {
  const div = document.createElement('div');
  div.className = 'toast ' + kind;
  div.innerHTML = (title ? `<strong>${esc(title)}</strong>` : '') + esc(msg);
  $('#toasts').appendChild(div);
  setTimeout(() => div.remove(), 4000);
}

$$('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));

// ─────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  try {
    const [status, settings, embed] = await Promise.all([
      api('/api/status'),
      api('/api/settings'),
      api('/api/embeddings/status').catch(() => state.search.embedStatus),
    ]);
    state.connected = status.connected;
    state.filepath = status.filepath;
    state.geminiKeySet = settings.geminiKeySet;
    state.search.embedStatus = embed;
  } catch (e) {
    toast('Could not reach daemon: ' + e.message, 'err');
  }

  updateConnState();
  if (state.connected) {
    closeModal('modal-connect');
    await loadCollections();
    await loadModel();
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
    $('#cm-disconnect').disabled = false;
    $('#app').classList.remove('disconnected');
  } else {
    ci.classList.remove('ok');
    ct.textContent = 'Disconnected';
    $('#cm-disconnect').disabled = true;
    $('#app').classList.add('disconnected');
  }
}

async function loadCollections() {
  try {
    const { collections } = await api('/api/collections');
    state.collections = collections || [];
    // Pre-load counts in parallel — small ops on each collection.
    await Promise.all(state.collections.map(async (c) => {
      try {
        const { documents } = await api(`/api/documents/${encodeURIComponent(c)}?limit=10000`);
        state.countsByColl[c] = (documents || []).length;
        state.docsByColl[c] = (documents || []).map((d) => JSON.parse(d));
      } catch {
        state.countsByColl[c] = '?';
      }
    }));
  } catch (e) {
    toast('Failed to load collections: ' + e.message, 'err');
  }
}

async function loadModel() {
  try {
    const { model } = await api('/api/conversational/model');
    state.model = model;
  } catch {
    state.model = null;
  }
}

async function seedDemoEmployees() {
  try {
    const result = await api('/api/demo/employees', { method: 'POST' });
    toast(result.message || 'Demo data ready', result.skipped ? '' : 'ok');
    invalidateStorageCache();
    await loadCollections();
    await loadModel();
    if (state.collections.includes('employees')) state.selectedCol = 'employees';
    render();
  } catch (e) {
    toast('Failed to seed demo data: ' + e.message, 'err');
  }
}

// ─────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────
function selectCollection(c) {
  state.selectedCol = c;
  state.tab = 'overview';
  state.dataFilter = '';
  state.selectedDoc = null;
  closeDrawer();
  render();
}
function selectRoot() {
  state.selectedCol = null;
  state.tab = 'overview';
  state.selectedDoc = null;
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
    h += `<div class="empty" style="padding-left:8px;">${filter ? 'No matches.' : 'No collections yet. Use the Query Language tab to insert your first document.'}</div>`;
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
        const docs = state.docsByColl[c] || [];
        const fieldNames = docs.length ? Object.keys(docs[0]).filter((k) => !k.startsWith('_')) : [];
        h += `<div class="tn" style="padding-left:24px;color:var(--t3);"><span class="ch"> </span><span class="ic field">${ICONS.field}</span><span class="name">Fields</span><span class="ct">${fieldNames.length}</span></div>`;
        for (const f of fieldNames) {
          h += `<div class="tn" style="padding-left:40px;color:var(--t2);"><span class="ch"> </span><span class="ic field">${ICONS.field}</span><span class="name">${esc(f)}</span></div>`;
        }
      }
    }
  }
  $('#tree').innerHTML = h;
  $$('#tree [data-c]').forEach((n) => n.addEventListener('click', (e) => {
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
  }));
  $$('#tree [data-del]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmAction(`Drop collection “${b.dataset.del}”?`, 'This permanently removes every document in it.', async () => {
      try {
        await api(`/api/collections/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
        toast(`Dropped “${b.dataset.del}”`, 'ok');
        if (state.selectedCol === b.dataset.del) state.selectedCol = null;
        await loadCollections();
        render();
      } catch (err) { toast(err.message, 'err'); }
    });
  }));
}

function renderTabs() {
  const otabs = $('#otabs');
  const dis = !state.selectedCol;
  otabs.innerHTML = `
    <button class="ot ${state.tab === 'overview' ? 'on' : ''}" data-t="overview"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></span>Overview</button>
    <button class="ot ${state.tab === 'data' ? 'on' : ''}" data-t="data" ${dis ? 'disabled' : ''}><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/></svg></span>Data${state.selectedCol ? `<span class="badge">${(state.docsByColl[state.selectedCol] || []).length}</span>` : ''}</button>
    <button class="ot ${state.tab === 'fields' ? 'on' : ''}" data-t="fields" ${dis ? 'disabled' : ''}><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></span>Fields</button>
    <button class="ot ${state.tab === 'sql' ? 'on' : ''}" data-t="sql"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></span>Query Language</button>
    <button class="ot ${state.tab === 'search' ? 'on' : ''}" data-t="search" ${dis ? 'disabled' : ''}><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4-4"/></svg></span>Semantic Search</button>
    <button class="ot ${state.tab === 'ai' ? 'on' : ''}" data-t="ai"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>AI Chat</button>
    <div class="sp"></div>
    <div class="meta">${state.selectedCol ? `Selected · <strong style="color:var(--ac)">${esc(state.selectedCol)}</strong>` : `Selected · <strong>${esc(state.filepath || '—')}</strong>`}</div>`;
  $$('.ot[data-t]').forEach((b) => b.addEventListener('click', () => {
    if (b.hasAttribute('disabled')) return;
    state.tab = b.dataset.t;
    renderTabs(); renderTab();
  }));
}

function renderTab() {
  if (!state.connected) { $('#cnt').innerHTML = ''; return; }
  if (state.tab === 'overview') renderOverview();
  else if (state.tab === 'data') renderData();
  else if (state.tab === 'fields') renderFields();
  else if (state.tab === 'sql') renderSql();
  else if (state.tab === 'search') renderSemanticSearch();
  else if (state.tab === 'ai') renderAi();
  else { state.tab = 'overview'; renderOverview(); }
}

// ─────────────────────────────────────────────────────────────────
// Overview
// ─────────────────────────────────────────────────────────────────
// Per-collection storage cache for the overview tab. Loaded lazily
// when a collection is opened so we don't pay the cost upfront for
// every collection in the sidebar.
const storageCache = new Map();
async function getCollectionStorage(c) {
  if (storageCache.has(c)) return storageCache.get(c);
  try {
    const s = await api(`/api/collections/${encodeURIComponent(c)}/storage`);
    storageCache.set(c, s);
    return s;
  } catch { return null; }
}
function invalidateStorageCache(c) {
  if (c) storageCache.delete(c);
  else storageCache.clear();
}

function renderOverview() {
  const c = state.selectedCol;
  if (!c) {
    const totalDocs = state.collections.reduce((s, x) => s + (typeof state.countsByColl[x] === 'number' ? state.countsByColl[x] : 0), 0);
    const totalSize = state.collections.reduce((s, x) => s + (state.docsByColl[x] || []).reduce((a, d) => a + docSize(d), 0), 0);
    $('#cnt').innerHTML = `<div class="ov">
      <h1><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg></span><span class="name">${esc(state.filepath || '—')}</span></h1>
      <p class="ovsub"><span><strong>${state.collections.length}</strong> collection${state.collections.length === 1 ? '' : 's'}</span><span><strong>${totalDocs.toLocaleString()}</strong> document${totalDocs === 1 ? '' : 's'}</span><span>JSON ≈ <strong>${fmtSize(totalSize)}</strong></span></p>
      <div class="psec">
        <h3>Collections</h3>
        <div>${state.collections.length === 0 ? `<div class="empty-state"><h4>No collections yet</h4><p>This database is empty. Open the <strong>Query Language</strong> tab and run an <code>INSERT INTO &lt;name&gt; VALUES {"id": "..."}</code> statement, or seed the built-in employee demo data.</p><div style="display:flex;gap:8px;justify-content:center;"><button class="tbtn pri" data-seed-demo>Seed employee demo</button><button class="tbtn" data-open-sql style="border:1px solid var(--bd);background:var(--bg2);">Open Query Language tab</button></div></div>` :
          state.collections.map((x) => {
            const ex = getExplore(x);
            const n = state.countsByColl[x];
            return `<div class="prow" data-root-collection="${esc(x)}" style="grid-template-columns:200px 80px 1fr;cursor:pointer;"><div class="k" style="color:var(--ac);font-family:Consolas,monospace;">${esc(x)}</div><div class="v num" style="text-align:right;">${n === undefined ? '…' : n}</div><div class="v" style="font-family:Segoe UI;color:var(--t2)">${ex && ex.description ? esc(ex.description) : (ex ? esc(ex.label) : '<em style="color:var(--t4);font-style:normal;">—</em>')}</div></div>`;
          }).join('')}</div>
      </div>
    </div>`;
    document.querySelector('[data-open-sql]')?.addEventListener('click', () => {
      state.tab = 'sql';
      renderTabs();
      renderTab();
    });
    document.querySelector('[data-seed-demo]')?.addEventListener('click', seedDemoEmployees);
    $$('[data-root-collection]').forEach((row) => row.addEventListener('click', () => {
      selectCollection(row.dataset.rootCollection);
    }));
    return;
  }

  const docs = state.docsByColl[c] || [];
  const fields = docs.length ? Object.keys(docs[0]).filter((k) => !k.startsWith('_')) : [];
  const totalSize = docs.reduce((s, d) => s + docSize(d), 0);
  const explore = getExplore(c);

  $('#cnt').innerHTML = `<div class="ov">
    <div class="crumb"><a id="ov-back">All collections</a> ›</div>
    <h1><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/></svg></span><span class="name">${esc(c)}</span></h1>
    ${explore && explore.description ? `<p class="ovdesc">${esc(explore.description)}</p>` : ''}
    <p class="ovsub"><span><strong>${docs.length}</strong> document${docs.length === 1 ? '' : 's'}</span><span><strong>${fields.length}</strong> field${fields.length === 1 ? '' : 's'}</span><span>JSON ≈ <strong>${fmtSize(totalSize)}</strong></span></p>
    <div class="kpis">
      <div class="kpi" title="Number of documents currently loaded in the client cache for this collection."><div class="l"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg>Documents</div><div class="v">${docs.length}</div><div class="d">${docs.length > 0 ? `${fields.length} fields detected` : 'empty collection'}</div></div>
      <div class="kpi" title="Sum of JSON.stringify byte lengths for client-side display. Not what's on disk."><div class="l">JSON size</div><div class="v">${fmtSize(totalSize).replace(/^([\d.]+)\s*/, (_, n) => `${n} <small>`)}${fmtSize(totalSize).endsWith('B') ? '</small>' : '</small>'}</div><div class="d">avg ${fmtSize(docs.length ? totalSize / docs.length : 0)}/doc</div></div>
      <div class="kpi" id="kpi-stored" title="Loading on-disk storage info…"><div class="l">Stored size</div><div class="v" style="font-size:14px;color:var(--t3);">loading…</div><div class="d">on-disk reservation</div></div>
    </div>
    <div class="psec"><h3>General</h3><div>
      <div class="prow"><div class="k">Name</div><div class="v id">${esc(c)}</div></div>
      <div class="prow"><div class="k">Document count</div><div class="v num">${docs.length}</div></div>
      <div class="prow"><div class="k">Field count (introspected)</div><div class="v num">${fields.length}</div></div>
    </div></div>
    <div class="psec"><h3>Storage breakdown</h3><div id="ov-storage"><div style="padding:16px;color:var(--t3);font-size:12px;">Loading…</div></div></div>
  </div>`;
  $('#ov-back')?.addEventListener('click', selectRoot);
  (async () => {
    const s = await getCollectionStorage(c);
    if (state.selectedCol !== c) return;
    const stored = s ? s.recordBytes : null;
    const kpi = $('#kpi-stored');
    if (kpi) {
      if (stored == null) {
        kpi.querySelector('.v').innerHTML = `<small style="color:var(--t3)">unavailable</small>`;
      } else {
        const f = fmtSize(stored);
        kpi.querySelector('.v').innerHTML = f.replace(/^([\d.]+)\s*/, (_, n) => `${n} <small>`) + (f.endsWith('B') ? '</small>' : '</small>');
        kpi.querySelector('.d').textContent = `avg ${fmtSize(docs.length ? stored / docs.length : 0)}/doc`;
        kpi.title = s.notes.records;
      }
    }
    const host = $('#ov-storage');
    if (host && s) {
      host.innerHTML = `
        <div class="prow" title="${esc(s.notes.records)}"><div class="k">Records<span style="color:var(--t4);margin-left:6px;font-weight:400;">ⓘ</span></div><div class="v num">${fmtSize(s.recordBytes)} <small style="color:var(--t3);font-family:Segoe UI">(${s.documentCount} doc${s.documentCount === 1 ? '' : 's'} × ${s.blockSize} B per block)</small></div></div>
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
  try {
    const { documents } = await api(`/api/documents/${encodeURIComponent(c)}?limit=10000`);
    const parsed = (documents || []).map((d) => JSON.parse(d));
    state.docsByColl[c] = parsed;
    state.countsByColl[c] = parsed.length;
  } catch (e) { toast('Reload failed: ' + e.message, 'err'); }
}

function renderData() {
  const c = state.selectedCol;
  const allDocs = state.docsByColl[c] || [];
  const filter = (state.dataFilter || '').trim().toLowerCase();
  const docs = filter
    ? allDocs.filter((d) => Object.values(d).some((v) => v != null && String(v).toLowerCase().includes(filter)))
    : allDocs;
  const keys = allDocs.length ? Object.keys(allDocs[0]).filter((k) => !k.startsWith('_')) : [];
  $('#cnt').innerHTML = `<div style="display:flex;flex-direction:column;height:100%;">
    <div class="dt-bar">
      <div class="dt-search">
        <div class="w">
          <svg class="si" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4-4"/></svg>
          <input id="dt-filter" placeholder="Filter rows…" value="${esc(state.dataFilter || '')}"/>
          ${filter ? `<button class="clear" id="dt-filter-clear" title="Clear">✕</button>` : ''}
        </div>
      </div>
      <button class="tbtn" id="dt-refresh" title="Reload from server"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v9h-9"/></svg>Reload</button>
      <div class="dt-meta">${filter ? `<span><strong>${docs.length}</strong> of <strong>${allDocs.length}</strong> row${allDocs.length === 1 ? '' : 's'}</span>` : `<span><strong>${allDocs.length}</strong> row${allDocs.length === 1 ? '' : 's'}</span>`}</div>
    </div>
    <div class="tw" id="dg-host"></div>
  </div>`;
  renderDataGrid(docs, keys);
  $('#dt-refresh').addEventListener('click', async () => { await refreshDocs(c); render(); });
  const filterEl = $('#dt-filter');
  let filterTimer = null;
  filterEl.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      state.dataFilter = filterEl.value;
      renderData();
      const newEl = $('#dt-filter');
      if (newEl) { newEl.focus(); newEl.setSelectionRange(filterEl.value.length, filterEl.value.length); }
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
  const unionKeys = Array.from(new Set(docs.flatMap((d) => Object.keys(d)))).filter((k) => !k.startsWith('_') && k !== 'body');
  const sample = (k) => {
    for (const d of docs) if (d[k] != null) return d[k];
    return null;
  };
  // Type badges: dim grey lowercase monospace, no badge for unknown/null-only columns.
  const typeBadge = (v) => v == null ? '' : typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : typeof v === 'string' ? 's' : '';
  $('#dg-host').innerHTML = `<table class="dg">
    <thead><tr><th class="rn">#</th>${unionKeys.map((k) => {
      const tb = k === 'id' ? 'pk' : typeBadge(sample(k));
      return `<th><div class="ti">${esc(k)}${tb ? `<span class="tb ${tb === 'pk' ? 'pk' : ''}">${tb}</span>` : ''}</div></th>`;
    }).join('')}</tr></thead>
    <tbody>${docs.map((d, i) => {
      const isOn = state.selectedDoc && d.id === state.selectedDoc.id;
      return `<tr data-i="${i}" data-id="${esc(d.id)}" ${isOn ? 'class="on"' : ''}><td class="rn">${i + 1}</td>${unionKeys.map((k) => {
        const v = d[k];
        if (v === undefined || v === null) return `<td class="cnu">[NULL]</td>`;
        if (typeof v === 'number') return `<td class="cn">${fmtNum(v)}</td>`;
        if (typeof v === 'boolean') return `<td class="cb ${v ? 't' : 'f'}">${v}</td>`;
        if (k === 'id') return `<td class="ck">${esc(v)}</td>`;
        if (isImageField(k) && typeof v === 'string' && v.startsWith('data:')) return `<td class="ci"><img src="${v}" alt=""></td>`;
        return `<td class="cs">${esc(String(v))}</td>`;
      }).join('')}</tr>`;
    }).join('')}</tbody>
  </table>`;
  $$('.dg tbody tr').forEach((tr) => tr.addEventListener('click', () => openDrawer(docs[parseInt(tr.dataset.i, 10)], parseInt(tr.dataset.i, 10))));
}

function openDrawer(doc, idx) {
  state.selectedDoc = doc;
  state.selectedDocIndex = idx;
  renderDrawer();
  $('#drawer').classList.add('on');
  $$('.dg tbody tr').forEach((tr) => tr.classList.remove('on'));
  $$(`.dg tbody tr[data-i="${idx}"]`).forEach((tr) => tr.classList.add('on'));
}
function closeDrawer() { $('#drawer').classList.remove('on'); state.selectedDoc = null; }
$('#dr-close').addEventListener('click', closeDrawer);

async function renderDrawer() {
  const d = state.selectedDoc; if (!d) return;
  $('#dr-title').textContent = String(d.id ?? '(no id)');
  const c = state.selectedCol;
  let meta = null;
  try { meta = await api(`/api/documents/${encodeURIComponent(c)}/${encodeURIComponent(String(d.id))}/metadata`); }
  catch { meta = null; }
  const keys = Object.keys(d).filter((k) => !k.startsWith('_'));
  const compsText = meta && meta.compressions && Object.keys(meta.compressions).length > 0
    ? Object.entries(meta.compressions).map(([k, v]) => `${esc(k)}: <em style="font-style:normal;color:var(--ac)">${esc(v)}</em>`).join(', ')
    : '<em style="color:var(--t3);">none</em>';
  const jsonSizeTip = 'Document size as JSON for client-side display. Computed from the in-memory object.';
  const storedSizeTip = meta ? `Physical disk reservation walked from the document's block chain: chainLength × blockSize (${meta.blockSize} bytes). Excludes shared index entries.` : '';
  $('#dr-body').innerHTML = `
    <div class="dr-stats">
      <div class="dr-stat" title="${esc(jsonSizeTip)}"><div class="l">JSON size</div><div class="v">${fmtSize(docSize(d))}</div></div>
      <div class="dr-stat" title="${esc(storedSizeTip)}"><div class="l">Stored size</div><div class="v">${meta ? `${fmtSize(meta.storedSize)} <small>on disk</small>` : '<small>—</small>'}</div></div>
    </div>
    <div class="prow" style="grid-template-columns:130px 1fr;padding:7px 0;border:none;font-size:12px"><div class="k">Compression</div><div class="v" style="font-family:Consolas;color:var(--t2)">${compsText}</div></div>
    <div style="margin-top:14px;font-size:10.5px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Fields</div>
    ${keys.map((k) => {
      const v = d[k];
      let cls = 'cs', html;
      if (v == null) { cls = 'nu'; html = '[NULL]'; }
      else if (typeof v === 'number') { cls = 'num'; html = fmtNum(v); }
      else if (typeof v === 'boolean') { cls = 'bool'; html = String(v); }
      else if (k === 'id') { cls = 'id'; html = esc(v); }
      else if (isImageField(k) && typeof v === 'string' && v.startsWith('data:')) { cls = 'img'; html = `<img src="${v}" alt="">`; }
      else { html = `<span data-edit="${esc(k)}">${esc(String(v))}</span>`; }
      return `<div class="fld-row" data-k="${esc(k)}"><div class="k">${esc(k)}</div><div class="v ${cls}">${html}</div></div>`;
    }).join('')}
  `;
}

$('#dr-edit').addEventListener('click', () => {
  const d = state.selectedDoc; if (!d) return;
  const c = state.selectedCol;
  const cleanDoc = Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith('_')));
  const jsonStr = JSON.stringify(cleanDoc, null, 2);
  $('#dr-body').innerHTML = `
    <div class="dr-stats"><div class="dr-stat" style="grid-column:1/-1;"><div class="l">Editing</div><div class="v" style="font-size:13px;font-family:Consolas;color:var(--ac);">${esc(d.id)}</div></div></div>
    <div style="font-size:11px;color:var(--t3);margin-bottom:6px;line-height:1.4;">Edit as JSON. Strings need quotes; numbers and booleans don't. The <code style="font-size:11px;background:var(--bg);padding:0 4px;border-radius:2px;">id</code> field is read-only and must not change.</div>
    <textarea id="dr-edit-json" spellcheck="false" style="width:100%;min-height:320px;padding:9px 11px;font-family:Consolas,monospace;font-size:12px;line-height:1.5;border:1px solid var(--bd);border-radius:3px;background:var(--bg2);resize:vertical;">${esc(jsonStr)}</textarea>
    <div class="err hidden" id="dr-edit-err" style="margin-top:8px;padding:7px 10px;background:var(--rdb);color:var(--rd);border-radius:3px;font-size:11.5px;font-family:Consolas,monospace;white-space:pre-wrap;"></div>
    <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">
      <button class="tbtn sec" id="edit-cancel" style="border:1px solid var(--bd);background:var(--bg2);">Cancel</button>
      <button class="tbtn pri" id="edit-save">Save</button>
    </div>
  `;
  $('#edit-cancel').addEventListener('click', () => renderDrawer());
  $('#edit-save').addEventListener('click', async () => {
    const errEl = $('#dr-edit-err');
    errEl.classList.add('hidden');
    let parsed;
    try { parsed = JSON.parse($('#dr-edit-json').value); }
    catch (e) { errEl.classList.remove('hidden'); errEl.textContent = 'Invalid JSON: ' + e.message; return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errEl.classList.remove('hidden'); errEl.textContent = 'Top-level must be a JSON object.'; return;
    }
    if (String(parsed.id) !== String(d.id)) {
      errEl.classList.remove('hidden'); errEl.textContent = `The "id" field is read-only — must remain ${JSON.stringify(d.id)}.`; return;
    }
    if (JSON.stringify(parsed) === JSON.stringify(cleanDoc)) {
      toast('No changes.', 'warn'); renderDrawer(); return;
    }
    try {
      await api(`/api/documents/${encodeURIComponent(c)}/${encodeURIComponent(String(d.id))}/edit`, { method: 'POST', body: { document: parsed } });
      toast('Document updated', 'ok');
      invalidateStorageCache(c);
      await refreshDocs(c);
      const refreshed = (state.docsByColl[c] || []).find((x) => String(x.id) === String(d.id));
      if (refreshed) { state.selectedDoc = refreshed; renderDrawer(); }
      renderData();
    } catch (e) {
      errEl.classList.remove('hidden');
      errEl.textContent = 'Save failed: ' + e.message;
    }
  });
});

$('#dr-del').addEventListener('click', () => {
  const d = state.selectedDoc; if (!d) return;
  confirmAction(`Delete document “${d.id}”?`, 'This cannot be undone.', async () => {
    try {
      await api(`/api/documents/${encodeURIComponent(state.selectedCol)}/${encodeURIComponent(String(d.id))}`, { method: 'DELETE' });
      toast('Document deleted', 'ok');
      closeDrawer();
      invalidateStorageCache(state.selectedCol);
      await refreshDocs(state.selectedCol);
      render();
    } catch (e) { toast('Delete failed: ' + e.message, 'err'); }
  });
});

// ─────────────────────────────────────────────────────────────────
// Fields
// ─────────────────────────────────────────────────────────────────
function renderFields() {
  const c = state.selectedCol;
  const docs = state.docsByColl[c] || [];
  if (docs.length === 0) {
    $('#cnt').innerHTML = `<div class="flds"><div class="empty-state"><h4>No documents to introspect</h4><p>Insert a document to see what fields exist and their types.</p></div></div>`;
    return;
  }
  const explore = getExplore(c);
  const explored = new Map((explore?.fields || []).map((f) => [f.name, f]));
  const fieldKeys = Array.from(new Set(docs.flatMap((d) => Object.keys(d)))).filter((k) => !k.startsWith('_'));
  const rows = fieldKeys.map((k) => {
    const presentCount = docs.reduce((n, d) => n + (d[k] != null ? 1 : 0), 0);
    const sample = docs.find((d) => d[k] != null)?.[k];
    const t = detectType(sample);
    const m = explored.get(k);
    const sampleStr = sample == null ? '—' : typeof sample === 'string' ? `"${sample.slice(0, 60)}"` : typeof sample === 'object' ? JSON.stringify(sample).slice(0, 60) : String(sample);
    const covLabel = presentCount === docs.length ? `${docs.length} / ${docs.length}` : `${presentCount} / ${docs.length}`;
    const covCls = presentCount === docs.length ? '' : 'partial';
    const hasDesc = !!(m && m.description);
    return `<div class="fr ${hasDesc ? 'has-desc' : ''}">
      <div class="r">
        <div class="nm">${esc(k)}${k === 'id' ? '<span class="pk">PK</span>' : ''}</div>
        <div class="ty">${t}</div>
        <div class="cov ${covCls}">${covLabel}</div>
        <div class="sm">${esc(sampleStr)}</div>
      </div>
      ${hasDesc ? `<div class="desc">${esc(m.description)}</div>` : ''}
    </div>`;
  }).join('');
  $('#cnt').innerHTML = `<div class="flds">
    <h2>Fields<span class="ct">${fieldKeys.length} field${fieldKeys.length === 1 ? '' : 's'} · ${docs.length} document${docs.length === 1 ? '' : 's'}</span></h2>
    <div class="flds-table">
      <div class="h"><div>Name</div><div>Type</div><div>Coverage</div><div>Sample</div></div>
      ${rows}
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────
// Schema model (modal opened from AI Chat header)
// ─────────────────────────────────────────────────────────────────
function openModelModal() {
  const jsonStr = state.model ? JSON.stringify(state.model, null, 2) : '';
  $('#mdl-json').value = jsonStr;
  $('#mdl-err').classList.add('hidden');
  $('#mdl-status').textContent = state.model
    ? `${state.model.explores.length} explore${state.model.explores.length === 1 ? '' : 's'} · ${state.model.explores.reduce((s, e) => s + e.fields.length, 0)} fields total`
    : 'No model loaded';
  openModal('modal-model');
}

async function generateModel() {
  state.modelGenerating = true;
  if (state.tab === 'ai') renderAi();
  if (state.geminiKeySet) {
    toast('Generating schema model… this may take ~20s', '', 'Generating');
  } else {
    toast('No Gemini key — generating a basic introspected model (no descriptions/synonyms). Set a key later to enrich it.', 'warn', 'Generating');
  }
  try {
    const { model, enriched } = await api('/api/conversational/model/generate', { method: 'POST' });
    state.model = model;
    if (state.selectedCol) state.modelPromptDismissed[state.selectedCol] = false;
    if (enriched) toast('Schema model generated and enriched.', 'ok');
    else toast('Basic schema model generated. Descriptions/synonyms not added — set a Gemini key to enrich.', 'warn');
  } catch (e) {
    await loadModel();
    toast('Generation failed: ' + e.message, 'err');
  }
  finally {
    await loadModel();
    state.modelGenerating = false;
    render();
  }
}
// Wire the model modal once at startup (the buttons live in a fixed
// modal, not inside the tab content, so they're registered just once).
$('#mdl-gen').addEventListener('click', generateModel);
$('#mdl-save').addEventListener('click', async () => {
  const raw = $('#mdl-json').value;
  try { JSON.parse(raw); }
  catch (e) { $('#mdl-err').classList.remove('hidden'); $('#mdl-err').textContent = 'Invalid JSON: ' + e.message; return; }
  $('#mdl-err').classList.add('hidden');
  try {
    const { model } = await api('/api/conversational/model', { method: 'PUT', body: { model: raw } });
    state.model = model;
    toast('Model saved', 'ok');
    closeModal('modal-model');
    render();
  } catch (e) { $('#mdl-err').classList.remove('hidden'); $('#mdl-err').textContent = e.message; }
});
$('#mdl-reload').addEventListener('click', async () => {
  await loadModel();
  $('#mdl-json').value = state.model ? JSON.stringify(state.model, null, 2) : '';
  toast('Model reloaded', 'ok');
});

// ─────────────────────────────────────────────────────────────────
// SQL
// ─────────────────────────────────────────────────────────────────
let pendingSql = '';

function renderSql() {
  const last = state.sqlHistory[0];
  $('#cnt').innerHTML = `<div class="sql-pane">
    <div class="sql-tools">
      <button class="tbtn pri" id="sql-run"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>Run (⌘↩)</button>
      <button class="tbtn" id="sql-clear"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>Clear</button>
      <button class="tbtn" id="sql-example">Example: SELECT</button>
      ${state.selectedCol ? `<button class="tbtn" id="sql-prefill">SELECT * FROM ${esc(state.selectedCol)}</button>` : ''}
      <div class="meta">
        ${last ? last.ok
          ? `<span><strong>${last.rowCount}</strong> row${last.rowCount === 1 ? '' : 's'}</span><span class="ok-pill">${esc(last.kind)} · ${last.elapsedMs} ms</span>`
          : `<span class="err-pill">error</span>`
        : `<span style="color:var(--t4);font-style:italic;">no query run yet</span>`}
      </div>
    </div>
    <div class="sql-editor" id="sql-edit" contenteditable="true" spellcheck="false">${pendingSql ? esc(pendingSql) : ''}</div>
    <div class="sql-results" id="sql-out">${renderSqlOut(last)}${renderSqlHistory()}</div>
  </div>`;
  const editor = $('#sql-edit');
  editor.addEventListener('input', () => { pendingSql = editor.innerText; });
  editor.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runSql(); }
  });
  $('#sql-run').addEventListener('click', runSql);
  $('#sql-clear').addEventListener('click', () => { pendingSql = ''; editor.innerText = ''; });
  $('#sql-example').addEventListener('click', () => { const ex = state.selectedCol ? `SELECT *\n  FROM ${state.selectedCol}\n LIMIT 25;` : 'SELECT *\n  FROM <collection>\n LIMIT 25;'; pendingSql = ex; editor.innerText = pendingSql; });
  if (state.selectedCol) {
    $('#sql-prefill').addEventListener('click', () => { pendingSql = `SELECT * FROM ${state.selectedCol} LIMIT 100;`; editor.innerText = pendingSql; });
  }
  if (pendingSql) editor.innerText = pendingSql;
  $$('#sql-out .item').forEach((el) => el.addEventListener('click', () => {
    pendingSql = el.dataset.sql; editor.innerText = pendingSql;
  }));
}

async function runSql() {
  const sql = pendingSql.trim();
  if (!sql) { toast('Type a query first.', 'warn'); return; }
  const kind = getSqlMutationKind(sql);
  if (kind) {
    await new Promise((resolve) => {
      confirmAction(`Run a ${kind} statement?`, `${kind} statements modify the database. Continue?`, () => { runSqlNow(sql); resolve(); });
    });
    return;
  }
  await runSqlNow(sql);
}
async function runSqlNow(sql) {
  try {
    const result = await api('/api/query', { method: 'POST', body: { sql } });
    state.sqlHistory.unshift({ sql, ok: true, ts: Date.now(), rowCount: result.rowCount, elapsedMs: result.elapsedMs, kind: result.kind, rows: result.rows });
    state.sqlHistory = state.sqlHistory.slice(0, 10);
    if (result.kind !== 'select') {
      toast(`${result.kind.toUpperCase()} ok`, 'ok');
      invalidateStorageCache();
      const m = sql.match(/(?:from|into)\s+([A-Za-z_][A-Za-z0-9_]*)/i);
      if (m) await refreshDocs(m[1]);
    }
    renderSql();
  } catch (e) {
    state.sqlHistory.unshift({ sql, ok: false, ts: Date.now(), error: e.message });
    state.sqlHistory = state.sqlHistory.slice(0, 10);
    renderSql();
  }
}

function renderSqlOut(last) {
  if (!last) return '';
  if (!last.ok) return `<div class="err">${esc(last.error)}</div>`;
  if (last.kind !== 'select') return `<div class="rhead"><span class="ok-pill">${esc(last.kind)}</span><strong>${last.rowCount}</strong> row${last.rowCount === 1 ? '' : 's'} affected · ${last.elapsedMs} ms</div>`;
  const rows = last.rows || [];
  if (rows.length === 0) return `<div class="rhead"><strong>0</strong> rows · ${last.elapsedMs} ms</div><div style="padding:20px;text-align:center;color:var(--t3);font-size:12px;">No rows returned.</div>`;
  const cols = Object.keys(rows[0]);
  return `<div class="rhead"><strong>${last.rowCount}</strong> row${last.rowCount === 1 ? '' : 's'} · <span class="pill">${esc(last.kind)}</span> · <span class="pill">${last.elapsedMs} ms</span></div>
  <table class="dg"><thead><tr><th class="rn">#</th>${cols.map((c) => {
    const v = rows[0][c];
    const tb = c === 'id' ? 'pk' : (typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : typeof v === 'string' ? 's' : '');
    return `<th><div class="ti">${esc(c)}${tb ? `<span class="tb ${tb === 'pk' ? 'pk' : ''}">${tb}</span>` : ''}</div></th>`;
  }).join('')}</tr></thead>
  <tbody>${rows.map((r, i) => `<tr><td class="rn">${i + 1}</td>${cols.map((c) => { const v = r[c]; if (v == null) return '<td class="cnu">[NULL]</td>'; if (typeof v === 'number') return `<td class="cn">${fmtNum(v)}</td>`; return `<td class="cs">${esc(String(v))}</td>`; }).join('')}</tr>`).join('')}</tbody></table>`;
}
function renderSqlHistory() {
  if (state.sqlHistory.length <= 1) return '';
  return `<div class="sql-history"><h4>History</h4>${state.sqlHistory.slice(1).map((h) => `<div class="item" data-sql="${esc(h.sql)}"><span class="${h.ok ? 'ok' : 'ko'}">${h.ok ? 'OK' : 'ERR'}</span><span class="qq">${esc(h.sql.replace(/\s+/g, ' '))}</span><span class="when">${h.ok ? `${h.rowCount} rows · ${h.elapsedMs}ms` : 'error'}</span></div>`).join('')}</div>`;
}

// ─────────────────────────────────────────────────────────────────
// Semantic Search
// ─────────────────────────────────────────────────────────────────
async function pollEmbedStatus() {
  try {
    const s = await api('/api/embeddings/status');
    state.search.embedStatus = s;
  } catch { /* leave previous status */ }
}

function embedStatusPill() {
  const s = state.search.embedStatus.state;
  if (s === 'ready') return { cls: 'ok', label: 'Embedding model · ready' };
  if (s === 'loading') return { cls: 'warn', label: 'Embedding model · loading…' };
  if (s === 'error') return { cls: 'bad', label: 'Embedding model · error' };
  return { cls: '', label: 'Embedding model · not started' };
}

function renderSemanticSearch() {
  const c = state.selectedCol;
  const s = state.search;
  const pill = embedStatusPill();

  // The CLIP model loads lazily on first query; we don't preload on
  // tab open because the user might just be browsing. We refresh
  // status when they actually run a query.
  $('#cnt').innerHTML = `<div class="ss">
    <div class="ss-head">
      <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4-4"/></svg></div>
      <div class="ttl"><strong>Semantic search</strong><span class="sub">Find documents by meaning. Powered by CLIP — accepts text, an image, or both.</span></div>
      <div class="meta"><span class="dot ${pill.cls}" title="CLIP model state. Loads on the first query and stays warm afterwards."><strong>${esc(pill.label.split(' · ')[0])}</strong>${esc(pill.label.split(' · ')[1] || '')}</span></div>
    </div>
    <div class="ss-bar">
      <input type="text" id="ss-q" placeholder="${c ? 'Describe what you are looking for…' : 'Select a collection in the sidebar first…'}" value="${esc(s.query)}" ${c ? '' : 'disabled'}/>
      <label class="attach ${s.image ? 'has-image' : ''}" title="Attach an image to search visually">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>
        ${s.image ? esc(s.image.name) : 'Attach image'}
        <input type="file" id="ss-img" accept="image/*" style="display:none;" ${c ? '' : 'disabled'}/>
      </label>
      ${s.image ? `<span class="clear-img" id="ss-img-clear" title="Remove attached image">✕</span>` : ''}
      <button class="go" id="ss-go" ${c && !s.busy ? '' : 'disabled'}>Search</button>
    </div>
    <div class="ss-status">
      ${s.image ? `<span class="preview"><img src="${esc(s.image.dataUrl)}" alt=""/> using image embedding</span>` : ''}
      ${!s.image && s.query ? `<span>using text embedding</span>` : ''}
      ${s.elapsedMs != null ? `<span>· ${s.elapsedMs} ms</span>` : ''}
      ${s.results ? `<span>· ${s.results.length} result${s.results.length === 1 ? '' : 's'}</span>` : ''}
    </div>
    <div class="ss-body" id="ss-body">${renderSemanticSearchBody(c, s)}</div>
  </div>`;

  $('#ss-q')?.addEventListener('input', (e) => { state.search.query = e.target.value; });
  $('#ss-q')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !state.search.busy) runSemanticSearch(); });
  $('#ss-go')?.addEventListener('click', () => { if (!state.search.busy) runSemanticSearch(); });
  $('#ss-img')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const dataUrl = await readFileDataUrl(f);
    const b64 = dataUrl.split(',', 2)[1] || '';
    state.search.image = { name: f.name, dataUrl, buffer: b64 };
    renderSemanticSearch();
  });
  $('#ss-img-clear')?.addEventListener('click', () => {
    state.search.image = null;
    renderSemanticSearch();
  });
  $$('#ss-body [data-idx]').forEach((el) => el.addEventListener('click', () => {
    const i = parseInt(el.dataset.idx, 10);
    const doc = state.search.results && state.search.results[i];
    if (!doc) return;
    try { openDrawer(JSON.parse(doc), i); } catch { /* invalid json */ }
  }));
}

function renderSemanticSearchBody(c, s) {
  if (!c) {
    return `<div class="ss-empty"><h4>Pick a collection to search</h4><p>Semantic search ranks documents in the selected collection by similarity to your query. The first search of a session loads the CLIP model and may take 10–20 seconds; subsequent searches are fast.</p></div>`;
  }
  if (s.busy) {
    return `<div class="ss-loading"><span class="spin"></span>${state.search.embedStatus.state === 'loading' ? 'Loading CLIP model…' : 'Searching…'}</div>`;
  }
  if (s.error) {
    return `<div class="ss-empty"><h4>Search failed</h4><p style="color:var(--rd)">${esc(s.error)}</p></div>`;
  }
  if (!s.results) {
    return `<div class="ss-empty"><h4>Ready when you are</h4><p>Type a query and press Search. You can also attach an image to find visually similar records (works on collections where image fields were indexed).</p></div>`;
  }
  if (s.results.length === 0) {
    return `<div class="ss-empty"><h4>No results</h4><p>The collection doesn't have any documents that semantically match. Try broader keywords or a different image.</p></div>`;
  }
  const rows = s.results.map(parseSemanticResult);
  const cols = semanticResultColumns(rows);
  if (cols.length === 0) cols.push('result');
  return `<div class="sql-results ss-table">
    <div class="rhead"><strong>${s.results.length}</strong> result${s.results.length === 1 ? '' : 's'} · <span class="pill">semantic</span></div>
    <table class="dg"><thead><tr><th class="rn">#</th>${cols.map((c) => {
      const sample = rows.find((r) => r[c] != null)?.[c];
      const type = c === 'id' ? 'pk' : semanticTypeBadge(sample);
      return `<th><div class="ti">${esc(c)}${type ? `<span class="tb ${type === 'pk' ? 'pk' : ''}">${type}</span>` : ''}</div></th>`;
    }).join('')}</tr></thead>
    <tbody>${rows.map((r, i) => `<tr data-idx="${i}" title="Open document"><td class="rn">${i + 1}</td>${cols.map((c) => renderSemanticCell(r[c])).join('')}</tr>`).join('')}</tbody></table>
  </div>`;
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

function semanticResultColumns(rows) {
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

function renderSemanticCell(value) {
  if (value == null) return '<td class="cnu">[NULL]</td>';
  if (typeof value === 'number') return `<td class="cn">${fmtNum(value)}</td>`;
  if (typeof value === 'boolean') return `<td class="cb">${value ? 'true' : 'false'}</td>`;
  if (typeof value === 'object') return `<td class="ck">${esc(JSON.stringify(value))}</td>`;
  return `<td class="cs">${esc(String(value))}</td>`;
}

function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = reject;
    r.onload = () => resolve(r.result);
    r.readAsDataURL(file);
  });
}

async function runSemanticSearch() {
  const c = state.selectedCol;
  const s = state.search;
  if (!c) return;
  if (!s.query.trim() && !s.image) {
    s.error = 'Type a query or attach an image first.';
    renderSemanticSearch();
    return;
  }
  s.busy = true;
  s.error = null;
  s.results = null;
  s.elapsedMs = null;
  // Kick off the CLIP load (no-op if already in flight) so the status
  // pill reflects what's actually happening.
  void api('/api/embeddings/preload', { method: 'POST' }).catch(() => undefined);
  renderSemanticSearch();
  // Poll status while busy so the pill animates from "loading" to "ready".
  const statusTimer = setInterval(async () => {
    await pollEmbedStatus();
    if (state.tab === 'search') renderSemanticSearch();
  }, 1500);
  const t0 = performance.now();
  try {
    let resp;
    if (s.image) {
      resp = await api(`/api/documents/${encodeURIComponent(c)}/search/image?limit=20`, {
        method: 'POST',
        body: { image: s.image.buffer },
      });
    } else {
      const q = encodeURIComponent(s.query.trim());
      resp = await api(`/api/documents/${encodeURIComponent(c)}/search?q=${q}&limit=20`);
    }
    s.results = Array.isArray(resp.documents) ? resp.documents : [];
    s.elapsedMs = Math.round(performance.now() - t0);
  } catch (err) {
    s.error = err.message || String(err);
  } finally {
    clearInterval(statusTimer);
    s.busy = false;
    await pollEmbedStatus();
    if (state.tab === 'search') renderSemanticSearch();
  }
}

// ─────────────────────────────────────────────────────────────────
// AI Chat
// ─────────────────────────────────────────────────────────────────
let aiBusy = false;

function renderAi() {
  const c = state.selectedCol;
  const exploreForCol = c ? getExplore(c) : null;
  // The collection needs a schema-model entry to chat. If the user
  // hasn't already dismissed the prompt, we show a Y/N card. If they
  // dismissed it, the chat stays disabled until they generate one.
  const needsModelForCol = !!c && !exploreForCol && !state.modelGenerating;
  const promptForCol = needsModelForCol && !state.modelPromptDismissed[c];

  const schemaReady = !!state.model && !!exploreForCol && !state.modelGenerating;
  const canChat = state.geminiKeySet && schemaReady;
  const empty = state.chatHistory.length === 0;

  $('#cnt').innerHTML = `<div class="ai-pane">
    <div class="ai-head">
      <div class="ic">AI</div>
      <div class="ttl"><strong>Conversational analytics</strong><div class="sub">Context: <strong style="color:var(--ac)">${esc(c || '—')}</strong></div></div>
      <div class="meta">
        <span class="dot ${state.geminiKeySet ? 'ok' : 'bad'}" title="${state.geminiKeySet ? 'A Gemini API key is configured. Validity is verified on first chat.' : 'No Gemini API key configured.'}"><strong>LLM</strong>${state.geminiKeySet ? 'key set' : 'no key'}</span>
        <span class="dot ${exploreForCol ? 'ok' : 'warn'}" title="${exploreForCol ? 'Schema model loaded for this collection.' : 'No schema model defined for this collection yet.'}"><strong>Schema</strong>${exploreForCol ? 'ready' : (c ? 'missing' : '—')}</span>
        <button class="tbtn" id="ai-model" title="View or edit the schema model JSON" style="padding:4px 10px;font-size:11px;border:1px solid var(--bd);background:var(--bg2);">Edit schema model</button>
        <button class="tbtn" id="ai-clear" style="padding:4px 10px;font-size:11px;">Clear chat</button>
      </div>
    </div>
    <div class="ai-body" id="ai-body">${
      state.modelGenerating ? renderModelGeneratingCard(c)
      : promptForCol ? renderModelPromptCard(c)
      : empty ? renderAiEmpty(c, exploreForCol)
      : state.chatHistory.map((m, i) => renderAiMessage(m, i)).join('')
    }</div>
    <div class="ai-input">
      <input id="ai-q" placeholder="${
        schemaReady && !state.geminiKeySet ? 'Schema ready — configure Gemini API key to chat…'
        : !state.geminiKeySet ? 'Configure Gemini API key first…'
        : !c ? 'Select a collection in the sidebar…'
        : !exploreForCol ? 'Generate a schema model for this collection first…'
        : state.modelGenerating ? 'Generating schema model…'
        : 'Ask about your data…'
      }" ${canChat ? '' : 'disabled'}/>
      <button id="ai-send" ${canChat ? '' : 'disabled'}>Send</button>
    </div>
  </div>`;
  $('#ai-clear').addEventListener('click', () => { state.chatHistory = []; renderAi(); });
  $('#ai-model').addEventListener('click', openModelModal);
  $('#ai-q')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !aiBusy) sendChat(); });
  $('#ai-send')?.addEventListener('click', () => { if (!aiBusy) sendChat(); });
  $$('#ai-body .example').forEach((b) => b.addEventListener('click', () => { $('#ai-q').value = b.dataset.q; sendChat(); }));
  $$('#ai-body .chip').forEach((b) => b.addEventListener('click', () => { $('#ai-q').value = b.dataset.q; sendChat(); }));
  $$('#ai-body .didyou li').forEach((li) => li.addEventListener('click', () => { $('#ai-q').value = li.textContent; sendChat(); }));
  $$('#ai-body .open-sql').forEach((b) => b.addEventListener('click', () => {
    pendingSql = b.dataset.sql;
    state.tab = 'sql';
    renderTabs(); renderTab();
  }));
  $$('#ai-body .qch canvas').forEach((cv) => {
    const spec = JSON.parse(cv.dataset.chart);
    drawChart(cv, spec.chart, spec.data);
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
    ? `<p style="font-size:11.5px;color:var(--t3);margin-top:6px;">Generation runs against <strong>data.db</strong>, samples a few documents per collection, then asks Gemini to add field descriptions and synonyms. Takes ~20s.</p>`
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
  if (m.thinking) return `<div class="msg a"><div class="who">AI</div><div class="bub thinking"><span class="spin"></span><span class="lbl">${esc(m.text)}</span></div></div>`;
  if (m.error) return `<div class="msg a"><div class="who">AI</div><div class="bub err">${esc(m.error)}</div></div>`;
  const r = m.response;
  let h = '';
  if (r.query) {
    h += `<div class="q"><div class="qhead">Generated Query<span class="open-sql" data-sql="${esc(r.query)}">Open in Query Language editor →</span></div><div class="qcode">${esc(r.query)}</div></div>`;
  }
  if (r.interpretation) h += `<div class="in">${esc(r.interpretation)}</div>`;
  if (r.data && r.data.length > 0) {
    const cols = Object.keys(r.data[0]);
    h += `<table class="qt"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${r.data.slice(0, 30).map((row) => `<tr>${cols.map((c) => typeof row[c] === 'number' ? `<td class="cn">${fmtNum(row[c])}</td>` : `<td>${esc(String(row[c] ?? ''))}</td>`).join('')}</tr>`).join('')}${r.data.length > 30 ? `<tr><td colspan="${cols.length}" style="text-align:center;color:var(--t3);">+ ${r.data.length - 30} more rows</td></tr>` : ''}</tbody></table>`;
  }
  if (r.chart && r.chart.type && r.chart.type !== 'none' && r.data && r.data.length > 0) {
    const id = `chart-${i}-${Date.now()}`;
    h += `<div class="qch"><canvas id="${id}" data-chart='${esc(JSON.stringify({ chart: r.chart, data: r.data }))}'></canvas></div>`;
  }
  if (r.summary) h += `<div class="sum">${esc(r.summary)}</div>`;
  if (r.anomaly) h += `<div class="anom">${esc(r.anomaly)}</div>`;
  if (r.didYouMean && r.didYouMean.length > 0) h += `<div class="didyou"><strong>Did you mean…</strong><ul>${r.didYouMean.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>`;
  if (r.suggestions && r.suggestions.length > 0) {
    h += `<div class="chips">${r.suggestions.map((s) => `<button class="chip" data-q="${esc(s.text)}"><span class="l">${esc(s.type)}</span>${esc(s.text)}</button>`).join('')}</div>`;
  }
  if (r.error) h = `<div class="anom" style="border-color:var(--rd);background:var(--rdb);color:var(--rd);">${esc(r.error)}</div>` + h;
  return `<div class="msg a"><div class="who">AI</div><div class="bub">${h || '<em style="color:var(--t3)">(empty response)</em>'}</div></div>`;
}

async function sendChat() {
  const q = $('#ai-q').value.trim();
  if (!q || aiBusy) return;
  $('#ai-q').value = '';
  aiBusy = true;
  state.chatHistory.push({ role: 'user', text: q });
  state.chatHistory.push({ role: 'assistant', text: 'Thinking', thinking: true });
  renderAi();
  try {
    const history = state.chatHistory.filter((m) => !m.thinking && (m.role === 'user' || (m.role === 'assistant' && m.response))).map((m) => ({ role: m.role, text: m.role === 'user' ? m.text : `Query: ${m.response.query}\nResult: ${m.response.summary}` }));
    // drop the most recent user (we'll re-send via question)
    history.pop();
    const response = await api('/api/conversational/ask', { method: 'POST', body: { question: q, history } });
    state.chatHistory = state.chatHistory.filter((m) => !m.thinking);
    state.chatHistory.push({ role: 'assistant', response });
  } catch (e) {
    state.chatHistory = state.chatHistory.filter((m) => !m.thinking);
    state.chatHistory.push({ role: 'assistant', error: e.message });
  } finally {
    aiBusy = false;
    renderAi();
  }
}

// ─────────────────────────────────────────────────────────────────
// Chart rendering (Chart.js)
// ─────────────────────────────────────────────────────────────────
const PALETTE = ['#2c5aa0', '#0a8f4e', '#b06d00', '#6d4ab8', '#c02929', '#3771c8', '#1a8a8f', '#a3a83a'];

function drawChart(canvas, chart, data) {
  if (!chart || !data || data.length === 0) return;
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
      backgroundColor: chart.type === 'pie' || chart.type === 'doughnut' ? data.map((_, j) => PALETTE[j % PALETTE.length]) : PALETTE[i % PALETTE.length],
      borderColor: PALETTE[i % PALETTE.length],
      borderWidth: 1,
    }));
    canvas._labels = labels;
  }
  new Chart(canvas, {
    type: chart.type,
    data: { labels: canvas._labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#475569', font: { size: 11 } } },
        title: chart.title ? { display: true, text: chart.title, color: '#1f2937', font: { size: 13, weight: '500' } } : { display: false },
      },
      scales: chart.type === 'pie' || chart.type === 'doughnut' ? {} : {
        x: { ticks: { color: '#6b7589', font: { size: 11 } }, grid: { color: '#e9eef4' } },
        y: { ticks: { color: '#6b7589', font: { size: 11 } }, grid: { color: '#e9eef4' }, beginAtZero: true },
      },
    },
  });
}

// ─────────────────────────────────────────────────────────────────
// Confirm modal
// ─────────────────────────────────────────────────────────────────
let pendingConfirm = null;
function confirmAction(title, msg, onConfirm) {
  $('#confirm-title').textContent = title;
  $('#confirm-msg').textContent = msg;
  pendingConfirm = onConfirm;
  openModal('modal-confirm');
}
$('#confirm-ok').addEventListener('click', () => {
  closeModal('modal-confirm');
  if (pendingConfirm) { const fn = pendingConfirm; pendingConfirm = null; fn(); }
});

// ─────────────────────────────────────────────────────────────────
// Toolbar / global handlers
// ─────────────────────────────────────────────────────────────────
$('#sb-filter').addEventListener('input', renderTree);

// Resizable sidebar
const SB_W_KEY = 'pgstudio.sidebar.width';
const SB_W_MIN = 200, SB_W_MAX = 600;
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
$('#conn-info').addEventListener('click', (e) => { e.stopPropagation(); toggleConnMenu(); });
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
$('#cm-disconnect').addEventListener('click', async () => {
  closeConnMenu();
  try {
    await api('/api/disconnect', { method: 'POST' });
    resetDisconnectedState();
    toast('Disconnected', 'ok');
    updateConnState(); openModal('modal-connect');
  } catch (e) { toast(e.message, 'err'); }
});

// Connect modal
$('#connect-open').addEventListener('click', async () => {
  const fp = $('#connect-filepath').value.trim();
  if (!fp) { $('#connect-err').classList.remove('hidden'); $('#connect-err').textContent = 'Provide a file path.'; return; }
  $('#connect-err').classList.add('hidden');
  try {
    const { message } = await api('/api/connect', { method: 'POST', body: { filepath: fp } });
    state.connected = true; state.filepath = fp;
    toast(message, 'ok');
    closeModal('modal-connect');
    updateConnState();
    await loadCollections(); await loadModel(); render();
  } catch (e) { $('#connect-err').classList.remove('hidden'); $('#connect-err').textContent = e.message; }
});
$('#connect-create').addEventListener('click', async () => {
  const fp = $('#connect-filepath').value.trim();
  if (!fp) { $('#connect-err').classList.remove('hidden'); $('#connect-err').textContent = 'Provide a file path.'; return; }
  $('#connect-err').classList.add('hidden');
  try {
    const { message } = await api('/api/create', { method: 'POST', body: { filepath: fp } });
    state.connected = true; state.filepath = fp;
    toast(message, 'ok');
    closeModal('modal-connect');
    updateConnState();
    await loadCollections(); await loadModel(); render();
  } catch (e) { $('#connect-err').classList.remove('hidden'); $('#connect-err').textContent = e.message; }
});
$('#connect-demo').addEventListener('click', async () => {
  const fp = $('#connect-filepath').value.trim();
  if (!fp) { $('#connect-err').classList.remove('hidden'); $('#connect-err').textContent = 'Provide a file path.'; return; }
  $('#connect-err').classList.add('hidden');
  try {
    const { message } = await api('/api/create', { method: 'POST', body: { filepath: fp } });
    state.connected = true; state.filepath = fp;
    closeModal('modal-connect');
    updateConnState();
    toast(message, 'ok');
    await seedDemoEmployees();
  } catch (e) { $('#connect-err').classList.remove('hidden'); $('#connect-err').textContent = e.message; }
});

// Settings modal
$('#set-save-gemini').addEventListener('click', async () => {
  const key = $('#set-gemini-key').value.trim();
  if (!key) { $('#set-gemini-err').classList.remove('hidden'); $('#set-gemini-err').textContent = 'Provide a key.'; return; }
  try {
    await api('/api/settings/gemini-key', { method: 'POST', body: { key } });
    state.geminiKeySet = true;
    $('#set-gemini-ok').classList.remove('hidden'); $('#set-gemini-err').classList.add('hidden');
    updateConnState(); renderTabs(); renderTab();
  } catch (e) { $('#set-gemini-err').classList.remove('hidden'); $('#set-gemini-err').textContent = e.message; }
});
// Start
bootstrap();
