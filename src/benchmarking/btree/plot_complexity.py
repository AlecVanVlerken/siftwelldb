"""
B+ Tree complexity benchmark plotter.

Reads the JSON output from complexity.spec.mts and produces a 2×2 overview
figure (same layout as the HNSW complexity plot) plus four individual plots:

  - insert_vs_db_size.png       : insert time vs N  (semilog-x)
  - insert_div_log2n.png        : insert time / log2(N) vs N
  - search_vs_db_size.png       : search time vs N  (semilog-x)
  - search_div_log2n.png        : search time / log2(N) vs N
  - complexity_overview.png     : 2×2 grid of the above

Input JSON path can be overridden via the environment variable
BTREE_COMPLEXITY_INPUT.

Usage:
    python src/benchmarking/btree/plot_complexity.py
"""

import json
import math
import os
from pathlib import Path
from statistics import quantiles

import matplotlib.pyplot as plt

BASE = Path("src/benchmarking/btree")
RESULTS = BASE / "results"
IMAGES = RESULTS / "images"
INPUT = Path(os.environ.get("BTREE_COMPLEXITY_INPUT", str(RESULTS / "complexity_btree.json")))
MAX_PLOT_INDEX_SIZE = 12_000_000
POINT_SIZE = 10
RATIO_REFERENCE_Y = 0.00075
RATIO_REFERENCE_COLOR = "red"
RATIO_REFERENCE_WIDTH = 2.8


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def fit_linear(xs, ys):
    n = len(xs)
    if n == 0:
        raise ValueError("No data points for fitting.")
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    numer = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    denom = sum((x - mean_x) ** 2 for x in xs)
    slope = numer / denom if denom else 0.0
    intercept = mean_y - slope * mean_x
    return slope, intercept


def save_single_plot(output_path, xs, ys, title, ylabel, semilogx=True, reference_y=None):
    fig, ax = plt.subplots(figsize=(9, 5))
    if semilogx:
        ax.set_xscale("log")
    ax.scatter(xs, ys, s=POINT_SIZE)
    if reference_y is not None:
        ax.axhline(reference_y, color=RATIO_REFERENCE_COLOR, linestyle="--", linewidth=RATIO_REFERENCE_WIDTH)
    ax.set_xlabel("Database size N")
    ax.set_ylabel(ylabel)
    ax.set_title(title)
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(output_path, dpi=180)
    plt.close(fig)
    print(f"  Saved {output_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    IMAGES.mkdir(parents=True, exist_ok=True)

    if not INPUT.exists():
        raise FileNotFoundError(
            f"Missing benchmark result: {INPUT}\n"
            "Run the complexity.spec.mts benchmark first."
        )

    with INPUT.open("r", encoding="utf-8") as fh:
        payload = json.load(fh)

    checkpoints = [
        checkpoint
        for checkpoint in payload["checkpoints"]
        if checkpoint["indexSize"] <= MAX_PLOT_INDEX_SIZE
    ]
    if not checkpoints:
        raise ValueError("Benchmark result contains no checkpoints.")

    meta = payload.get("meta", {})
    system_name = meta.get("system", "BPlusTree")
    block_size = meta.get("blockSize")
    params_label = f"blockSize={block_size}" if block_size else ""

    xs = [p["indexSize"] for p in checkpoints]
    insert_ms = [p["insertMeanMs"] for p in checkpoints]
    search_ms = [p["searchMeanMs"] for p in checkpoints]
    log_xs = [math.log2(max(2, x)) for x in xs]

    insert_ratio = [v / ln for v, ln in zip(insert_ms, log_xs)]
    search_ratio = [v / ln for v, ln in zip(search_ms, log_xs)]

    def clip_p99(series):
        """Replace values above the 99th percentile with nan (outlier removal)."""
        qs = quantiles(series, n=100)
        cap = qs[98]  # index 98 = 99th percentile (0-indexed in a 100-quantile list)
        return [v if v <= cap else float("nan") for v in series]

    insert_ms    = clip_p99(insert_ms)
    search_ms    = clip_p99(search_ms)
    insert_ratio = clip_p99(insert_ratio)
    search_ratio = clip_p99(search_ratio)

    title_prefix = system_name
    if params_label:
        title_prefix = f"{system_name}\n{params_label}"

    # ------------------------------------------------------------------
    # 2×2 overview figure
    # ------------------------------------------------------------------
    overview, axes = plt.subplots(2, 2, figsize=(14, 10))

    axes[0, 0].set_xscale("log")
    axes[0, 0].scatter(xs, insert_ms, s=POINT_SIZE)
    axes[0, 0].set_title("Insert time vs database size")
    axes[0, 0].set_xlabel("Database size N")
    axes[0, 0].set_ylabel("Milliseconds per insert")
    axes[0, 0].grid(True, alpha=0.3)

    axes[0, 1].scatter(xs, insert_ratio, s=POINT_SIZE)
    axes[0, 1].axhline(RATIO_REFERENCE_Y, color=RATIO_REFERENCE_COLOR, linestyle="--", linewidth=RATIO_REFERENCE_WIDTH)
    axes[0, 1].set_title("Insert time / log₂(N)")
    axes[0, 1].set_xlabel("Database size N")
    axes[0, 1].set_ylabel("ms per insert / log₂(N)")
    axes[0, 1].grid(True, alpha=0.3)

    axes[1, 0].set_xscale("log")
    axes[1, 0].scatter(xs, search_ms, s=POINT_SIZE)
    axes[1, 0].set_title("Search time vs database size")
    axes[1, 0].set_xlabel("Database size N")
    axes[1, 0].set_ylabel("Milliseconds per query")
    axes[1, 0].grid(True, alpha=0.3)

    axes[1, 1].scatter(xs, search_ratio, s=POINT_SIZE)
    axes[1, 1].axhline(RATIO_REFERENCE_Y, color=RATIO_REFERENCE_COLOR, linestyle="--", linewidth=RATIO_REFERENCE_WIDTH)
    axes[1, 1].set_title("Search time / log₂(N)")
    axes[1, 1].set_xlabel("Database size N")
    axes[1, 1].set_ylabel("ms per query / log₂(N)")
    axes[1, 1].grid(True, alpha=0.3)

    overview.suptitle(title_prefix, fontsize=14)
    overview.tight_layout(rect=(0, 0, 1, 0.95))
    overview_path = IMAGES / "complexity_overview.png"
    overview.savefig(overview_path, dpi=180)
    plt.close(overview)
    print(f"  Saved {overview_path}")

    # ------------------------------------------------------------------
    # 1×2 ratio figure
    # ------------------------------------------------------------------
    ratio_overview, ratio_axes = plt.subplots(1, 2, figsize=(14, 5))

    ratio_axes[0].scatter(xs, insert_ratio, s=POINT_SIZE)
    ratio_axes[0].axhline(RATIO_REFERENCE_Y, color=RATIO_REFERENCE_COLOR, linestyle="--", linewidth=RATIO_REFERENCE_WIDTH)
    ratio_axes[0].set_title("Insert time / log₂(N)")
    ratio_axes[0].set_xlabel("Database size N")
    ratio_axes[0].set_ylabel("ms per insert / log₂(N)")
    ratio_axes[0].grid(True, alpha=0.3)

    ratio_axes[1].scatter(xs, search_ratio, s=POINT_SIZE)
    ratio_axes[1].axhline(RATIO_REFERENCE_Y, color=RATIO_REFERENCE_COLOR, linestyle="--", linewidth=RATIO_REFERENCE_WIDTH)
    ratio_axes[1].set_title("Search time / log₂(N)")
    ratio_axes[1].set_xlabel("Database size N")
    ratio_axes[1].set_ylabel("ms per query / log₂(N)")
    ratio_axes[1].grid(True, alpha=0.3)

    ratio_overview.suptitle(f"{title_prefix}\nlog-scaled complexity views", fontsize=14)
    ratio_overview.tight_layout(rect=(0, 0, 1, 0.95))
    ratio_overview_path = IMAGES / "complexity_log_overview.png"
    ratio_overview.savefig(ratio_overview_path, dpi=180)
    plt.close(ratio_overview)
    print(f"  Saved {ratio_overview_path}")

    # ------------------------------------------------------------------
    # Individual plots
    # ------------------------------------------------------------------
    save_single_plot(
        IMAGES / "insert_vs_db_size.png",
        xs, insert_ms,
        f"Insert time vs database size ({system_name})",
        "Milliseconds per insert",
        semilogx=True,
    )
    save_single_plot(
        IMAGES / "insert_div_log2n.png",
        xs, insert_ratio,
        f"Insert time / log₂(N) ({system_name})",
        "ms per insert / log₂(N)",
        semilogx=False,
        reference_y=RATIO_REFERENCE_Y,
    )
    save_single_plot(
        IMAGES / "search_vs_db_size.png",
        xs, search_ms,
        f"Search time vs database size ({system_name})",
        "Milliseconds per query",
        semilogx=True,
    )
    save_single_plot(
        IMAGES / "search_div_log2n.png",
        xs, search_ratio,
        f"Search time / log₂(N) ({system_name})",
        "ms per query / log₂(N)",
        semilogx=False,
        reference_y=RATIO_REFERENCE_Y,
    )

    print("Done.")


if __name__ == "__main__":
    main()
