"""
DBMS insert overhead plotter.

Reads the JSON output from insert_overhead.spec.mts and produces a single
combined plot showing insert time vs database size for:

  - B+ tree only       (no HNSW semantic index)
    - B+ tree + HNSW     (vectors encoded with the configured semantic encoder)

Input JSON path can be overridden via the environment variable
DBMS_OVERHEAD_INPUT.

Usage:
    python benchmarks/dbms/plot_insert_overhead.py
"""

import json
import math
import os
from pathlib import Path

import matplotlib.pyplot as plt

BASE = Path("benchmarks/dbms")
RESULTS = BASE / "results"
IMAGES = RESULTS / "images"
INPUT = Path(os.environ.get("DBMS_OVERHEAD_INPUT", str(RESULTS / "insert_overhead.json")))
POINT_SIZE = 18


def main():
    IMAGES.mkdir(parents=True, exist_ok=True)

    if not INPUT.exists():
        raise FileNotFoundError(
            f"Missing benchmark result: {INPUT}\n"
            "Run the insert_overhead.spec.mts benchmark first."
        )

    with INPUT.open("r", encoding="utf-8") as fh:
        payload = json.load(fh)

    meta = payload.get("meta", {})
    btree_points = payload["btreeOnly"]
    hnsw_points = payload["btreeHnsw"]

    if not btree_points or not hnsw_points:
        raise ValueError("Benchmark result is missing checkpoint data.")

    xs_btree = [p["indexSize"] for p in btree_points]
    ys_btree = [p["insertMeanMs"] for p in btree_points]

    xs_hnsw = [p["indexSize"] for p in hnsw_points]
    ys_hnsw = [p["insertMeanMs"] for p in hnsw_points]

    ys_btree_div_log = [y / math.log2(max(2, x)) for x, y in zip(xs_btree, ys_btree)]
    ys_hnsw_div_log = [y / math.log2(max(2, x)) for x, y in zip(xs_hnsw, ys_hnsw)]

    encoder = meta.get("hnswEncoder") or meta.get("hnswModel", "semantic encoder")
    dimension = meta.get("hnswDimension")
    hnsw_m = meta.get("hnswM")
    ef = meta.get("hnswEfConstruction")

    hnsw_parts = [encoder]
    if dimension is not None:
        hnsw_parts.append(f"{dimension}D")
    if hnsw_m is not None:
        hnsw_parts.append(f"M={hnsw_m}")
    if ef is not None:
        hnsw_parts.append(f"ef={ef}")

    hnsw_label = f"B+ tree + HNSW ({', '.join(hnsw_parts)})"
    btree_label = "B+ tree only (no HNSW)"

    # ------------------------------------------------------------------
    # Combined plot (semilog-x, point-only)
    # ------------------------------------------------------------------
    fig, ax = plt.subplots(figsize=(12, 6))

    ax.set_xscale("log")
    ax.scatter(xs_btree, ys_btree, s=POINT_SIZE, label=btree_label, color="steelblue")
    ax.scatter(xs_hnsw, ys_hnsw, s=POINT_SIZE, label=hnsw_label, color="darkorange")

    ax.set_xlabel("Database size N (number of documents)")
    ax.set_ylabel("Mean insert time (ms)")
    ax.set_title("Insert time vs database size\nB+ tree only vs B+ tree + HNSW")
    ax.legend()
    ax.grid(True, alpha=0.3)

    fig.tight_layout()
    out_path = IMAGES / "insert_overhead.png"
    fig.savefig(out_path, dpi=180)
    plt.close(fig)
    print(f"Saved {out_path}")

    # ------------------------------------------------------------------
    # Insert time / log2(N) plot (normal/normal, point-only)
    # ------------------------------------------------------------------
    fig_log, ax_log = plt.subplots(figsize=(12, 6))

    ax_log.scatter(xs_btree, ys_btree_div_log, s=POINT_SIZE, label=btree_label, color="steelblue")
    ax_log.scatter(xs_hnsw, ys_hnsw_div_log, s=POINT_SIZE, label=hnsw_label, color="darkorange")

    ax_log.set_xlabel("Database size N (number of documents)")
    ax_log.set_ylabel("Mean insert time / log₂(N)")
    ax_log.set_title("Insert time / log₂(N) vs database size\nB+ tree only vs B+ tree + HNSW")
    ax_log.legend()
    ax_log.grid(True, alpha=0.3)

    fig_log.tight_layout()
    log_path = IMAGES / "insert_overhead_div_log2n.png"
    fig_log.savefig(log_path, dpi=180)
    plt.close(fig_log)
    print(f"Saved {log_path}")

    # ------------------------------------------------------------------
    # Overhead ratio plot: (HNSW insert time) / (btree insert time)
    # ------------------------------------------------------------------
    # Align series on common checkpoint sizes
    btree_map = {p["indexSize"]: p["insertMeanMs"] for p in btree_points}
    hnsw_map = {p["indexSize"]: p["insertMeanMs"] for p in hnsw_points}
    common_sizes = sorted(set(btree_map) & set(hnsw_map))

    if common_sizes:
        ratio_xs = common_sizes
        ratio_ys = [
            hnsw_map[n] / btree_map[n] if btree_map[n] > 0 else float("nan")
            for n in common_sizes
        ]

        fig2, ax2 = plt.subplots(figsize=(12, 5))
        ax2.scatter(ratio_xs, ratio_ys, s=POINT_SIZE, color="mediumpurple")
        ax2.axhline(y=1.0, color="gray", linestyle="--", linewidth=1.0, label="Ratio = 1 (no overhead)")
        ax2.set_xlabel("Database size N (number of documents)")
        ax2.set_ylabel("HNSW insert time / B+ tree insert time")
        ax2.set_title("HNSW index overhead factor vs database size")
        ax2.legend()
        ax2.grid(True, alpha=0.3)
        fig2.tight_layout()
        ratio_path = IMAGES / "insert_overhead_ratio.png"
        fig2.savefig(ratio_path, dpi=180)
        plt.close(fig2)
        print(f"Saved {ratio_path}")

    print("Done.")


if __name__ == "__main__":
    main()
