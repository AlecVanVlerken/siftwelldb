import { writeFileSync } from 'node:fs';

export type MapPoint = {
  x: number;
  y: number;
  id: string;
  label: string;
  fields: Record<string, unknown>;
};

/**
 * Generates a self-contained interactive HTML file visualizing the 2D document map.
 *
 * Features:
 *  - Scroll to zoom, drag to pan
 *  - Hover a point to inspect all document fields in a tooltip
 *  - Points coloured by position using a continuous colour scale
 *  - Document ID labels next to each point
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
      height: 48px;
      display: flex;
      align-items: center;
      padding: 0 20px;
      gap: 16px;
      background: #16213e;
      border-bottom: 1px solid #2a2a5a;
    }
    header h1 { font-size: 1rem; color: #7ec8e3; font-weight: 500; }
    header small { color: #555; font-size: 0.78rem; }
    #map { width: 100vw; height: calc(100vh - 48px); display: block; }
    circle { cursor: pointer; }
    circle:hover { stroke-width: 2.5px; opacity: 1 !important; }
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
    .doc-id { color: #7ec8e3; font-size: 14px; font-weight: 600; margin-bottom: 8px; }
    .field { margin: 3px 0; }
    .field .key { color: #888; margin-right: 6px; }
  </style>
</head>
<body>
  <header>
    <h1>Document Semantic Map</h1>
    <small>scroll to zoom &middot; drag to pan &middot; hover a point to inspect</small>
  </header>
  <svg id="map"></svg>
  <div id="tooltip"></div>

  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <script>
    const data = ${data};

    const W = window.innerWidth;
    const H = window.innerHeight - 48;
    const pad = 80;

    const svg = d3.select('#map').attr('width', W).attr('height', H);

    const xScale = d3.scaleLinear()
      .domain(d3.extent(data, d => d.x))
      .range([pad, W - pad]);

    const yScale = d3.scaleLinear()
      .domain(d3.extent(data, d => d.y))
      .range([H - pad, pad]);

    const color = d3.scaleSequential(d3.interpolateTurbo)
      .domain([0, Math.max(1, data.length - 1)]);

    const g = svg.append('g');

    svg.call(
      d3.zoom().scaleExtent([0.15, 20]).on('zoom', e => g.attr('transform', e.transform))
    );

    const tooltip = document.getElementById('tooltip');

    // --- Points ---
    g.selectAll('circle')
      .data(data)
      .join('circle')
        .attr('cx', d => xScale(d.x))
        .attr('cy', d => yScale(d.y))
        .attr('r', 8)
        .attr('fill', (_, i) => color(i))
        .attr('opacity', 0.82)
        .attr('stroke', '#ffffff')
        .attr('stroke-width', 0.8)
        .on('mousemove', (event, d) => {
          const rows = Object.entries(d.fields)
            .map(([k, v]) =>
              '<div class="field"><span class="key">' + k + '</span>' + v + '</div>'
            ).join('');
          tooltip.innerHTML = '<div class="doc-id">' + d.id + '</div>' + rows;
          tooltip.style.display = 'block';
          const tx = event.clientX + 16;
          const ty = event.clientY - 10;
          const overflows = tx + tooltip.offsetWidth > window.innerWidth;
          tooltip.style.left = (overflows ? tx - tooltip.offsetWidth - 32 : tx) + 'px';
          tooltip.style.top = Math.max(0, ty) + 'px';
        })
        .on('mouseleave', () => { tooltip.style.display = 'none'; });

    // --- Labels ---
    g.selectAll('text')
      .data(data)
      .join('text')
        .attr('x', d => xScale(d.x) + 12)
        .attr('y', d => yScale(d.y) + 4)
        .text(d => d.label)
        .attr('font-size', 11)
        .attr('fill', '#cccccc')
        .attr('pointer-events', 'none')
        .attr('user-select', 'none');
  </script>
</body>
</html>`;

  writeFileSync(outputPath, html, 'utf-8');
}
