// @author Codex
// @date 2026-05-05

import { apiCall } from './api.js';
import { formatSize, escapeHTML } from './utils.js';

type CompressionAlgorithm = 'none' | 'gzip' | 'deflate' | 'brotli' | 'zstd-fast' | 'zstd';
type LabPolicyKey = 'none-uniform' | 'gzip-uniform' | 'zstd-uniform' | 'gzip-everything' | 'advisor-mix';

type LabPolicyTotals = {
  totalBytes: number;
  totalBlocks: number;
  blocksSavedVsRaw: number;
  writeCostMs: number;
  readAmplification: number;
};

type LabFieldReport = {
  field: string;
  recommended: CompressionAlgorithm;
  summary: string;
  rationale: string;
  activeProfile: { displayName: string };
  avgBytes: number | null;
  presenceRate: number;
};

type LabReport = {
  collection: string;
  workload: number;
  sampleSize: number;
  baseline: {
    totalBytes: number;
    totalBlocks: number;
  };
  perField: LabFieldReport[];
  policies: Record<LabPolicyKey, LabPolicyTotals>;
};

type LabInitOptions = {
  loadCollections: () => Promise<void>;
  openCollection: (collection: string) => void;
};

const COLLECTION = 'wiki_lab';
const POLICY_ORDER: LabPolicyKey[] = ['none-uniform', 'gzip-uniform', 'zstd-uniform', 'gzip-everything', 'advisor-mix'];
const POLICY_LABELS: Record<LabPolicyKey, string> = {
  'none-uniform': 'None',
  'gzip-uniform': 'Gzip',
  'zstd-uniform': 'Zstd',
  'gzip-everything': 'Gzip all',
  'advisor-mix': '★ Advisor',
};

let opts: LabInitOptions;
let seedBtn: HTMLButtonElement;
let applyBtn: HTMLButtonElement;
let slider: HTMLInputElement;
let workloadValue: HTMLElement;
let statusLine: HTMLElement;
let chartHost: HTMLElement;
let fieldsHost: HTMLElement;
let totalsHost: HTMLElement;
let debounceHandle: number | null = null;
let lastRecommendations = new Map<string, CompressionAlgorithm>();

export function initLab(options: LabInitOptions): void {
  opts = options;
  const panel = document.getElementById('lab-panel') as HTMLElement | null;
  if (!panel) return;

  panel.innerHTML = `
    <div class="lab-toolbar">
      <div class="lab-actions">
        <button id="lab-seed-btn" class="btn-primary">Load Wikipedia scenario</button>
        <button id="lab-apply-btn" class="btn-success" disabled>Apply advice for next data</button>
        <label class="lab-workload-label">
          <span>Workload</span>
          <input id="lab-workload" type="range" min="0" max="100" value="0">
          <span id="lab-workload-value">Cold 0%</span>
        </label>
      </div>
      <div id="lab-status" class="lab-status">Connect a database, then load the scenario.</div>
    </div>
    <div class="lab-body">
      <section class="lab-chart-section">
        <div id="lab-totals" class="lab-totals"></div>
        <div id="lab-chart" class="lab-chart-empty">No report loaded</div>
      </section>
      <section class="lab-fields-section">
        <div class="lab-section-header">Per-field routing</div>
        <div id="lab-fields" class="lab-fields"></div>
      </section>
    </div>`;

  seedBtn = document.getElementById('lab-seed-btn') as HTMLButtonElement;
  applyBtn = document.getElementById('lab-apply-btn') as HTMLButtonElement;
  slider = document.getElementById('lab-workload') as HTMLInputElement;
  workloadValue = document.getElementById('lab-workload-value') as HTMLElement;
  statusLine = document.getElementById('lab-status') as HTMLElement;
  chartHost = document.getElementById('lab-chart') as HTMLElement;
  fieldsHost = document.getElementById('lab-fields') as HTMLElement;
  totalsHost = document.getElementById('lab-totals') as HTMLElement;

  seedBtn.addEventListener('click', () => void seedScenario());
  applyBtn.addEventListener('click', () => void applyAdvice());
  slider.addEventListener('input', () => {
    renderWorkloadLabel();
    if (debounceHandle !== null) window.clearTimeout(debounceHandle);
    debounceHandle = window.setTimeout(() => void refreshReport(), 200);
  });
  renderWorkloadLabel();
}

async function seedScenario(): Promise<void> {
  setBusy(true, 'Seeding wiki_lab...');
  try {
    const data = await apiCall('/api/compression/lab/seed-wiki', 'POST', { count: 100 });
    const inserted = typeof data['inserted'] === 'number' ? data['inserted'] : 0;
    await opts.loadCollections();
    opts.openCollection(COLLECTION);
    statusLine.textContent = `Seeded ${inserted} articles into ${COLLECTION}.`;
    await refreshReport();
  } catch (error) {
    statusLine.textContent = (error as Error).message;
  } finally {
    setBusy(false);
  }
}

async function refreshReport(): Promise<void> {
  setBusy(true, 'Computing compression report...');
  try {
    const workload = Number(slider.value) / 100;
    const data = await apiCall('/api/compression/lab/recommend-collection', 'POST', {
      collection: COLLECTION,
      workload,
      sampleSize: 100,
    });
    const report = data['report'] as LabReport;
    renderReport(report);
    applyBtn.disabled = false;
    statusLine.textContent = `Report ready for ${report.collection}.`;
  } catch (error) {
    statusLine.textContent = (error as Error).message;
  } finally {
    setBusy(false);
  }
}

async function applyAdvice(): Promise<void> {
  setBusy(true, 'Applying advisor defaults...');
  try {
    const workload = Number(slider.value) / 100;
    const data = await apiCall('/api/compression/lab/apply-advice', 'POST', {
      collection: COLLECTION,
      workload,
      sampleSize: 100,
    });
    const fields = typeof data['fields'] === 'number' ? data['fields'] : 0;
    window.dispatchEvent(new CustomEvent('compression-defaults-updated'));
    statusLine.textContent = `Applied advisor defaults for ${fields} fields. Future writes use this policy.`;
  } catch (error) {
    statusLine.textContent = (error as Error).message;
  } finally {
    setBusy(false);
  }
}

function setBusy(busy: boolean, message?: string): void {
  seedBtn.disabled = busy;
  applyBtn.disabled = busy || fieldsHost.innerHTML.trim() === '';
  slider.disabled = busy;
  if (message) statusLine.textContent = message;
}

function renderWorkloadLabel(): void {
  const value = Number(slider.value);
  const mode = value <= 33 ? 'Cold' : value >= 66 ? 'Hot' : 'Balanced';
  workloadValue.textContent = `${mode} ${value}%`;
}

function renderReport(report: LabReport): void {
  renderTotals(report);
  renderChart(report);
  renderFields(report.perField);
}

function renderTotals(report: LabReport): void {
  const advisor = report.policies['advisor-mix'];
  totalsHost.innerHTML = `
    <div class="lab-total">
      <span>Raw</span>
      <strong>${formatSize(report.baseline.totalBytes)}</strong>
      <small>${report.baseline.totalBlocks} blocks</small>
    </div>
    <div class="lab-total lab-total-advisor">
      <span>Advisor</span>
      <strong>${formatSize(advisor.totalBytes)}</strong>
      <small>${advisor.totalBlocks} blocks</small>
    </div>
    <div class="lab-total">
      <span>Saved</span>
      <strong>${advisor.blocksSavedVsRaw}</strong>
      <small>blocks</small>
    </div>`;
}

function renderFields(fields: LabFieldReport[]): void {
  fieldsHost.innerHTML = fields
    .map((field) => {
      const previous = lastRecommendations.get(field.field);
      const changed = previous !== undefined && previous !== field.recommended;
      lastRecommendations.set(field.field, field.recommended);
      return `
        <article class="per-field-row${changed ? ' changed' : ''}" data-field="${escapeHTML(field.field)}">
          <div class="per-field-main">
            <strong>${escapeHTML(field.field)}</strong>
            <span>${escapeHTML(field.activeProfile.displayName)}</span>
          </div>
          <div class="per-field-recommendation">${escapeHTML(field.recommended)}</div>
          <p>${escapeHTML(field.rationale)}</p>
          <div class="per-field-meta">
            <span>${field.avgBytes === null ? 'n/a' : formatSize(field.avgBytes)}</span>
            <span>${Math.round(field.presenceRate * 100)}% present</span>
          </div>
        </article>`;
    })
    .join('');

  window.setTimeout(() => {
    fieldsHost.querySelectorAll('.per-field-row.changed').forEach((row) => row.classList.remove('changed'));
  }, 240);
}

function renderChart(report: LabReport): void {
  const groups = [
    {
      key: 'totalBytes',
      label: 'Bytes',
      value: (policy: LabPolicyTotals) => policy.totalBytes,
      format: formatSize,
    },
    {
      key: 'totalBlocks',
      label: 'Blocks',
      value: (policy: LabPolicyTotals) => policy.totalBlocks,
      format: (value: number) => String(Math.round(value)),
    },
    {
      key: 'writeCostMs',
      label: 'Write ms',
      value: (policy: LabPolicyTotals) => policy.writeCostMs,
      format: (value: number) => value.toFixed(1),
    },
  ];

  const width = 820;
  const height = 320;
  const padding = { top: 24, right: 24, bottom: 62, left: 58 };
  const groupWidth = (width - padding.left - padding.right) / groups.length;
  const barWidth = 20;
  const gap = 6;
  const chartHeight = height - padding.top - padding.bottom;

  const bars = groups
    .map((group, groupIndex) => {
      const maxValue = Math.max(...POLICY_ORDER.map((policy) => group.value(report.policies[policy])), 1);
      const groupX = padding.left + groupIndex * groupWidth;
      const startX = groupX + (groupWidth - POLICY_ORDER.length * barWidth - (POLICY_ORDER.length - 1) * gap) / 2;
      const groupBars = POLICY_ORDER.map((policy, policyIndex) => {
        const value = group.value(report.policies[policy]);
        const barHeight = Math.max(2, (value / maxValue) * chartHeight);
        const x = startX + policyIndex * (barWidth + gap);
        const y = padding.top + chartHeight - barHeight;
        return `
          <rect class="lab-bar lab-bar-${policy}" x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="2">
            <title>${escapeHTML(POLICY_LABELS[policy])}: ${escapeHTML(group.format(value))}</title>
          </rect>`;
      }).join('');

      return `
        <g>
          ${groupBars}
          <text class="lab-axis-label" x="${groupX + groupWidth / 2}" y="${height - 34}" text-anchor="middle">${escapeHTML(group.label)}</text>
        </g>`;
    })
    .join('');

  const legend = POLICY_ORDER.map((policy, index) => {
    const x = padding.left + index * 138;
    return `
      <g transform="translate(${x}, ${height - 18})">
        <rect class="lab-bar-${policy}" x="0" y="-10" width="10" height="10" rx="2"></rect>
        <text class="lab-legend-label" x="16" y="0">${escapeHTML(POLICY_LABELS[policy])}</text>
      </g>`;
  }).join('');

  chartHost.className = 'lab-chart';
  chartHost.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Compression policy comparison">
      <line class="lab-axis" x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${width - padding.right}" y2="${padding.top + chartHeight}"></line>
      ${bars}
      ${legend}
    </svg>`;
}
