import { writeFileSync } from 'node:fs';

export type MapPoint = {
  x: number;
  y: number;
  id: string;
  label: string;
  fields: Record<string, unknown>;
  imageUrl?: string;
};

/**
 * Generates a self-contained interactive HTML file visualizing the 2D document map.
 *
 * Features:
 *  - Scroll to zoom, drag to pan
 *  - Hover any point to inspect all its fields in a tooltip
 *  - Points without an image: coloured dot; points with imageUrl: circular photo
 *  - X/Y axis dropdowns: switch from PCA layout to any field-based layout
 *  - Documents missing the chosen field land in a dedicated "N/A" column/row
 *  - Smooth animated transitions between layouts
 */
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
    body {
      background: #0f0f1a;
      font-family: 'Segoe UI', Arial, sans-serif;
      color: #e0e0e0;
      overflow: hidden;
    }
    header {
      height: 52px;
      display: flex;
      align-items: center;
      padding: 0 16px;
      gap: 12px;
      background: #16213e;
      border-bottom: 1px solid #2a2a5a;
      flex-wrap: nowrap;
    }
    header h1 { font-size: 0.95rem; color: #7ec8e3; font-weight: 500; white-space: nowrap; }
    .divider { width: 1px; height: 24px; background: #2a2a5a; flex-shrink: 0; }
    .axis-control { display: flex; align-items: center; gap: 6px; font-size: 0.78rem; color: #888; }
    .axis-control label { white-space: nowrap; }
    select {
      background: #0f0f1a;
      color: #e0e0e0;
      border: 1px solid #3a3a6a;
      border-radius: 4px;
      padding: 3px 6px;
      font-size: 0.78rem;
      cursor: pointer;
      outline: none;
    }
    select:hover { border-color: #7ec8e3; }
    .legend {
      margin-left: auto;
      display: flex;
      gap: 14px;
      align-items: center;
      font-size: 0.75rem;
      color: #666;
      flex-shrink: 0;
    }
    .legend-item { display: flex; align-items: center; gap: 5px; }
    .legend-dot { width: 10px; height: 10px; border-radius: 50%; background: #7ec8e3; }
    .legend-img { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #7ec8e3; background: #333; }
    #map { width: 100vw; height: calc(100vh - 52px); display: block; }
    circle { cursor: pointer; }
    circle:hover { stroke-width: 2.5px; opacity: 1 !important; }
    .img-node { cursor: pointer; }
    #tooltip {
      position: fixed;
      background: #16213e;
      border: 1px solid #7ec8e3;
      border-radius: 8px;
      padding: 12px 16px;
      font-size: 12px;
      pointer-events: none;
      max-width: 300px;
      display: none;
      box-shadow: 0 8px 24px rgba(0,0,0,0.6);
      z-index: 100;
    }
    .tip-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .tip-img { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 2px solid #7ec8e3; flex-shrink: 0; }
    .doc-id { color: #7ec8e3; font-size: 14px; font-weight: 600; }
    .field { margin: 3px 0; }
    .field .key { color: #888; margin-right: 6px; }
    .axis-label { fill: #555; font-size: 10px; pointer-events: none; }
    .axis-tick { stroke: #2a2a5a; stroke-width: 1; }
    .axis-tick-label { fill: #666; font-size: 10px; pointer-events: none; }
    .na-line { stroke: #2a2a5a; stroke-width: 1; stroke-dasharray: 4 4; }
    .na-label { fill: #444; font-size: 10px; pointer-events: none; }
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

    // Shared clip path for circular images (centred at origin, each node uses translate)
    svg.append('defs')
      .append('clipPath').attr('id', 'img-clip')
      .append('circle').attr('cx', 0).attr('cy', 0).attr('r', 16);

    // ── Scales ─────────────────────────────────────────────────────────────
    const xScalePCA = d3.scaleLinear()
      .domain(d3.extent(data, d => d.x)).range([pad, W - pad]);
    const yScalePCA = d3.scaleLinear()
      .domain(d3.extent(data, d => d.y)).range([H - pad, pad]);

    // ── Populate axis dropdowns ─────────────────────────────────────────────
    const allFields = ['semantic', ...new Set(data.flatMap(d => Object.keys(d.fields)))];
    const xSel = document.getElementById('x-select');
    const ySel = document.getElementById('y-select');

    for (const f of allFields) {
      const label = f === 'semantic' ? 'Semantic (PCA)' : f;
      xSel.appendChild(new Option(label, f));
      ySel.appendChild(new Option(label, f));
    }
    // Default Y to the first non-semantic field so the view is immediately interesting
    if (allFields.length > 1) ySel.value = allFields[1];

    // ── Deterministic jitter per document (stable across re-renders) ────────
    function stableJitter(id, axisKey, range) {
      const s = id + axisKey;
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (Math.imul(h, 0x01000193)) >>> 0;
      }
      return (h / 4294967296 - 0.5) * range;
    }

    // ── Compute pixel positions for one axis given a field name ─────────────
    function fieldPositions(field, axis) {
      const isX = axis === 'x';
      const lo = isX ? pad : H - pad;
      const hi = isX ? W - pad : pad;

      if (field === 'semantic') {
        return data.map(d => isX ? xScalePCA(d.x) : yScalePCA(d.y));
      }

      const rawValues = data.map(d => d.fields[field]);
      const defined = rawValues.filter(v => v != null);
      const isNumeric = defined.length > 0 && defined.every(v => typeof v === 'number');

      if (isNumeric) {
        const scale = d3.scaleLinear().domain(d3.extent(defined)).range([lo, hi]);
        return rawValues.map((v, i) =>
          v != null
            ? scale(v) + stableJitter(data[i].id, axis, 18)
            : isX ? pad / 2 : H - pad / 2
        );
      }

      // Categorical: sort unique values, put N/A at the far end
      const categories = [...new Set(defined.map(String))].sort();
      const NApos = isX ? pad / 2 : H - pad / 2;
      const usableRange = isX ? [pad, W - pad] : [H - pad, pad];
      const step = categories.length > 1
        ? (usableRange[1] - usableRange[0]) / (categories.length - 1)
        : 0;

      return rawValues.map((v, i) => {
        if (v == null) return NApos + stableJitter(data[i].id, axis + 'na', 30);
        const idx = categories.indexOf(String(v));
        const base = usableRange[0] + idx * step;
        return base + stableJitter(data[i].id, axis, 22);
      });
    }

    // ── Axis decoration (tick labels and optional N/A marker) ───────────────
    const axisLayer = svg.append('g').attr('class', 'axis-layer');

    function drawAxisDecorations(field, axis, positions) {
      const isX = axis === 'x';
      axisLayer.selectAll('.' + axis + '-deco').remove();
      const g2 = axisLayer.append('g').attr('class', axis + '-deco');

      if (field === 'semantic') return;

      const rawValues = data.map(d => d.fields[field]);
      const defined = rawValues.filter(v => v != null);
      const isNumeric = defined.length > 0 && defined.every(v => typeof v === 'number');
      const categories = isNumeric
        ? null
        : [...new Set(defined.map(String))].sort();

      // Field name label along the axis edge
      if (isX) {
        g2.append('text').attr('class', 'axis-label')
          .attr('x', W / 2).attr('y', H - 8)
          .attr('text-anchor', 'middle')
          .text(field);
      } else {
        g2.append('text').attr('class', 'axis-label')
          .attr('transform', 'rotate(-90)')
          .attr('x', -H / 2).attr('y', 14)
          .attr('text-anchor', 'middle')
          .text(field);
      }

      if (categories) {
        const lo = isX ? pad : H - pad;
        const hi = isX ? W - pad : pad;
        const usableRange = [lo, hi];
        const step = categories.length > 1
          ? (usableRange[1] - usableRange[0]) / (categories.length - 1)
          : 0;

        categories.forEach((cat, idx) => {
          const pos = usableRange[0] + idx * step;
          if (isX) {
            g2.append('line').attr('class', 'axis-tick')
              .attr('x1', pos).attr('y1', pad - 10)
              .attr('x2', pos).attr('y2', H - pad + 10);
            g2.append('text').attr('class', 'axis-tick-label')
              .attr('x', pos).attr('y', H - pad + 22)
              .attr('text-anchor', 'middle').text(cat);
          } else {
            g2.append('line').attr('class', 'axis-tick')
              .attr('x1', pad - 10).attr('y1', pos)
              .attr('x2', W - pad + 10).attr('y2', pos);
            g2.append('text').attr('class', 'axis-tick-label')
              .attr('x', pad - 14).attr('y', pos + 3)
              .attr('text-anchor', 'end').text(cat);
          }
        });
      }

      // N/A indicator if any documents are missing this field
      const hasMissing = rawValues.some(v => v == null);
      if (hasMissing) {
        const naPos = isX ? pad / 2 : H - pad / 2;
        if (isX) {
          g2.append('line').attr('class', 'na-line')
            .attr('x1', naPos).attr('y1', pad).attr('x2', naPos).attr('y2', H - pad);
          g2.append('text').attr('class', 'na-label')
            .attr('x', naPos).attr('y', H - pad + 22).attr('text-anchor', 'middle').text('N/A');
        } else {
          g2.append('line').attr('class', 'na-line')
            .attr('x1', pad).attr('y1', naPos).attr('x2', W - pad).attr('y2', naPos);
          g2.append('text').attr('class', 'na-label')
            .attr('x', pad - 14).attr('y', naPos + 3).attr('text-anchor', 'end').text('N/A');
        }
      }
    }

    // ── Build the main scene ────────────────────────────────────────────────
    const g = svg.append('g');

    svg.call(
      d3.zoom().scaleExtent([0.15, 20]).on('zoom', e => g.attr('transform', e.transform))
    );

    const color = d3.scaleSequential(d3.interpolateTurbo)
      .domain([0, Math.max(1, data.length - 1)]);

    const tooltip = document.getElementById('tooltip');

    function showTooltip(event, d) {
      const rows = Object.entries(d.fields)
        .map(([k, v]) => '<div class="field"><span class="key">' + k + '</span>' + v + '</div>')
        .join('');
      const imgHtml = d.imageUrl
        ? '<img class="tip-img" src="' + d.imageUrl + '" crossorigin="anonymous"/>'
        : '';
      tooltip.innerHTML =
        '<div class="tip-header">' + imgHtml +
        '<div class="doc-id">' + d.id + '</div></div>' + rows;
      tooltip.style.display = 'block';
      const tx = event.clientX + 16;
      const ty = event.clientY - 10;
      tooltip.style.left =
        (tx + tooltip.offsetWidth > W ? tx - tooltip.offsetWidth - 32 : tx) + 'px';
      tooltip.style.top = Math.max(0, ty) + 'px';
    }
    function hideTooltip() { tooltip.style.display = 'none'; }

    // Dots (no image)
    g.selectAll('circle.dot')
      .data(data.filter(d => !d.imageUrl))
      .join('circle')
        .attr('class', 'dot')
        .attr('r', 8)
        .attr('fill', (d) => color(data.indexOf(d)))
        .attr('opacity', 0.82)
        .attr('stroke', '#ffffff')
        .attr('stroke-width', 0.8)
        .on('mousemove', showTooltip)
        .on('mouseleave', hideTooltip);

    // Image nodes
    const imgNodes = g.selectAll('g.img-node')
      .data(data.filter(d => d.imageUrl))
      .join('g')
        .attr('class', 'img-node')
        .on('mousemove', showTooltip)
        .on('mouseleave', hideTooltip);

    imgNodes.append('image')
      .attr('x', -16).attr('y', -16)
      .attr('width', 32).attr('height', 32)
      .attr('href', d => d.imageUrl ?? '')
      .attr('clip-path', 'url(#img-clip)')
      .attr('crossorigin', 'anonymous');

    imgNodes.append('circle')
      .attr('r', 16)
      .attr('fill', 'none')
      .attr('stroke', d => color(data.indexOf(d)))
      .attr('stroke-width', 2.5);

    // Labels
    g.selectAll('text.lbl')
      .data(data)
      .join('text')
        .attr('class', 'lbl')
        .attr('font-size', 11)
        .attr('fill', '#cccccc')
        .attr('pointer-events', 'none')
        .attr('user-select', 'none')
        .text(d => d.label);

    // ── Update positions (called on load and on every dropdown change) ──────
    function update(animate) {
      const xField = xSel.value;
      const yField = ySel.value;

      const xs = fieldPositions(xField, 'x');
      const ys = fieldPositions(yField, 'y');
      const posMap = new Map(data.map((d, i) => [d.id, { x: xs[i], y: ys[i] }]));

      const t = animate
        ? d3.transition().duration(700).ease(d3.easeCubicInOut)
        : d3.transition().duration(0);

      g.selectAll('circle.dot')
        .transition(t)
        .attr('cx', d => posMap.get(d.id).x)
        .attr('cy', d => posMap.get(d.id).y);

      g.selectAll('g.img-node')
        .transition(t)
        .attr('transform', d => {
          const p = posMap.get(d.id);
          return 'translate(' + p.x + ',' + p.y + ')';
        });

      g.selectAll('text.lbl')
        .transition(t)
        .attr('x', d => posMap.get(d.id).x + (d.imageUrl ? 20 : 12))
        .attr('y', d => posMap.get(d.id).y + 4);

      drawAxisDecorations(xField, 'x', xs);
      drawAxisDecorations(yField, 'y', ys);
    }

    // Initial render (no animation)
    update(false);

    // Re-render on dropdown change (with animation)
    xSel.addEventListener('change', () => update(true));
    ySel.addEventListener('change', () => update(true));
  </script>
</body>
</html>`;

  writeFileSync(outputPath, html, 'utf-8');
}
