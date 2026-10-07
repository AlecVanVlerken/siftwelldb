import { writeFileSync } from 'node:fs';

export type MapPoint = {
  x: number;
  y: number;
  id: string;
  label: string;
  fields: Record<string, unknown>;
};

export function renderMap(points: MapPoint[], outputPath: string): void {
  const data = JSON.stringify(points);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Document Semantic Map</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f0f1a; font-family: 'Segoe UI', Arial, sans-serif; color: #e0e0e0; overflow: hidden; }
    header {
      height: 52px; display: flex; align-items: center;
      padding: 0 16px; gap: 12px;
      background: #16213e; border-bottom: 1px solid #2a2a5a;
    }
    header h1 { font-size: 0.95rem; color: #7ec8e3; font-weight: 500; white-space: nowrap; }
    .divider { width: 1px; height: 24px; background: #2a2a5a; flex-shrink: 0; }
    .axis-control { display: flex; align-items: center; gap: 6px; font-size: 0.78rem; color: #888; }
    select {
      background: #0f0f1a; color: #e0e0e0;
      border: 1px solid #3a3a6a; border-radius: 4px;
      padding: 3px 6px; font-size: 0.78rem; cursor: pointer; outline: none;
    }
    select:hover { border-color: #7ec8e3; }
    #map { width: 100vw; height: calc(100vh - 52px); display: block; }
    circle { cursor: pointer; }
    circle:hover { stroke-width: 2.5px; }
    #tooltip {
      position: fixed; background: #16213e; border: 1px solid #7ec8e3;
      border-radius: 8px; padding: 12px 16px; font-size: 12px;
      pointer-events: none; max-width: 300px; display: none;
      box-shadow: 0 8px 24px rgba(0,0,0,0.6); z-index: 100;
    }
    .doc-id { color: #7ec8e3; font-size: 14px; font-weight: 600; margin-bottom: 8px; }
    .field { margin: 3px 0; }
    .field .key { color: #888; margin-right: 6px; }
  </style>
</head>
<body>
  <header>
    <h1>Document Semantic Map</h1>
    <div class="divider"></div>
    <div class="axis-control">
      <label>X axis</label>
      <select id="x-select"></select>
    </div>
    <div class="axis-control">
      <label>Y axis</label>
      <select id="y-select"></select>
    </div>
  </header>
  <svg id="map"></svg>
  <div id="tooltip"></div>

  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <script>
    const data = ${data};

    const W = window.innerWidth;
    const H = window.innerHeight - 52;
    const pad = 80;

    const svg = d3.select('#map').attr('width', W).attr('height', H);

    const xScalePCA = d3.scaleLinear().domain(d3.extent(data, d => d.x)).range([pad, W - pad]);
    const yScalePCA = d3.scaleLinear().domain(d3.extent(data, d => d.y)).range([H - pad, pad]);

    // ── Populate dropdowns ──────────────────────────────────────────────────
    const allFields = ['semantic', ...new Set(data.flatMap(d => Object.keys(d.fields)))];
    const xSel = document.getElementById('x-select');
    const ySel = document.getElementById('y-select');
    for (const f of allFields) {
      const label = f === 'semantic' ? 'Semantic (PCA)' : f;
      xSel.appendChild(new Option(label, f));
      ySel.appendChild(new Option(label, f));
    }
    if (allFields.length > 1) ySel.value = allFields[1];

    // ── Deterministic per-document jitter ───────────────────────────────────
    function stableJitter(id, seed, range) {
      const s = id + seed;
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (Math.imul(h, 0x01000193)) >>> 0; }
      return (h / 4294967296 - 0.5) * range;
    }

    /**
     * Computes pixel positions for one axis AND marks which documents are visible.
     * A document is visible only if it has a value for the chosen field.
     * In semantic mode every document is visible.
     *
     * Returns:
     *   dataPositions — pixel value per document (jitter applied for categoricals)
     *   ticks         — [{label, pos}] for axis tick marks (no jitter, exact base)
     *   visible       — boolean[] — false means this document is missing the field
     */
    function computeLayout(field, axis) {
      const isX = axis === 'x';
      const lo  = isX ? pad     : H - pad;
      const hi  = isX ? W - pad : pad;

      if (field === 'semantic') {
        return {
          dataPositions: data.map(d => isX ? xScalePCA(d.x) : yScalePCA(d.y)),
          ticks: [],
          visible: data.map(() => true),
        };
      }

      const rawValues = data.map(d => d.fields[field]);
      const visible   = rawValues.map(v => v != null);
      const defined   = rawValues.filter(v => v != null);
      const isNumeric = defined.length > 0 && defined.every(v => typeof v === 'number');

      if (isNumeric) {
        const scale = d3.scaleLinear().domain(d3.extent(defined)).range([lo, hi]);
        return {
          dataPositions: rawValues.map((v, i) =>
            v != null ? scale(v) + stableJitter(data[i].id, axis, 18) : 0
          ),
          ticks: scale.ticks(5).map(t => ({ label: String(t), pos: scale(t) })),
          visible,
        };
      }

      // Categorical
      const categories = [...new Set(defined.map(String))].sort();
      const step    = categories.length > 1 ? (hi - lo) / (categories.length - 1) : 0;
      const basePos = new Map(categories.map((cat, idx) => [cat, lo + idx * step]));

      return {
        dataPositions: rawValues.map((v, i) =>
          v != null ? basePos.get(String(v)) + stableJitter(data[i].id, axis, 22) : 0
        ),
        ticks: categories.map(cat => ({ label: cat, pos: basePos.get(cat) })),
        visible,
      };
    }

    // ── Axis decorations ────────────────────────────────────────────────────
    const axisLayer = svg.append('g');

    function drawAxis(field, axis, ticks) {
      const isX = axis === 'x';
      axisLayer.selectAll('.' + axis + '-deco').remove();
      if (field === 'semantic' || ticks.length === 0) return;

      const g2 = axisLayer.append('g').attr('class', axis + '-deco');

      // Ticks — positions come directly from computeLayout, same arithmetic as data
      for (const { pos } of ticks) {
        if (isX) {
          g2.append('line')
            .attr('x1', pos).attr('y1', pad - 8).attr('x2', pos).attr('y2', H - pad + 8)
            .attr('stroke', '#2a2a5a').attr('stroke-width', 1);
        } else {
          g2.append('line')
            .attr('x1', pad - 8).attr('y1', pos).attr('x2', W - pad + 8).attr('y2', pos)
            .attr('stroke', '#2a2a5a').attr('stroke-width', 1);
        }
      }
    }

    // ── Build scene ─────────────────────────────────────────────────────────
    const g = svg.append('g');
    svg.call(d3.zoom().scaleExtent([0.15, 20]).on('zoom', e => g.attr('transform', e.transform)));

    const color = d3.scaleSequential(d3.interpolateTurbo).domain([0, Math.max(1, data.length - 1)]);
    const tooltip = document.getElementById('tooltip');

    function showTooltip(event, d) {
      const rows = Object.entries(d.fields)
        .map(([k, v]) => '<div class="field"><span class="key">' + k + '</span>' + v + '</div>').join('');
      tooltip.innerHTML = '<div class="doc-id">' + d.id + '</div>' + rows;
      tooltip.style.display = 'block';
      const tx = event.clientX + 16;
      tooltip.style.left = (tx + tooltip.offsetWidth > W ? tx - tooltip.offsetWidth - 32 : tx) + 'px';
      tooltip.style.top  = Math.max(0, event.clientY - 10) + 'px';
    }
    function hideTooltip() { tooltip.style.display = 'none'; }

    g.selectAll('circle.dot')
      .data(data).join('circle').attr('class', 'dot')
      .attr('r', 8).attr('fill', (_, i) => color(i))
      .attr('stroke', '#fff').attr('stroke-width', 0.8)
      .on('mousemove', showTooltip).on('mouseleave', hideTooltip);

    g.selectAll('text.lbl').data(data).join('text').attr('class', 'lbl')
      .attr('font-size', 11).attr('fill', '#ccc')
      .attr('pointer-events', 'none').attr('user-select', 'none')
      .text(d => d.label);

    // ── Update ──────────────────────────────────────────────────────────────
    function update(animate) {
      const xLayout = computeLayout(xSel.value, 'x');
      const yLayout = computeLayout(ySel.value, 'y');

      // A document is shown only when it has a value on BOTH selected axes
      const posMap = new Map(data.map((d, i) => [d.id, {
        x:       xLayout.dataPositions[i],
        y:       yLayout.dataPositions[i],
        visible: xLayout.visible[i] && yLayout.visible[i],
      }]));

      const t = d3.transition().duration(animate ? 700 : 0).ease(d3.easeCubicInOut);

      g.selectAll('circle.dot').transition(t)
        .attr('cx',            d => posMap.get(d.id).x)
        .attr('cy',            d => posMap.get(d.id).y)
        .attr('opacity',       d => posMap.get(d.id).visible ? 0.82 : 0)
        .attr('pointer-events',d => posMap.get(d.id).visible ? 'auto' : 'none');

      g.selectAll('text.lbl').transition(t)
        .attr('x',       d => posMap.get(d.id).x + 12)
        .attr('y',       d => posMap.get(d.id).y + 4)
        .attr('opacity', d => posMap.get(d.id).visible ? 1 : 0);

      drawAxis(xSel.value, 'x', xLayout.ticks);
      drawAxis(ySel.value, 'y', yLayout.ticks);
    }

    update(false);
    xSel.addEventListener('change', () => update(true));
    ySel.addEventListener('change', () => update(true));
  </script>
</body>
</html>`;

  writeFileSync(outputPath, html, 'utf-8');
}
