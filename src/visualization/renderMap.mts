import { writeFileSync } from 'node:fs';

export type MapPoint = {
  x: number;
  y: number;
  id: string;
  label: string;
  fields: Record<string, unknown>;
  imageUrl?: string;
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
    .legend { margin-left: auto; display: flex; gap: 14px; align-items: center; font-size: 0.75rem; color: #666; flex-shrink: 0; }
    .legend-item { display: flex; align-items: center; gap: 5px; }
    .legend-dot { width: 10px; height: 10px; border-radius: 50%; background: #7ec8e3; }
    .legend-img { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #7ec8e3; background: #333; }
    #map { width: 100vw; height: calc(100vh - 52px); display: block; }
    circle { cursor: pointer; }
    circle:hover { stroke-width: 2.5px; opacity: 1 !important; }
    .img-node { cursor: pointer; }
    #tooltip {
      position: fixed; background: #16213e; border: 1px solid #7ec8e3;
      border-radius: 8px; padding: 12px 16px; font-size: 12px;
      pointer-events: none; max-width: 300px; display: none;
      box-shadow: 0 8px 24px rgba(0,0,0,0.6); z-index: 100;
    }
    .tip-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .tip-img { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 2px solid #7ec8e3; flex-shrink: 0; }
    .doc-id { color: #7ec8e3; font-size: 14px; font-weight: 600; }
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
    <div class="legend">
      <div class="legend-item"><div class="legend-dot"></div> document</div>
      <div class="legend-item"><div class="legend-img"></div> with image</div>
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

    svg.append('defs')
      .append('clipPath').attr('id', 'img-clip')
      .append('circle').attr('cx', 0).attr('cy', 0).attr('r', 16);

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

    // ── Deterministic per-document jitter (stable across re-renders) ────────
    function stableJitter(id, seed, range) {
      const s = id + seed;
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (Math.imul(h, 0x01000193)) >>> 0; }
      return (h / 4294967296 - 0.5) * range;
    }

    /**
     * THE KEY FIX: one single function that computes both data positions and
     * tick positions from the same arithmetic. Axis labels and data points
     * can never drift apart because they share the same source of truth.
     *
     * Returns:
     *   dataPositions  — one pixel value per document (with jitter for categoricals)
     *   ticks          — [{label, pos}] for axis decorations (no jitter, exact base positions)
     *   naPos          — position for missing-value documents, or null if none
     */
    function computeLayout(field, axis) {
      const isX = axis === 'x';
      const lo  = isX ? pad     : H - pad;   // start of usable range
      const hi  = isX ? W - pad : pad;        // end   of usable range

      // ── Semantic (PCA) mode ──────────────────────────────────────────────
      if (field === 'semantic') {
        return {
          dataPositions: data.map(d => isX ? xScalePCA(d.x) : yScalePCA(d.y)),
          ticks: [],
          naPos: null,
        };
      }

      const rawValues  = data.map(d => d.fields[field]);
      const defined    = rawValues.filter(v => v != null);
      const isNumeric  = defined.length > 0 && defined.every(v => typeof v === 'number');
      const hasMissing = rawValues.some(v => v == null);
      const naPos      = isX ? pad / 2 : H - pad / 2;

      // ── Numeric field ────────────────────────────────────────────────────
      if (isNumeric) {
        const scale = d3.scaleLinear().domain(d3.extent(defined)).range([lo, hi]);
        return {
          dataPositions: rawValues.map((v, i) =>
            v != null
              ? scale(v) + stableJitter(data[i].id, axis, 18)
              : naPos    + stableJitter(data[i].id, axis + 'na', 30)
          ),
          ticks: scale.ticks(5).map(t => ({ label: String(t), pos: scale(t) })),
          naPos: hasMissing ? naPos : null,
        };
      }

      // ── Categorical field ────────────────────────────────────────────────
      const categories = [...new Set(defined.map(String))].sort();
      const step = categories.length > 1 ? (hi - lo) / (categories.length - 1) : 0;

      // Build a map: category string → exact base pixel position (no jitter)
      const basePos = new Map(categories.map((cat, idx) => [cat, lo + idx * step]));

      return {
        dataPositions: rawValues.map((v, i) => {
          if (v == null) return naPos + stableJitter(data[i].id, axis + 'na', 30);
          return basePos.get(String(v)) + stableJitter(data[i].id, axis, 22);
        }),
        // Ticks reuse the exact same basePos map — guaranteed to match data positions
        ticks: categories.map(cat => ({ label: cat, pos: basePos.get(cat) })),
        naPos: hasMissing ? naPos : null,
      };
    }

    // ── Axis decoration ─────────────────────────────────────────────────────
    const axisLayer = svg.append('g').attr('class', 'axis-layer');

    function drawAxis(field, axis, ticks, naPos) {
      const isX = axis === 'x';
      axisLayer.selectAll('.' + axis + '-deco').remove();
      if (field === 'semantic') return;

      const g2 = axisLayer.append('g').attr('class', axis + '-deco');

      // Field name label
      if (isX) {
        g2.append('text').attr('x', W / 2).attr('y', H - 6)
          .attr('text-anchor', 'middle').attr('fill', '#555').attr('font-size', 11).text(field);
      } else {
        g2.append('text')
          .attr('transform', 'rotate(-90)').attr('x', -H / 2).attr('y', 14)
          .attr('text-anchor', 'middle').attr('fill', '#555').attr('font-size', 11).text(field);
      }

      // Tick marks and labels — positions come directly from computeLayout ticks
      for (const { label, pos } of ticks) {
        if (isX) {
          g2.append('line')
            .attr('x1', pos).attr('y1', pad - 8).attr('x2', pos).attr('y2', H - pad + 8)
            .attr('stroke', '#2a2a5a').attr('stroke-width', 1);
          g2.append('text')
            .attr('x', pos).attr('y', H - pad + 20)
            .attr('text-anchor', 'middle').attr('fill', '#666').attr('font-size', 10).text(label);
        } else {
          g2.append('line')
            .attr('x1', pad - 8).attr('y1', pos).attr('x2', W - pad + 8).attr('y2', pos)
            .attr('stroke', '#2a2a5a').attr('stroke-width', 1);
          g2.append('text')
            .attr('x', pad - 12).attr('y', pos + 3)
            .attr('text-anchor', 'end').attr('fill', '#666').attr('font-size', 10).text(label);
        }
      }

      // N/A marker
      if (naPos != null) {
        if (isX) {
          g2.append('line')
            .attr('x1', naPos).attr('y1', pad).attr('x2', naPos).attr('y2', H - pad)
            .attr('stroke', '#2a2a5a').attr('stroke-width', 1).attr('stroke-dasharray', '4 4');
          g2.append('text')
            .attr('x', naPos).attr('y', H - pad + 20)
            .attr('text-anchor', 'middle').attr('fill', '#444').attr('font-size', 10).text('N/A');
        } else {
          g2.append('line')
            .attr('x1', pad).attr('y1', naPos).attr('x2', W - pad).attr('y2', naPos)
            .attr('stroke', '#2a2a5a').attr('stroke-width', 1).attr('stroke-dasharray', '4 4');
          g2.append('text')
            .attr('x', pad - 12).attr('y', naPos + 3)
            .attr('text-anchor', 'end').attr('fill', '#444').attr('font-size', 10).text('N/A');
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
      const imgHtml = d.imageUrl ? '<img class="tip-img" src="' + d.imageUrl + '" crossorigin="anonymous"/>' : '';
      tooltip.innerHTML = '<div class="tip-header">' + imgHtml + '<div class="doc-id">' + d.id + '</div></div>' + rows;
      tooltip.style.display = 'block';
      const tx = event.clientX + 16;
      tooltip.style.left = (tx + tooltip.offsetWidth > W ? tx - tooltip.offsetWidth - 32 : tx) + 'px';
      tooltip.style.top  = Math.max(0, event.clientY - 10) + 'px';
    }
    function hideTooltip() { tooltip.style.display = 'none'; }

    g.selectAll('circle.dot')
      .data(data.filter(d => !d.imageUrl)).join('circle').attr('class', 'dot')
      .attr('r', 8).attr('fill', d => color(data.indexOf(d)))
      .attr('opacity', 0.82).attr('stroke', '#fff').attr('stroke-width', 0.8)
      .on('mousemove', showTooltip).on('mouseleave', hideTooltip);

    const imgNodes = g.selectAll('g.img-node')
      .data(data.filter(d => d.imageUrl)).join('g').attr('class', 'img-node')
      .on('mousemove', showTooltip).on('mouseleave', hideTooltip);
    imgNodes.append('image')
      .attr('x', -16).attr('y', -16).attr('width', 32).attr('height', 32)
      .attr('href', d => d.imageUrl ?? '').attr('clip-path', 'url(#img-clip)').attr('crossorigin', 'anonymous');
    imgNodes.append('circle')
      .attr('r', 16).attr('fill', 'none')
      .attr('stroke', d => color(data.indexOf(d))).attr('stroke-width', 2.5);

    g.selectAll('text.lbl').data(data).join('text').attr('class', 'lbl')
      .attr('font-size', 11).attr('fill', '#ccc')
      .attr('pointer-events', 'none').attr('user-select', 'none')
      .text(d => d.label);

    // ── Update: uses computeLayout so data positions and tick positions are
    //    always computed from identical arithmetic ───────────────────────────
    function update(animate) {
      const xLayout = computeLayout(xSel.value, 'x');
      const yLayout = computeLayout(ySel.value, 'y');

      const posMap = new Map(
        data.map((d, i) => [d.id, { x: xLayout.dataPositions[i], y: yLayout.dataPositions[i] }])
      );

      const t = d3.transition().duration(animate ? 700 : 0).ease(d3.easeCubicInOut);

      g.selectAll('circle.dot').transition(t)
        .attr('cx', d => posMap.get(d.id).x).attr('cy', d => posMap.get(d.id).y);

      g.selectAll('g.img-node').transition(t)
        .attr('transform', d => { const p = posMap.get(d.id); return 'translate(' + p.x + ',' + p.y + ')'; });

      g.selectAll('text.lbl').transition(t)
        .attr('x', d => posMap.get(d.id).x + (d.imageUrl ? 20 : 12))
        .attr('y', d => posMap.get(d.id).y + 4);

      // Pass tick positions that came from the SAME computeLayout call
      drawAxis(xSel.value, 'x', xLayout.ticks, xLayout.naPos);
      drawAxis(ySel.value, 'y', yLayout.ticks, yLayout.naPos);
    }

    update(false);
    xSel.addEventListener('change', () => update(true));
    ySel.addEventListener('change', () => update(true));
  </script>
</body>
</html>`;

  writeFileSync(outputPath, html, 'utf-8');
}
