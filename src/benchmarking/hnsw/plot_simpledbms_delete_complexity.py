from __future__ import annotations

import csv
import math
from pathlib import Path
from typing import Iterable

import matplotlib.pyplot as plt


BASE_DIR = Path("src") / "benchmarking" / "hnsw"
RESULTS_DIR = BASE_DIR / "results"
IMAGES_DIR = RESULTS_DIR / "images"
CSV_PATH = RESULTS_DIR / "simpledbms_delete_complexity.csv"


def read_rows() -> list[dict[str, float]]:
    if not CSV_PATH.exists():
        raise SystemExit(f"Missing benchmark CSV: {CSV_PATH}")

    rows: list[dict[str, float]] = []
    with CSV_PATH.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            parsed: dict[str, float] = {}
            for key, value in row.items():
                parsed[key] = float(value) if value not in (None, "") else math.nan
            rows.append(parsed)

    if not rows:
        raise SystemExit(f"Benchmark CSV has no rows: {CSV_PATH}")

    return sorted(rows, key=lambda row: row["collectionSize"])


def column(rows: Iterable[dict[str, float]], name: str) -> list[float]:
    return [row[name] for row in rows]


def save_line_plot(
    rows: list[dict[str, float]],
    output_name: str,
    y_column: str,
    title: str,
    y_label: str,
    *,
    extra_columns: list[tuple[str, str]] | None = None,
) -> Path:
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    sizes = column(rows, "collectionSize")

    fig, ax = plt.subplots(figsize=(9, 5.2))
    ax.plot(sizes, column(rows, y_column), marker="o", linewidth=2.2, label=y_label)
    for extra_column, label in extra_columns or []:
        ax.plot(sizes, column(rows, extra_column), marker="o", linewidth=1.6, linestyle="--", label=label)

    ax.set_xscale("log")
    ax.set_xlabel("Collection size (documents)")
    ax.set_ylabel(y_label)
    ax.set_title(title)
    ax.grid(True, which="both", linestyle=":", linewidth=0.8, alpha=0.65)
    ax.legend()
    fig.tight_layout()

    output_path = IMAGES_DIR / output_name
    fig.savefig(output_path, dpi=160)
    plt.close(fig)
    return output_path


def save_overview(rows: list[dict[str, float]]) -> Path:
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    sizes = column(rows, "collectionSize")

    fig, axes = plt.subplots(2, 2, figsize=(12, 8.5))
    panels = [
        (axes[0][0], "avgDeleteMs", "Average public delete call", "ms"),
        (axes[0][1], "avgDeleteDivLog2N", "Average delete / log2(N)", "ms / log2(N)"),
        (axes[1][0], "avgDeleteDivN", "Average delete / N", "ms / document"),
        (axes[1][1], "avgDurableDeleteMs", "Average delete + commit", "ms"),
    ]

    for ax, y_column, title, y_label in panels:
        ax.plot(sizes, column(rows, y_column), marker="o", linewidth=2.0)
        ax.set_xscale("log")
        ax.set_xlabel("Collection size")
        ax.set_ylabel(y_label)
        ax.set_title(title)
        ax.grid(True, which="both", linestyle=":", linewidth=0.8, alpha=0.65)

    fig.tight_layout()
    output_path = IMAGES_DIR / "simpledbms_delete_complexity_overview.png"
    fig.savefig(output_path, dpi=160)
    plt.close(fig)
    return output_path


def main() -> None:
    rows = read_rows()

    outputs = [
        save_line_plot(
            rows,
            "simpledbms_delete_avg.png",
            "avgDeleteMs",
            "SimpleDbms public HNSW delete time",
            "Average deleteDocumentById time (ms)",
            extra_columns=[("p50DeleteMs", "p50 delete ms"), ("p95DeleteMs", "p95 delete ms")],
        ),
        save_line_plot(
            rows,
            "simpledbms_delete_avg_div_log2n.png",
            "avgDeleteDivLog2N",
            "Delete time normalized by log2(N)",
            "Average delete ms / log2(N)",
        ),
        save_line_plot(
            rows,
            "simpledbms_delete_avg_div_n.png",
            "avgDeleteDivN",
            "Delete time normalized by N",
            "Average delete ms / N",
        ),
        save_line_plot(
            rows,
            "simpledbms_delete_durable_avg.png",
            "avgDurableDeleteMs",
            "SimpleDbms HNSW delete plus commit time",
            "Average delete + commit time (ms)",
        ),
        save_overview(rows),
    ]

    for output in outputs:
        print(output)


if __name__ == "__main__":
    main()
