import json
from pathlib import Path

import matplotlib.pyplot as plt


BASE = Path("src/benchmarking/hnsw")
RESULTS = BASE / "results"
IMAGES = RESULTS / "images"
INPUTS = [
    RESULTS / "recall_sift1m.json",
    RESULTS / "recall_gist1m.json",
    RESULTS / "recall_random_1m_128d.json",
]

COLORS = {
    "SIFT1M": "#1b5e20",
    "GIST1M": "#0d47a1",
    "Random 1M 128D": "#b71c1c",
}


def format_dataset_label(meta):
    dataset = meta.get("dataset", "Unknown")
    dimension = meta.get("dimension")
    if dimension is None:
        return dataset

    dimension_suffix = f" {dimension}D"
    if dataset.endswith(dimension_suffix):
        return dataset
    return f"{dataset}{dimension_suffix}"


def with_subtitle(title, subtitle):
    if not subtitle:
        return title
    return f"{title}\n{subtitle}"


def format_hnsw_params(meta):
    items = []
    for key in ("M", "efConstruction", "maxStoredLevel", "K"):
        value = meta.get(key)
        if value is not None:
            items.append(f"{key}={value}")
    return " | ".join(items)


def shared_hnsw_params(results):
    if not results:
        return ""

    shared_meta = {}
    for key in ("M", "efConstruction", "maxStoredLevel", "K"):
        value = results[0]["meta"].get(key)
        if value is None:
            continue
        if all(result["meta"].get(key) == value for result in results[1:]):
            shared_meta[key] = value
    return format_hnsw_params(shared_meta)


def load_results():
    results = []
    for file_path in INPUTS:
        if not file_path.exists():
            continue
        with file_path.open("r", encoding="utf-8") as handle:
            results.append(json.load(handle))
    if not results:
        missing = "\n".join(str(path) for path in INPUTS)
        raise FileNotFoundError(f"No recall results found. Expected one or more of:\n{missing}")
    return results


def dataset_name(result):
    return result["meta"]["dataset"]


def dataset_label(result):
    return format_dataset_label(result["meta"])


def plot_recall_vs_ef_search(results):
    fig, axes = plt.subplots(1, len(results), figsize=(5 * len(results), 4.5), squeeze=False)
    axes = axes[0]

    for ax, result in zip(axes, results):
        name = dataset_name(result)
        label = dataset_label(result)
        params_label = format_hnsw_params(result["meta"])
        points = result["points"]
        xs = [point["efSearch"] for point in points]
        ys = [point["recallAtK"] for point in points]
        ax.plot(xs, ys, marker="o", linewidth=1.8, color=COLORS.get(name, "#333333"))
        ax.set_xscale("log", base=2)
        ax.set_ylim(0.0, 1.02)
        ax.set_title(with_subtitle(label, params_label))
        ax.set_xlabel("efSearch")
        ax.set_ylabel("Recall@10")
        ax.grid(True, alpha=0.3)

    fig.suptitle("Recall@10 vs efSearch")
    fig.tight_layout(rect=(0, 0, 1, 0.92))
    fig.savefig(IMAGES / "recall_vs_ef_search.png", dpi=180)
    plt.close(fig)


def plot_recall_vs_ef_search_combined(results):
    fig, ax = plt.subplots(figsize=(8, 5))
    params_label = shared_hnsw_params(results)

    for result in results:
        name = dataset_name(result)
        label = dataset_label(result)
        points = result["points"]
        xs = [point["efSearch"] for point in points]
        ys = [point["recallAtK"] for point in points]
        ax.plot(xs, ys, marker="o", linewidth=1.8, label=label, color=COLORS.get(name, "#333333"))

    ax.set_xscale("log", base=2)
    ax.set_ylim(0.0, 1.02)
    ax.set_xlabel("efSearch")
    ax.set_ylabel("Recall@10")
    ax.set_title(with_subtitle("Recall@10 vs efSearch", params_label))
    ax.grid(True, alpha=0.3)
    ax.legend()

    fig.tight_layout()
    fig.savefig(IMAGES / "recall_vs_ef_search_combined.png", dpi=180)
    plt.close(fig)


def main():
    IMAGES.mkdir(parents=True, exist_ok=True)
    results = load_results()
    plot_recall_vs_ef_search(results)
    plot_recall_vs_ef_search_combined(results)

    print(f"Saved recall plots to {IMAGES}")
    for result in results:
        name = dataset_label(result)
        best_point = max(result["points"], key=lambda point: point["recallAtK"])
        print(
            f"{name}: best recall@10={best_point['recallAtK']:.4f} "
            f"at efSearch={best_point['efSearch']} with mean latency={best_point['meanMs']:.4f} ms"
        )


if __name__ == "__main__":
    main()