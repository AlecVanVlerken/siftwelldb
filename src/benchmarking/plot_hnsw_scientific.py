"""
HNSW Scientific Benchmark Plotter
===================================
Reads results from src/benchmarking/results/scientific/ and produces a suite
of publication-quality figures matching the analysis style of the original
HNSW paper (Malkov & Yashunin, 2018).

Generated figures
-----------------
  1. m_sweep.png           — insert & search time vs N for M = 8/16/24/32
  2. efc_sweep.png         — insert & search time vs N for efC = 50/100/200/400
  3. logn_ratio.png        — time / log₂(N) ratio (O(log N) verification)
  4. recall_small_n.png    — recall@K vs N (brute-force, small-N checkpoints)
  5. recall_vs_efsearch.png— recall@K vs efSearch (the key HNSW paper plot)
  6. recall_speed.png      — recall@K vs mean latency (speed-recall tradeoff)
  7. dim_sweep.png         — insert & search time vs dimension

Run from the src/benchmarking/ directory:
    python plot_hnsw_scientific.py
"""

import json
import os
import glob
import math

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.cm as cm
import numpy as np

# ── Paths ─────────────────────────────────────────────────────────────────────

RESULTS_DIR = 'results/scientific/'
IMAGES_DIR  = 'results/scientific/images/'
os.makedirs(IMAGES_DIR, exist_ok=True)

# ── Style helpers ─────────────────────────────────────────────────────────────

plt.rcParams.update({
    'font.size'       : 10,
    'axes.titlesize'  : 11,
    'axes.labelsize'  : 10,
    'legend.fontsize' : 9,
    'lines.linewidth' : 1.6,
    'grid.alpha'      : 0.3,
})

TAB10 = plt.get_cmap('tab10')
def color(i): return TAB10(i % 10)

def add_logn_ref(ax, ns, values, color='gray', linestyle='--', label='O(log n) ref'):
    """Overlay a scaled O(log₂ n) reference curve."""
    log_ns = np.log2(np.maximum(ns, 2))
    k = np.mean(values) / np.mean(log_ns)
    ax.plot(ns, k * log_ns, color=color, linestyle=linestyle,
            linewidth=1.2, label=label, alpha=0.7)

# ── Data loaders ──────────────────────────────────────────────────────────────

def load_combined(fname):
    path = RESULTS_DIR + fname
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)

def ns_and_metric(exp, key_mean):
    """Return arrays (n_values, mean_values) from an experiment's checkpoints."""
    cps = exp['checkpoints']
    ns   = np.array([c['n']      for c in cps])
    vals = np.array([c[key_mean] for c in cps])
    return ns, vals

# ── Figure helpers ────────────────────────────────────────────────────────────

def save_fig(fig, name):
    path = IMAGES_DIR + name
    fig.savefig(path, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'  saved → {path}')

# ─────────────────────────────────────────────────────────────────────────────
# Figure 1 & 2: Performance sweep (M or efC)
# 4-panel: insert time vs N | insert/log(N) ratio | search time vs N | recall
# ─────────────────────────────────────────────────────────────────────────────

def plot_perf_sweep(data, sweep_param: str, out_name: str):
    """
    data : combined JSON dict with 'experiments' list
    sweep_param : label used in the title / legend (e.g. 'M' or 'efConstruction')
    """
    if data is None:
        print(f'  [skip] {out_name} — data not found')
        return

    experiments = data['experiments']
    n_exp = len(experiments)

    fig, axes = plt.subplots(2, 2, figsize=(15, 11))
    fig.suptitle(
        f'HNSW Performance  —  {sweep_param} sweep\n'
        f'(fixed: {", ".join(f"{k}={v}" for k, v in data["meta"]["fixedParams"].items())})',
        fontsize=12, fontweight='bold',
    )

    ax_ins, ax_ratio, ax_srch, ax_recall = (
        axes[0, 0], axes[0, 1], axes[1, 0], axes[1, 1]
    )

    for i, exp in enumerate(experiments):
        params  = exp['params']
        label   = f'{sweep_param}={params[sweep_param]}'
        c       = color(i)

        ns, ins_mean = ns_and_metric(exp, 'insertMeanMs')
        ns, srch_mean = ns_and_metric(exp, 'searchMeanMs')
        _, srch_p95   = ns_and_metric(exp, 'searchP95Ms')
        _, ins_p95    = ns_and_metric(exp, 'insertP95Ms')

        log_ns = np.log2(np.maximum(ns, 2))

        # ── Panel 1: insert time vs N (log x) ────────────────────────────────
        ax_ins.semilogx(ns, ins_mean, color=c, label=f'{label} mean')
        ax_ins.fill_between(ns, ins_mean, ins_p95, alpha=0.12, color=c)

        # ── Panel 2: insert time / log₂(N) ratio ─────────────────────────────
        ratio = ins_mean / log_ns
        ax_ratio.semilogx(ns, ratio, color=c, label=label)

        # ── Panel 3: search time vs N ──────────────────────────────────────────
        ax_srch.plot(ns, srch_mean, color=c, label=f'{label} mean')
        ax_srch.fill_between(ns, srch_mean, srch_p95, alpha=0.12, color=c)

        # ── Panel 4: recall@K vs N (brute-force checkpoints) ──────────────────
        rps = exp.get('recallPoints', [])
        if rps:
            rns = np.array([r['n']          for r in rps])
            rR  = np.array([r['recallAtK']  for r in rps])
            ax_recall.plot(rns, rR, 'o-', color=c, markersize=5, label=label)

    # Formatting
    ax_ins.set_xlabel('Index size  (log scale)');  ax_ins.set_ylabel('Insert time (ms)')
    ax_ins.set_title('INSERT latency vs index size');  ax_ins.legend(); ax_ins.grid(True)

    ax_ratio.set_xlabel('Index size  (log scale)');  ax_ratio.set_ylabel('time / log₂(N)')
    ax_ratio.set_title('INSERT time / log₂(N)  — flat ≈ O(log N)');  ax_ratio.legend(); ax_ratio.grid(True)
    ax_ratio.axhline(np.nan, color='gray', linestyle='--', linewidth=0.8, label='flat = O(log n)')

    ax_srch.set_xlabel('Index size');  ax_srch.set_ylabel('Search time (ms)')
    ax_srch.set_title(f'k-NN SEARCH  latency vs index size  (k={experiments[0]["params"]["K"]})')
    ax_srch.legend(); ax_srch.grid(True)

    ax_recall.set_xlabel('Index size  (N)');  ax_recall.set_ylabel(f'Recall@{experiments[0]["params"]["K"]}')
    ax_recall.set_title(f'Recall@K vs index size  (brute-force ground truth, N ≤ {data["meta"]["recallMaxN"]:,})')
    ax_recall.set_ylim(0, 1.05);  ax_recall.legend();  ax_recall.grid(True)

    plt.tight_layout()
    save_fig(fig, out_name)

# ─────────────────────────────────────────────────────────────────────────────
# Figure 3: time / log₂(N) ratio — combined across all swept experiments
# ─────────────────────────────────────────────────────────────────────────────

def plot_logn_ratio_combined():
    datasets = [
        ('m_sweep_combined.json',   'M',              'm_sweep_M'),
        ('efc_sweep_combined.json', 'efConstruction', 'efc_sweep_efC'),
        ('dim_sweep_combined.json', 'dim',            'dim_sweep_dim'),
    ]

    fig, axes = plt.subplots(1, 3, figsize=(18, 5))
    fig.suptitle('INSERT time / log₂(N) ratio  — O(log N) complexity verification', fontsize=12, fontweight='bold')

    for ax, (fname, param_key, _) in zip(axes, datasets):
        data = load_combined(fname)
        if data is None:
            ax.set_title(f'{param_key} sweep — no data')
            continue
        experiments = data['experiments']
        for i, exp in enumerate(experiments):
            ns, ins_mean = ns_and_metric(exp, 'insertMeanMs')
            log_ns = np.log2(np.maximum(ns, 2))
            ratio  = ins_mean / log_ns
            val    = exp['params'][param_key]
            ax.semilogx(ns, ratio, color=color(i), label=f'{param_key}={val}')
            mean_r = float(np.mean(ratio))
            ax.axhline(mean_r, color=color(i), linestyle=':', linewidth=0.8, alpha=0.6)

        ax.set_xlabel('Index size  (log scale)')
        ax.set_ylabel('insert time / log₂(N)  (ms)')
        ax.set_title(f'{param_key} sweep')
        ax.legend()
        ax.grid(True)

    plt.tight_layout()
    save_fig(fig, 'logn_ratio_combined.png')

# ─────────────────────────────────────────────────────────────────────────────
# Figure 4: Recall@K at small N  —  brute-force ground truth
# ─────────────────────────────────────────────────────────────────────────────

def plot_recall_small_n():
    datasets = [
        ('m_sweep_combined.json',   'M',              'steelblue'   ),
        ('efc_sweep_combined.json', 'efConstruction', 'seagreen'    ),
    ]

    fig, axes = plt.subplots(1, 2, figsize=(14, 6))
    fig.suptitle(
        'Recall@K vs index size  (brute-force ground truth at small N)',
        fontsize=12, fontweight='bold',
    )

    for ax, (fname, param_key, _base_c) in zip(axes, datasets):
        data = load_combined(fname)
        if data is None:
            ax.set_title(f'{param_key} sweep — no data')
            continue
        for i, exp in enumerate(data['experiments']):
            rps = exp.get('recallPoints', [])
            if not rps:
                continue
            rns = np.array([r['n']         for r in rps])
            rR  = np.array([r['recallAtK'] for r in rps])
            K   = exp['params']['K']
            val = exp['params'][param_key]
            ax.plot(rns, rR, 'o-', color=color(i), markersize=6, label=f'{param_key}={val}')

        ax.set_xlabel('Index size  (N)')
        ax.set_ylabel(f'Recall@{K}')
        ax.set_title(f'Recall@K vs N  ({param_key} sweep)')
        ax.set_ylim(0, 1.05)
        ax.legend()
        ax.grid(True)

    plt.tight_layout()
    save_fig(fig, 'recall_small_n.png')

# ─────────────────────────────────────────────────────────────────────────────
# Figure 5: Recall@K vs efSearch  (the key HNSW paper plot)
# ─────────────────────────────────────────────────────────────────────────────

def plot_recall_vs_efsearch():
    data = load_combined('recall_sweep_combined.json')
    if data is None:
        print('  [skip] recall_vs_efsearch.png — no data')
        return

    experiments = data['experiments']
    K = data['meta']['K']

    fig, axes = plt.subplots(1, 2, figsize=(14, 6))
    fig.suptitle(
        f'HNSW Recall@{K} vs efSearch  —  N={data["meta"]["indexSize"]:,}  dim={data["meta"]["dim"]}',
        fontsize=12, fontweight='bold',
    )

    ax_recs, ax_trade = axes

    for i, exp in enumerate(experiments):
        pts     = exp['efSearchPoints']
        ef_vals = np.array([p['efSearch']  for p in pts])
        recalls = np.array([p['recallAtK'] for p in pts])
        means   = np.array([p['meanMs']    for p in pts])
        label   = exp['label'].replace('_', ' ')
        c       = color(i)

        # Panel 1: recall vs efSearch (log x)
        ax_recs.semilogx(ef_vals, recalls, 'o-', color=c, markersize=5, label=label)

        # Panel 2: speed-recall tradeoff (recall vs latency) — the HNSW paper's Fig. 3
        ax_trade.plot(means, recalls, 'o-', color=c, markersize=5, label=label)
        # Annotate some efSearch values
        for j in range(0, len(pts), max(1, len(pts) // 4)):
            ax_trade.annotate(
                str(pts[j]['efSearch']),
                (means[j], recalls[j]),
                textcoords='offset points', xytext=(4, 2),
                fontsize=7, color=c,
            )

    ax_recs.set_xlabel('efSearch  (log scale)')
    ax_recs.set_ylabel(f'Recall@{K}')
    ax_recs.set_title(f'Recall@{K} vs efSearch')
    ax_recs.set_ylim(0, 1.05)
    ax_recs.axhline(1.0, color='gray', linestyle=':', linewidth=1)
    ax_recs.legend()
    ax_recs.grid(True)

    ax_trade.set_xlabel('Mean query latency  (ms)')
    ax_trade.set_ylabel(f'Recall@{K}')
    ax_trade.set_title(f'Speed–Recall tradeoff  (higher-right = better)')
    ax_trade.set_ylim(0, 1.05)
    ax_trade.axhline(1.0, color='gray', linestyle=':', linewidth=1)
    ax_trade.legend()
    ax_trade.grid(True)

    plt.tight_layout()
    save_fig(fig, 'recall_vs_efsearch.png')

# ─────────────────────────────────────────────────────────────────────────────
# Figure 6: Speed–recall tradeoff per-config  (all 5 configs overlaid on one chart)
# ─────────────────────────────────────────────────────────────────────────────

def plot_recall_speed_combined():
    data = load_combined('recall_sweep_combined.json')
    if data is None:
        print('  [skip] recall_speed_combined.png — no data')
        return

    K    = data['meta']['K']
    fig, ax = plt.subplots(figsize=(9, 6))
    ax.set_title(
        f'HNSW Speed–Recall Tradeoff  (k={K},  N={data["meta"]["indexSize"]:,},  dim={data["meta"]["dim"]})\n'
        f'Numbers = efSearch value',
        fontsize=11,
    )

    for i, exp in enumerate(data['experiments']):
        pts     = exp['efSearchPoints']
        recalls = np.array([p['recallAtK'] for p in pts])
        means   = np.array([p['meanMs']    for p in pts])
        label   = exp['label'].replace('_', ' ')
        c       = color(i)

        ax.plot(means, recalls, 'o-', color=c, markersize=6, label=label)
        for j, pt in enumerate(pts):
            if j % max(1, len(pts) // 5) == 0:
                ax.annotate(
                    str(pt['efSearch']),
                    (means[j], recalls[j]),
                    textcoords='offset points', xytext=(4, -6),
                    fontsize=7, color=c,
                )

    ax.set_xlabel('Mean query latency  (ms)')
    ax.set_ylabel(f'Recall@{K}')
    ax.set_ylim(0, 1.05)
    ax.axhline(1.0, color='gray', linestyle=':', linewidth=1, label='Recall = 1.0')
    ax.legend()
    ax.grid(True)

    plt.tight_layout()
    save_fig(fig, 'recall_speed_combined.png')

# ─────────────────────────────────────────────────────────────────────────────
# Figure 7: Dimension sweep
# ─────────────────────────────────────────────────────────────────────────────

def plot_dim_sweep():
    data = load_combined('dim_sweep_combined.json')
    if data is None:
        print('  [skip] dim_sweep.png — no data')
        return

    experiments = data['experiments']

    fig, axes = plt.subplots(2, 2, figsize=(15, 11))
    fig.suptitle(
        f'HNSW Performance vs Embedding Dimension\n'
        f'(M={data["meta"]["fixedParams"]["M"]},  '
        f'efC={data["meta"]["fixedParams"]["efConstruction"]},  '
        f'efS={data["meta"]["fixedParams"]["efSearch"]},  '
        f'N={data["meta"]["fixedParams"]["N"]:,})',
        fontsize=12, fontweight='bold',
    )

    ax_ins, ax_ratio, ax_srch, ax_dim_summary = (
        axes[0, 0], axes[0, 1], axes[1, 0], axes[1, 1]
    )

    # Gather per-dim summary values (at final checkpoint)
    dim_vals      = []
    ins_finals    = []
    srch_finals   = []

    for i, exp in enumerate(experiments):
        dim    = exp['params']['dim']
        c      = color(i)
        ns, ins_mean  = ns_and_metric(exp, 'insertMeanMs')
        ns, srch_mean = ns_and_metric(exp, 'searchMeanMs')
        log_ns = np.log2(np.maximum(ns, 2))

        ax_ins.semilogx(ns, ins_mean, color=c, label=f'dim={dim}')
        ax_ratio.semilogx(ns, ins_mean / log_ns, color=c, label=f'dim={dim}')
        ax_srch.plot(ns, srch_mean, color=c, label=f'dim={dim}')

        dim_vals.append(dim)
        ins_finals.append(float(np.mean(ins_mean[-10:])))
        srch_finals.append(float(np.mean(srch_mean[-10:])))

    # Panel 4: insert & search time at final N vs dimension
    ax_dim_summary.plot(dim_vals, ins_finals,  'o-', color='steelblue', label='Insert mean (last window)')
    ax_dim_summary.plot(dim_vals, srch_finals, 's-', color='seagreen',  label='Search mean (last window)')
    ax_dim_summary.set_yscale('log')

    ax_ins.set_xlabel('Index size  (log scale)');  ax_ins.set_ylabel('Insert time (ms)')
    ax_ins.set_title('INSERT latency vs index size');  ax_ins.legend(); ax_ins.grid(True)

    ax_ratio.set_xlabel('Index size  (log scale)');  ax_ratio.set_ylabel('time / log₂(N)')
    ax_ratio.set_title('INSERT time / log₂(N)  — flat ≈ O(log N)');  ax_ratio.legend(); ax_ratio.grid(True)

    ax_srch.set_xlabel('Index size');  ax_srch.set_ylabel('Search time (ms)')
    ax_srch.set_title('k-NN SEARCH latency vs index size');  ax_srch.legend(); ax_srch.grid(True)

    ax_dim_summary.set_xlabel('Dimension');  ax_dim_summary.set_ylabel('Latency (ms, log scale)')
    ax_dim_summary.set_title('Latency at final N vs embedding dimension');  ax_dim_summary.legend(); ax_dim_summary.grid(True)

    plt.tight_layout()
    save_fig(fig, 'dim_sweep.png')

# ─────────────────────────────────────────────────────────────────────────────
# Figure 8: Big summary overview figure  (all-in-one)
# ─────────────────────────────────────────────────────────────────────────────

def plot_summary():
    m_data   = load_combined('m_sweep_combined.json')
    efc_data = load_combined('efc_sweep_combined.json')
    rec_data = load_combined('recall_sweep_combined.json')
    dim_data = load_combined('dim_sweep_combined.json')

    fig, axes = plt.subplots(2, 4, figsize=(26, 12))
    fig.suptitle(
        'HNSW Scientific Benchmark — Summary Overview\n'
        '(Rust-backed implementation, AVX2 SIMD, in-memory index)',
        fontsize=13, fontweight='bold',
    )

    # Row 0: M sweep insert | M sweep search | efC sweep insert | efC sweep search
    for row_data, title_param, col_offset in [
        (m_data,   'M',              0),
        (efc_data, 'efConstruction', 2),
    ]:
        ax_i = axes[0, col_offset]
        ax_s = axes[0, col_offset + 1]
        if row_data is None:
            continue
        param_key = title_param
        for i, exp in enumerate(row_data['experiments']):
            ns, ins  = ns_and_metric(exp, 'insertMeanMs')
            ns, srch = ns_and_metric(exp, 'searchMeanMs')
            val      = exp['params'][param_key]
            c        = color(i)
            ax_i.semilogx(ns, ins,  color=c, label=f'{param_key}={val}')
            ax_s.plot(     ns, srch, color=c, label=f'{param_key}={val}')
        ax_i.set_title(f'Insert time ({param_key} sweep)'); ax_i.set_xlabel('N (log)'); ax_i.set_ylabel('ms'); ax_i.legend(fontsize=7); ax_i.grid(True)
        ax_s.set_title(f'Search time ({param_key} sweep)'); ax_s.set_xlabel('N');       ax_s.set_ylabel('ms'); ax_s.legend(fontsize=7); ax_s.grid(True)

    # Row 1, cols 0-1: recall vs efSearch + speed-recall tradeoff
    ax_recs  = axes[1, 0]
    ax_trade = axes[1, 1]
    if rec_data is not None:
        K = rec_data['meta']['K']
        for i, exp in enumerate(rec_data['experiments']):
            pts     = exp['efSearchPoints']
            ef_vals = np.array([p['efSearch']  for p in pts])
            recalls = np.array([p['recallAtK'] for p in pts])
            means   = np.array([p['meanMs']    for p in pts])
            label   = exp['label'].replace('_', ' ')
            c       = color(i)
            ax_recs.semilogx(ef_vals, recalls, 'o-', color=c, markersize=4, label=label)
            ax_trade.plot(means, recalls, 'o-', color=c, markersize=4, label=label)
        ax_recs.set_title(f'Recall@{K} vs efSearch'); ax_recs.set_xlabel('efSearch (log)'); ax_recs.set_ylabel(f'Recall@{K}'); ax_recs.set_ylim(0, 1.05); ax_recs.legend(fontsize=7); ax_recs.grid(True)
        ax_trade.set_title('Speed – Recall tradeoff'); ax_trade.set_xlabel('Latency (ms)'); ax_trade.set_ylabel(f'Recall@{K}'); ax_trade.set_ylim(0, 1.05); ax_trade.legend(fontsize=7); ax_trade.grid(True)

    # Row 1, cols 2-3: dimension sweep insert + search
    ax_di = axes[1, 2]
    ax_ds = axes[1, 3]
    if dim_data is not None:
        dim_list, ins_finals, srch_finals = [], [], []
        for i, exp in enumerate(dim_data['experiments']):
            dim  = exp['params']['dim']
            c    = color(i)
            ns, ins  = ns_and_metric(exp, 'insertMeanMs')
            ns, srch = ns_and_metric(exp, 'searchMeanMs')
            ax_di.semilogx(ns, ins,  color=c, label=f'dim={dim}')
            ax_ds.plot(     ns, srch, color=c, label=f'dim={dim}')
            dim_list.append(dim)
            ins_finals.append(float(np.mean(ins[-10:])))
            srch_finals.append(float(np.mean(srch[-10:])))
        ax_di.set_title('Insert time (dim sweep)'); ax_di.set_xlabel('N (log)'); ax_di.set_ylabel('ms'); ax_di.legend(fontsize=7); ax_di.grid(True)
        ax_ds.set_title('Search time (dim sweep)'); ax_ds.set_xlabel('N');       ax_ds.set_ylabel('ms'); ax_ds.legend(fontsize=7); ax_ds.grid(True)

    plt.tight_layout()
    save_fig(fig, 'summary_overview.png')

# ─────────────────────────────────────────────────────────────────────────────
# Figure: Experiment 3 — single best-config  (6 panels)
#   Row 0: Recall@K vs N (linear)      | Recall@K vs N (log)
#   Row 1: Insert time vs N (linear)   | Insert time vs N (log)
#   Row 2: Search time vs N (linear)   | Search time vs N (log)
# ─────────────────────────────────────────────────────────────────────────────

def plot_best_config():
    data = load_combined('best_config.json')
    if data is None:
        print('  [skip] best_config.png — no data')
        return

    exp  = data['experiment']
    meta = data['meta']
    fp   = meta['fixedParams']
    K    = fp['K']

    rps  = exp.get('recallPoints', [])
    cps  = exp['checkpoints']

    rns       = np.array([r['n']          for r in rps])
    recall    = np.array([r['recallAtK']  for r in rps])
    ns        = np.array([c['n']          for c in cps])
    ins_mean  = np.array([c['insertMeanMs'] for c in cps])
    ins_p95   = np.array([c['insertP95Ms']  for c in cps])
    srch_mean = np.array([c['searchMeanMs'] for c in cps])
    srch_p95  = np.array([c['searchP95Ms']  for c in cps])

    c0 = color(0)  # single config → one colour

    fig, axes = plt.subplots(3, 2, figsize=(14, 15))
    fig.suptitle(
        f'HNSW Best-Config Benchmark\n'
        f'M={fp["M"]}  efC={fp["efConstruction"]}  efS={fp["efSearch"]}  '
        f'dim={fp["dim"]}  N={fp["N"]:,}  K={K}',
        fontsize=13, fontweight='bold',
    )

    # ── Row 0: Recall ─────────────────────────────────────────────────────────
    ax_r_lin, ax_r_log = axes[0]
    for ax, xs, xlog in [(ax_r_lin, rns, False), (ax_r_log, rns, True)]:
        if xlog:
            ax.semilogx(xs, recall, 'o-', color=c0, markersize=5)
            ax.set_xlabel('Index size  (log scale)')
        else:
            ax.plot(xs, recall, 'o-', color=c0, markersize=5)
            ax.set_xlabel('Index size  (N)')
        ax.set_ylabel(f'Recall@{K}')
        ax.set_ylim(0, 1.05)
        ax.axhline(1.0, color='gray', linestyle=':', linewidth=1, label='Recall = 1.0')
        ax.legend(fontsize=8)
        ax.grid(True)
    ax_r_lin.set_title(f'Recall@{K} vs N  (linear)')
    ax_r_log.set_title(f'Recall@{K} vs N  (log)')

    # ── Row 1: Insert time ────────────────────────────────────────────────────
    ax_i_lin, ax_i_log = axes[1]
    for ax, xlog in [(ax_i_lin, False), (ax_i_log, True)]:
        plot_fn = ax.semilogx if xlog else ax.plot
        plot_fn(ns, ins_mean, color=c0, label='mean')
        ax.fill_between(ns, ins_mean, ins_p95, alpha=0.15, color=c0, label='mean–P95 band')
        ax.set_ylabel('Insert latency  (ms)')
        ax.set_xlabel('Index size  (log scale)' if xlog else 'Index size  (N)')
        ax.legend(fontsize=8)
        ax.grid(True)
    ax_i_lin.set_title('Insert latency vs N  (linear)')
    ax_i_log.set_title('Insert latency vs N  (log)')

    # ── Row 2: Search time ────────────────────────────────────────────────────
    ax_s_lin, ax_s_log = axes[2]
    for ax, xlog in [(ax_s_lin, False), (ax_s_log, True)]:
        plot_fn = ax.semilogx if xlog else ax.plot
        plot_fn(ns, srch_mean, color=c0, label='mean')
        ax.fill_between(ns, srch_mean, srch_p95, alpha=0.15, color=c0, label='mean–P95 band')
        ax.set_ylabel('Search latency  (ms)')
        ax.set_xlabel('Index size  (log scale)' if xlog else 'Index size  (N)')
        ax.legend(fontsize=8)
        ax.grid(True)
    ax_s_lin.set_title(f'k-NN search latency vs N  (linear,  k={K})')
    ax_s_log.set_title(f'k-NN search latency vs N  (log,  k={K})')

    plt.tight_layout()
    save_fig(fig, 'best_config.png')

# ─────────────────────────────────────────────────────────────────────────────
# Figure: Experiment 5 — SIFT-1M benchmark  (recall-vs-QPS, the HNSW paper chart)
#   Panel 1: Recall@K vs efSearch (log x) — per M value
#   Panel 2: Recall@K vs QPS (log x)      — speed-recall tradeoff
#   Panel 3: Insert latency vs N          — build cost
# ─────────────────────────────────────────────────────────────────────────────

def plot_sift_benchmark():
    data = load_combined('sift_benchmark.json')
    if data is None:
        print('  [skip] sift_benchmark.png — no data')
        return

    meta = data['meta']
    K    = meta['K']
    exps = data['experiments']

    fig, axes = plt.subplots(1, 3, figsize=(20, 6))
    fig.suptitle(
        f'HNSW on SIFT-1M  (128D, {meta["baseVectors"]:,} vectors, '
        f'{meta["queryVectors"]:,} queries, K={K})\n'
        f'Pre-computed ground truth — same dataset as Malkov & Yashunin (2018)',
        fontsize=12, fontweight='bold',
    )

    ax_recall, ax_qps, ax_build = axes

    for i, exp in enumerate(exps):
        M     = exp['M']
        label = f'M={M}, efC={exp["efConstruction"]}'
        c     = color(i)

        pts     = exp['efSearchSweep']
        ef_vals = np.array([p['efSearch']  for p in pts])
        recalls = np.array([p['recallAtK'] for p in pts])
        qps     = np.array([p['qps']       for p in pts])
        means   = np.array([p['meanMs']    for p in pts])

        # Panel 1: Recall vs efSearch
        ax_recall.semilogx(ef_vals, recalls, 'o-', color=c, markersize=5, label=label)

        # Panel 2: Recall vs QPS (the canonical HNSW paper figure)
        ax_qps.plot(qps, recalls, 'o-', color=c, markersize=5, label=label)
        # Annotate selected efSearch values
        for j in range(0, len(pts), max(1, len(pts) // 4)):
            ax_qps.annotate(
                f'ef={pts[j]["efSearch"]}',
                (qps[j], recalls[j]),
                textcoords='offset points', xytext=(4, -8),
                fontsize=7, color=c,
            )

        # Panel 3: insert latency vs N
        ics = exp['insertCheckpoints']
        ins_ns   = np.array([cp['n']            for cp in ics])
        ins_mean = np.array([cp['insertMeanMs'] for cp in ics])
        ins_p95  = np.array([cp['insertP95Ms']  for cp in ics])
        ax_build.semilogx(ins_ns, ins_mean, color=c, label=f'{label} mean')
        ax_build.fill_between(ins_ns, ins_mean, ins_p95, alpha=0.12, color=c)

    ax_recall.set_xlabel('efSearch  (log scale)')
    ax_recall.set_ylabel(f'Recall@{K}')
    ax_recall.set_title(f'Recall@{K} vs efSearch')
    ax_recall.set_ylim(0, 1.05)
    ax_recall.axhline(1.0, color='gray', linestyle=':', linewidth=1)
    ax_recall.legend()
    ax_recall.grid(True)

    ax_qps.set_xlabel('Queries per second  (QPS)')
    ax_qps.set_ylabel(f'Recall@{K}')
    ax_qps.set_title('Speed–Recall tradeoff  (higher-right = better)')
    ax_qps.set_xscale('log')
    ax_qps.set_ylim(0, 1.05)
    ax_qps.axhline(1.0, color='gray', linestyle=':', linewidth=1)
    ax_qps.legend()
    ax_qps.grid(True)

    ax_build.set_xlabel('Index size  (log scale)')
    ax_build.set_ylabel('Insert latency  (ms)')
    ax_build.set_title('Insert latency vs N  (SIFT-1M)')
    ax_build.legend()
    ax_build.grid(True)

    plt.tight_layout()
    save_fig(fig, 'sift_benchmark.png')

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    print('\n── HNSW Scientific Benchmark Plotter ───────────────────────────────')
    print(f'   Results dir : {RESULTS_DIR}')
    print(f'   Images dir  : {IMAGES_DIR}')
    print()

    print('1/7  M sweep performance plots...')
    plot_perf_sweep(load_combined('m_sweep_combined.json'), 'M', 'm_sweep.png')

    print('2/7  efConstruction sweep performance plots...')
    plot_perf_sweep(load_combined('efc_sweep_combined.json'), 'efConstruction', 'efc_sweep.png')

    print('3/7  O(log N) ratio plot...')
    plot_logn_ratio_combined()

    print('4/7  Recall@K at small N...')
    plot_recall_small_n()

    print('5/7  Recall vs efSearch...')
    plot_recall_vs_efsearch()

    print('6/7  Speed–recall tradeoff (combined)...')
    plot_recall_speed_combined()

    print('7/7  Dimension sweep...')
    plot_dim_sweep()

    print('8/8  Best-config (Experiment 3)...')
    plot_best_config()

    print('9/9  SIFT-1M benchmark (Experiment 5)...')
    plot_sift_benchmark()

    print('\nBonus: Summary overview figure...')
    plot_summary()

    print('\n── All plots saved ─────────────────────────────────────────────────')
    for f in sorted(glob.glob(IMAGES_DIR + '*.png')):
        print(f'   {f}')


if __name__ == '__main__':
    main()
