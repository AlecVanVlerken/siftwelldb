import json
import os
from pathlib import Path

import matplotlib.pyplot as plt


BASE = Path("src/benchmarking/hnsw")
RESULTS = BASE / "results"
IMAGES = RESULTS / "images"
INPUT = Path(os.environ.get("HNSW_INSERT_COMPARE_INPUT", str(RESULTS / "insert_compare_sift.json")))

COLORS = {
    "rust": "#0d47a1",
    "legacy-typescript": "#b71c1c",
}

LABELS = {
    "rust": "Rust HNSWIndex",
    "legacy-typescript": "Legacy TypeScript HNSW",
}


def format_duration_ms(ms):
    total_seconds = max(0.0, ms / 1000.0)
    if total_seconds >= 3600:
        hours = int(total_seconds // 3600)
        minutes = int((total_seconds % 3600) // 60)
        seconds = int(total_seconds % 60)
        return f"{hours}h {minutes:02d}m {seconds:02d}s"
    if total_seconds >= 60:
        minutes = int(total_seconds // 60)
        seconds = int(total_seconds % 60)
        return f"{minutes}m {seconds:02d}s"
    return f"{total_seconds:.2f}s"


def format_dataset_label(meta):
    dataset = meta.get("dataset", "Unknown")
    dimension = meta.get("dimension")
    if dimension is None:
        return dataset

    dimension_suffix = f" {dimension}D"
    if dataset.endswith(dimension_suffix):
        return dataset
    return f"{dataset}{dimension_suffix}"


def format_hnsw_params(meta):
    items = []
    for key in ("M", "efConstruction", "efSearch", "maxStoredLevel"):
        value = meta.get(key)
        if value is not None:
            items.append(f"{key}={value}")
    return " | ".join(items)


def with_subtitle(title, subtitle):
    if not subtitle:
        return title
    return f"{title}\n{subtitle}"


def main():
    IMAGES.mkdir(parents=True, exist_ok=True)
    if not INPUT.exists():
        raise FileNotFoundError(f"Missing insert comparison result: {INPUT}")

    with INPUT.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)

    meta = payload.get("meta", {})
    runs = payload.get("runs", [])
    if not runs:
        raise ValueError("Insert comparison result contains no runs.")

    dataset_name = format_dataset_label(meta)
    params_label = format_hnsw_params(meta)
    legacy_commit = meta.get("legacyBaseCommit")
    summary_lines = []

    fig, ax = plt.subplots(figsize=(9, 5.2))
    for run in runs:
        implementation = run["implementation"]
        checkpoints = run["checkpoints"]
        xs = [point["indexSize"] for point in checkpoints]
        ys = [point["insertMeanMs"] for point in checkpoints]
        label = LABELS.get(implementation, implementation)
        if implementation == "legacy-typescript" and legacy_commit:
            label = f"{label} ({legacy_commit})"
        ax.plot(xs, ys, marker="o", linewidth=1.8, label=label, color=COLORS.get(implementation, "#333333"))
        summary_lines.append(
            f"{label}: pure insert={format_duration_ms(run['totalInsertMs'])}, wall={format_duration_ms(run['totalWallMs'])}"
        )

    ax.set_xlabel("Inserted vectors")
    ax.set_ylabel("Milliseconds per insert")
    ax.set_title(with_subtitle(f"Insert time vs inserted vectors ({dataset_name})", params_label))
    ax.grid(True, alpha=0.3)
    ax.legend()
    ax.text(
        0.02,
        0.02,
        "\n".join(summary_lines),
        transform=ax.transAxes,
        fontsize=8.5,
        va="bottom",
        ha="left",
        bbox={"boxstyle": "round,pad=0.35", "facecolor": "white", "alpha": 0.85, "edgecolor": "#cccccc"},
    )

    fig.tight_layout()
    fig.savefig(IMAGES / "insert_compare_sift.png", dpi=180)
    plt.close(fig)

    print(f"Saved insert comparison plot to {IMAGES / 'insert_compare_sift.png'}")
    for run in runs:
        implementation = run["implementation"]
        label = LABELS.get(implementation, implementation)
        mean_insert = run["totalInsertMs"] / meta["insertCount"] if meta.get("insertCount") else 0
        print(
            f"{label}: mean insert={mean_insert:.4f} ms, "
            f"pure insert={format_duration_ms(run['totalInsertMs'])}, wall={format_duration_ms(run['totalWallMs'])}"
        )


if __name__ == "__main__":
    main()