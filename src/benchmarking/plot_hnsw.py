"""
HNSW Performance Plot
Reads src/benchmarking/results/hnsw_performance.json and produces a 4-panel figure.

Run from the src/benchmarking/ directory:
    python plot_hnsw.py
"""

import json
import os

import matplotlib
matplotlib.use('Agg')  # headless / no display required
import matplotlib.pyplot as plt
import numpy as np

RESULTS_DIR = 'results/'
IMAGES_DIR  = 'results/images/'
os.makedirs(IMAGES_DIR, exist_ok=True)

# ── Load data ─────────────────────────────────────────────────────────────────

with open(RESULTS_DIR + 'hnsw_performance.json', 'r') as f:
    data = json.load(f)

cfg    = data['config']
DIM    = cfg['dim']
N      = cfg['insertCount']
M_val  = cfg['M']
ef_c   = cfg['efConstruction']
ef_s   = cfg['efSearch']
k_val  = cfg['k']
runs   = cfg['runs']

insert_times = np.array(data['insertTimes'])           # shape (N,)
checkpoints  = data['searchCheckpoints']               # list of dicts
last_raw     = np.array(data['searchTimesLastCheckpoint'])  # shape (~)

sizes      = np.array([cp['indexSize'] for cp in checkpoints])
s_mean     = np.array([cp['meanMs']    for cp in checkpoints])
s_p50      = np.array([cp['p50Ms']     for cp in checkpoints])
s_p95      = np.array([cp['p95Ms']     for cp in checkpoints])

# ── Smoothing for insert-time plot ────────────────────────────────────────────

WINDOW = max(50, N // 60)
n_idx  = np.arange(1, len(insert_times) + 1)
ins_smooth = np.convolve(insert_times, np.ones(WINDOW) / WINDOW, mode='valid')
n_smooth   = n_idx[WINDOW // 2 : len(ins_smooth) + WINDOW // 2]

# ── Figure ────────────────────────────────────────────────────────────────────

fig, axes = plt.subplots(2, 2, figsize=(14, 10))
fig.suptitle(
    f'HNSW Performance  —  dim={DIM},  M={M_val},  efC={ef_c},  efS={ef_s},  k={k_val},  runs={runs}',
    fontsize=12, fontweight='bold',
)

# ── Panel 1 (top-left): insert time vs index size ────────────────────────────
ax1 = axes[0, 0]
ax1.semilogx(n_smooth, ins_smooth, 'steelblue', linewidth=1.2, label='Insert time (smoothed)')
k_ref = np.mean(ins_smooth) / np.mean(np.log2(n_smooth))
ax1.semilogx(n_smooth, k_ref * np.log2(n_smooth), 'r--', linewidth=1.5,
             label=f'O(log n) ref  (k={k_ref:.4f})')
ax1.set_xlabel('Index size  (log scale)')
ax1.set_ylabel('Time per insert  (ms)')
ax1.set_title(f'INSERT  time vs index size  (smoothing window={WINDOW})')
ax1.legend(fontsize=9)
ax1.grid(True, alpha=0.3)

# ── Panel 2 (top-right): insert time / log₂(n) ratio ────────────────────────
ax2 = axes[0, 1]
ratio      = ins_smooth / np.log2(n_smooth)
mean_ratio = float(np.mean(ratio))
ax2.plot(n_smooth, ratio, 'steelblue', linewidth=1)
ax2.axhline(mean_ratio, color='r',      linestyle='--', label=f'Mean = {mean_ratio:.4f}')
ax2.fill_between(n_smooth, mean_ratio * 0.8, mean_ratio * 1.2,
                 alpha=0.15, color='r', label='±20 % band')
ax2.set_xlabel('Index size')
ax2.set_ylabel('time / log₂(n)')
ax2.set_title('INSERT  time/log₂(n)  —  flat ≈ O(log n)')
ax2.legend(fontsize=9)
ax2.grid(True, alpha=0.3)

# ── Panel 3 (bottom-left): k-NN search time vs index size ────────────────────
ax3 = axes[1, 0]
ax3.plot(sizes, s_mean, 'o-', color='seagreen',   linewidth=1.5, markersize=5, label='Mean')
ax3.plot(sizes, s_p50,  's--', color='mediumseagreen', linewidth=1,   markersize=4, label='P50')
ax3.plot(sizes, s_p95,  '^--', color='darkgreen',  linewidth=1,   markersize=4, label='P95')
if len(sizes) >= 2:
    ref_k  = s_mean[-1] / np.log2(max(sizes[-1], 2))
    ax3.plot(sizes, ref_k * np.log2(np.maximum(sizes, 2)), 'r--',
             linewidth=1.5, label='O(log n) ref')
ax3.set_xlabel('Index size')
ax3.set_ylabel('Search time  (ms)')
ax3.set_title(f'k-NN SEARCH  time vs index size  (k={k_val})')
ax3.legend(fontsize=9)
ax3.grid(True, alpha=0.3)

# ── Panel 4 (bottom-right): latency distribution at last checkpoint ───────────
ax4 = axes[1, 1]
last_n   = int(sizes[-1]) if len(sizes) else N
mean_s   = float(np.mean(last_raw))
p50_s    = float(np.percentile(last_raw, 50))
p95_s    = float(np.percentile(last_raw, 95))
ax4.hist(last_raw, bins=25, color='seagreen', alpha=0.7, edgecolor='white')
ax4.axvline(mean_s, color='red',    linestyle='--', linewidth=1.5, label=f'Mean  {mean_s:.3f} ms')
ax4.axvline(p50_s,  color='orange', linestyle='--', linewidth=1.5, label=f'P50   {p50_s:.3f} ms')
ax4.axvline(p95_s,  color='purple', linestyle='--', linewidth=1.5, label=f'P95   {p95_s:.3f} ms')
ax4.set_xlabel('Query latency  (ms)')
ax4.set_ylabel('Count')
ax4.set_title(f'k-NN SEARCH  latency distribution  (N={last_n})')
ax4.legend(fontsize=9)
ax4.grid(True, alpha=0.3)

plt.tight_layout()
out_path = IMAGES_DIR + 'hnsw_performance.png'
plt.savefig(out_path, dpi=150, bbox_inches='tight')
print(f'Plot saved → {out_path}')
plt.close()

# ── Terminal summary ──────────────────────────────────────────────────────────
sorted_ins  = np.sort(insert_times)
mean_ins    = float(np.mean(insert_times))
p95_ins     = float(np.percentile(insert_times, 95))

print('\n── Summary ─────────────────────────────────────────────────────────')
print(f'  Dimension      : {DIM}')
print(f'  Vectors        : {N}   |  Runs: {runs}')
print(f'  HNSW params    : M={M_val}  efC={ef_c}  efS={ef_s}')
print(f'  INSERT  mean   : {mean_ins:.4f} ms    P95: {p95_ins:.4f} ms')
print(f'  SEARCH  mean   : {mean_s:.4f} ms    P50: {p50_s:.4f} ms    P95: {p95_s:.4f} ms   (N={last_n})')
