/* eslint-disable */
// @ts-nocheck
// Chart.js lifecycle and rendering are kept separate from application navigation.

const PALETTE = ['#2c5aa0', '#0a8f4e', '#b06d00', '#6d4ab8', '#c02929', '#3771c8', '#1a8a8f', '#a3a83a'];

const aiCharts = new Map();

export function destroyAiCharts() {
  for (const chart of aiCharts.values()) chart.destroy();
  aiCharts.clear();
}

export function drawChart(canvas, chart, data) {
  if (!chart || !Array.isArray(data) || data.length === 0 || !Array.isArray(chart.yColumns) || !chart.yColumns.length)
    return;
  const previous = aiCharts.get(canvas);
  if (previous) {
    previous.destroy();
    aiCharts.delete(canvas);
  }
  for (const [oldCanvas, instance] of aiCharts) {
    if (!oldCanvas.isConnected) {
      instance.destroy();
      aiCharts.delete(oldCanvas);
    }
  }
  if (typeof globalThis.Chart !== 'function') {
    canvas.replaceWith(document.createTextNode('Chart unavailable. The result data is shown above.'));
    return;
  }
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
      backgroundColor:
        chart.type === 'pie' || chart.type === 'doughnut'
          ? data.map((_, j) => PALETTE[j % PALETTE.length])
          : PALETTE[i % PALETTE.length],
      borderColor: PALETTE[i % PALETTE.length],
      borderWidth: 1,
    }));
    canvas._labels = labels;
  }
  const instance = new globalThis.Chart(canvas, {
    type: chart.type,
    data: { labels: canvas._labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#475569', font: { size: 11 } } },
        title: chart.title
          ? { display: true, text: chart.title, color: '#1f2937', font: { size: 13, weight: '500' } }
          : { display: false },
      },
      scales:
        chart.type === 'pie' || chart.type === 'doughnut'
          ? {}
          : {
              x: { ticks: { color: '#6b7589', font: { size: 11 } }, grid: { color: '#e9eef4' } },
              y: { ticks: { color: '#6b7589', font: { size: 11 } }, grid: { color: '#e9eef4' }, beginAtZero: true },
            },
    },
  });
  aiCharts.set(canvas, instance);
}
