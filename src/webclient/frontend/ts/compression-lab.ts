/* eslint-disable */
// @ts-nocheck
import { api } from './api-client.js';
import { $ } from './dom.js';
import { esc, fmtNum, fmtSize } from './format.js';
import { captureRequestContext, isCurrentRequestContext, state } from './state.js';

export function createCompressionLab(actions) {
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
    if (collection === null) {
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
    if (state.lab.busy || actions.isCompressionBusy()) return;
    const collection = state.selectedCol;
    if (collection === null) {
      actions.toast('Select a collection first.', 'warn');
      return;
    }
    const context = captureRequestContext();
    state.lab.busy = true;
    actions.setCompressionBusy(true);
    renderLab();
    try {
      const result = await api('/api/compression/lab/apply-advice', {
        method: 'POST',
        body: { collection, workload: state.lab.workload, sampleSize: 100 },
      });
      if (!isCurrentRequestContext(context)) return;
      actions.toast(
        `Saved advisor defaults for ${result.fields} fields in ${collection}. Existing documents were not recompressed.`,
        'ok',
      );
      if (collection === state.selectedCol) await actions.loadCompressionDefaults(collection);
    } catch (e) {
      if (!isCurrentRequestContext(context)) return;
      actions.toast('Apply lab advice failed: ' + e.message, 'err');
    } finally {
      if (isCurrentRequestContext(context)) {
        state.lab.busy = false;
        actions.setCompressionBusy(false);
        if (state.tab === 'lab') renderLab();
      }
    }
  }

  function renderLab() {
    const report = state.lab.report;
    const collection = state.selectedCol;
    if (collection === null) {
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
    $('#lab-back')?.addEventListener('click', actions.selectRoot);
    $('#lab-run')?.addEventListener('click', runCompressionLabReport);
    $('#lab-apply')?.addEventListener('click', applyLabAdvice);
    $('#lab-workload')?.addEventListener('input', (e) => {
      state.lab.workload = Number(e.target.value) / 100;
      state.lab.report = null;
      $('#lab-workload-label').textContent = `${e.target.value}%`;
    });
    $('#lab-workload')?.addEventListener('change', renderLab);
  }
  return { render: renderLab };
}
