import json
import math
import os
from pathlib import Path

import matplotlib.pyplot as plt


BASE = Path("benchmarks/hnsw")
RESULTS = BASE / "results"
IMAGES = RESULTS / "images"
INPUT = Path(os.environ.get("HNSW_COMPLEXITY_INPUT", str(RESULTS / "complexity_sift1m.json")))


def fit_linear(xs, ys):
    n = len(xs)
    if n == 0:
        raise ValueError("No data points available for fitting.")
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    numer = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    denom = sum((x - mean_x) ** 2 for x in xs)
    slope = numer / denom if denom else 0.0
    intercept = mean_y - slope * mean_x
    return slope, intercept


def save_single_plot(output_path, xs, ys, title, ylabel, semilogx=True):
    fig, ax = plt.subplots(figsize=(9, 5))
    if semilogx:
        ax.semilogx(xs, ys, marker="", linewidth=1.8)
    else:
        ax.plot(xs, ys, marker="", linewidth=1.8)
    ax.set_xlabel("Database size N")
    ax.set_ylabel(ylabel)
    ax.set_title(title)
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(output_path, dpi=180)
    plt.close(fig)


def with_subtitle(title, subtitle):
    if not subtitle:
        return title
    return f"{title}\n{subtitle}"


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
    for key in ("M", "efConstruction", "efSearch", "maxStoredLevel", "K"):
        value = meta.get(key)
        if value is not None:
            items.append(f"{key}={value}")
    return " | ".join(items)


def main():
    IMAGES.mkdir(parents=True, exist_ok=True)
    if not INPUT.exists():
        raise FileNotFoundError(f"Missing benchmark result: {INPUT}")

    with INPUT.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)

    checkpoints = payload["checkpoints"]
    if not checkpoints:
        raise ValueError("Complexity benchmark contains no checkpoints.")

    meta = payload.get("meta", {})
    system_name = meta.get("system", "HNSWIndex")
    dataset_name = format_dataset_label(meta)
    params_label = format_hnsw_params(meta)
    default_outputs = INPUT.name == "complexity_sift1m.json"

    if default_outputs:
        output_prefix = ""
    else:
        output_prefix = f"{INPUT.stem}_"

    plot_subtitle = " | ".join(part for part in (dataset_name, params_label) if part)
    title_prefix = with_subtitle(f"{system_name} complexity on {dataset_name}", params_label)

    xs = [point["indexSize"] for point in checkpoints]
    insert_ms = [point["insertMeanMs"] for point in checkpoints]
    search_ms = [point["searchMeanMs"] for point in checkpoints]
    log_xs = [math.log2(max(2, x)) for x in xs]

    insert_ratio = [value / log_n for value, log_n in zip(insert_ms, log_xs)]
    search_ratio = [value / log_n for value, log_n in zip(search_ms, log_xs)]

    insert_slope, insert_intercept = fit_linear(log_xs, insert_ms)
    search_slope, search_intercept = fit_linear(log_xs, search_ms)

    overview, axes = plt.subplots(2, 2, figsize=(14, 10))

    axes[0, 0].semilogx(xs, insert_ms, marker="", linewidth=1.8)
    axes[0, 0].set_title("Insert time vs database size")
    axes[0, 0].set_xlabel("Database size N")
    axes[0, 0].set_ylabel("Milliseconds per insert")

    axes[0, 1].plot(xs, insert_ratio, marker="", linewidth=1.8)
    axes[0, 1].set_title("Insert time / log2(N)")
    axes[0, 1].set_xlabel("Database size N")
    axes[0, 1].set_ylabel("Milliseconds per insert / log2(N)")

    axes[1, 0].semilogx(xs, search_ms, marker="", linewidth=1.8)
    axes[1, 0].set_title("Search time vs database size")
    axes[1, 0].set_xlabel("Database size N")
    axes[1, 0].set_ylabel("Milliseconds per query")

    axes[1, 1].plot(xs, search_ratio, marker="", linewidth=1.8)
    axes[1, 1].set_title("Search time / log2(N)")
    axes[1, 1].set_xlabel("Database size N")
    axes[1, 1].set_ylabel("Milliseconds per query / log2(N)")

    for ax in axes.flat:
      ax.grid(True, alpha=0.3)

    overview.suptitle(title_prefix, fontsize=14)
    overview.tight_layout(rect=(0, 0, 1, 0.95))
    overview.savefig(IMAGES / f"{output_prefix}complexity_overview.png", dpi=180)
    plt.close(overview)

    save_single_plot(
        IMAGES / f"{output_prefix}insert_vs_db_size.png",
        xs,
        insert_ms,
        with_subtitle(f"Insert time vs database size ({system_name})", plot_subtitle),
        "Milliseconds per insert",
        semilogx=True,
    )
    save_single_plot(
        IMAGES / f"{output_prefix}insert_div_log2n.png",
        xs,
        insert_ratio,
        with_subtitle(f"Insert time / log2(N) ({system_name})", plot_subtitle),
        "Milliseconds per insert / log2(N)",
        semilogx=False,
    )
    save_single_plot(
        IMAGES / f"{output_prefix}search_vs_db_size.png",
        xs,
        search_ms,
        with_subtitle(f"Search time vs database size ({system_name})", plot_subtitle),
        "Milliseconds per query",
        semilogx=True,
    )
    save_single_plot(
        IMAGES / f"{output_prefix}search_div_log2n.png",
        xs,
        search_ratio,
        with_subtitle(f"Search time / log2(N) ({system_name})", plot_subtitle),
        "Milliseconds per query / log2(N)",
        semilogx=False,
    )

    print(f"Saved complexity plots to {IMAGES}")
    print(f"Insert fit:  y = {insert_slope:.6f} * log2(N) + {insert_intercept:.6f}")
    print(f"Search fit:  y = {search_slope:.6f} * log2(N) + {search_intercept:.6f}")


if __name__ == "__main__":
    main()