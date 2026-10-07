import json
import os
from pathlib import Path

import matplotlib.pyplot as plt


BASE = Path("benchmarks/hnsw")
RESULTS = BASE / "results"
IMAGES = RESULTS / "images"
INPUT = Path(os.environ.get("HNSW_DELETE_COMPLEXITY_INPUT", str(RESULTS / "delete_complexity_sift1m.json")))


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
    delete_order = meta.get("deleteOrder")
    if delete_order:
        items.append(f"order={delete_order}")
    return " | ".join(items)


def with_subtitle(title, subtitle):
    if not subtitle:
        return title
    return f"{title}\n{subtitle}"


def save_single_plot(output_path, xs, ys, title, xlabel, ylabel, semilogx=False):
    fig, ax = plt.subplots(figsize=(9, 5))
    if semilogx:
        ax.semilogx(xs, ys, marker="", linewidth=1.8)
    else:
        ax.plot(xs, ys, marker="", linewidth=1.8)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.set_title(title)
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(output_path, dpi=180)
    plt.close(fig)


def point_value(point, *keys, default=0.0):
    for key in keys:
        value = point.get(key)
        if value is not None:
            return value
    return default


def main():
    IMAGES.mkdir(parents=True, exist_ok=True)
    if not INPUT.exists():
      raise FileNotFoundError(f"Missing deletion benchmark result: {INPUT}")

    with INPUT.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)

    checkpoints = payload.get("checkpoints", [])
    if not checkpoints:
        raise ValueError("Deletion benchmark contains no checkpoints.")

    meta = payload.get("meta", {})
    dataset_name = format_dataset_label(meta)
    params_label = format_hnsw_params(meta)
    default_outputs = INPUT.name == "delete_complexity_sift1m.json"
    output_prefix = "" if default_outputs else f"{INPUT.stem}_"

    sorted_points = sorted(checkpoints, key=lambda point: point["liveSizeMean"])
    live_sizes = [point["liveSizeMean"] for point in sorted_points]
    durable_delete_ms = [
        point_value(point, "durableDeleteMeanMs", "deleteMeanMs")
        for point in sorted_points
    ]
    pure_delete_ms = [
        point_value(point, "pureDeleteMeanMs", "deleteMeanMs")
        for point in sorted_points
    ]
    commit_amortized_ms = [
        point_value(point, "commitAmortizedMeanMs", default=max(0.0, point_value(point, "durableDeleteMeanMs", "deleteMeanMs") - point_value(point, "pureDeleteMeanMs", "deleteMeanMs")))
        for point in sorted_points
    ]
    delete_div_live = [
        point_value(point, "durableDeleteMeanMs", "deleteMeanMs") / max(1.0, point["liveSizeMean"])
        for point in sorted_points
    ]

    deleted_counts = [point["deletedCount"] for point in checkpoints]
    pure_delete_elapsed = [point_value(point, "pureDeleteElapsedMs") for point in checkpoints]
    delete_commit_elapsed = [point_value(point, "deleteCommitElapsedMs") for point in checkpoints]
    durable_delete_elapsed = [
        point_value(
            point,
            "durableDeleteElapsedMs",
            default=point_value(point, "pureDeleteElapsedMs") + point_value(point, "deleteCommitElapsedMs"),
        )
        for point in checkpoints
    ]
    wall_delete_elapsed = [point["wallElapsedMs"] for point in checkpoints]

    summary_lines = [
        f"initial build N={meta.get('insertCount', 'unknown')} | checkpoints={len(checkpoints)}",
        f"build pure insert={format_duration_ms(meta.get('buildTotalInsertMs', 0))}",
        f"build wall={format_duration_ms(meta.get('buildWallMs', 0))}",
        f"delete pure={format_duration_ms(meta.get('totalDeleteMs', 0))}",
        f"delete commits={format_duration_ms(meta.get('totalDeleteCommitMs', 0))}",
        f"delete durable={format_duration_ms(meta.get('totalDurableDeleteMs', meta.get('totalDeleteMs', 0)))}",
    ]

    overview, axes = plt.subplots(2, 2, figsize=(14, 10))

    axes[0, 0].semilogx(live_sizes, durable_delete_ms, marker="", linewidth=1.8)
    axes[0, 0].set_title("Durable delete time vs live index size")
    axes[0, 0].set_xlabel("Live index size N")
    axes[0, 0].set_ylabel("Milliseconds per durable delete")

    axes[0, 1].semilogx(live_sizes, pure_delete_ms, marker="", linewidth=1.8)
    axes[0, 1].set_title("Pure tombstone time vs live index size")
    axes[0, 1].set_xlabel("Live index size N")
    axes[0, 1].set_ylabel("Milliseconds per tombstone")

    axes[1, 0].plot(deleted_counts, durable_delete_elapsed, marker="", linewidth=1.8, label="durable")
    axes[1, 0].plot(deleted_counts, pure_delete_elapsed, marker="", linewidth=1.3, label="pure tombstone")
    axes[1, 0].plot(deleted_counts, delete_commit_elapsed, marker="", linewidth=1.3, label="commit")
    axes[1, 0].legend(loc="upper left")
    axes[1, 0].set_title("Cumulative measured delete components")
    axes[1, 0].set_xlabel("Deleted vectors")
    axes[1, 0].set_ylabel("Elapsed (ms)")

    axes[1, 1].plot(deleted_counts, wall_delete_elapsed, marker="", linewidth=1.8)
    axes[1, 1].set_title("Cumulative wall delete time")
    axes[1, 1].set_xlabel("Deleted vectors")
    axes[1, 1].set_ylabel("Wall elapsed (ms)")

    for ax in axes.flat:
        ax.grid(True, alpha=0.3)

    axes[1, 1].text(
        0.98,
        0.02,
        "\n".join(summary_lines),
        transform=axes[1, 1].transAxes,
        fontsize=8.5,
        va="bottom",
        ha="right",
        bbox={"boxstyle": "round,pad=0.35", "facecolor": "white", "alpha": 0.85, "edgecolor": "#cccccc"},
    )

    overview.suptitle(with_subtitle(f"HNSW delete complexity on {dataset_name}", params_label), fontsize=14)
    overview.tight_layout(rect=(0, 0, 1, 0.95))
    overview.savefig(IMAGES / f"{output_prefix}delete_complexity_overview.png", dpi=180)
    plt.close(overview)

    save_single_plot(
        IMAGES / f"{output_prefix}delete_vs_live_size.png",
        live_sizes,
        durable_delete_ms,
        with_subtitle(f"Durable delete time vs live index size ({dataset_name})", params_label),
        "Live index size N",
        "Milliseconds per durable delete",
        semilogx=True,
    )
    save_single_plot(
        IMAGES / f"{output_prefix}delete_pure_vs_live_size.png",
        live_sizes,
        pure_delete_ms,
        with_subtitle(f"Pure tombstone time vs live index size ({dataset_name})", params_label),
        "Live index size N",
        "Milliseconds per tombstone",
        semilogx=True,
    )
    save_single_plot(
        IMAGES / f"{output_prefix}delete_commit_amortized_vs_live_size.png",
        live_sizes,
        commit_amortized_ms,
        with_subtitle(f"Commit-amortized delete time vs live index size ({dataset_name})", params_label),
        "Live index size N",
        "Milliseconds per delete spent committing",
        semilogx=True,
    )
    save_single_plot(
        IMAGES / f"{output_prefix}delete_div_live_size.png",
        live_sizes,
        delete_div_live,
        with_subtitle(f"Durable delete time / N ({dataset_name})", params_label),
        "Live index size N",
        "Milliseconds per durable delete / live vector",
        semilogx=True,
    )
    save_single_plot(
        IMAGES / f"{output_prefix}delete_cumulative_pure.png",
        deleted_counts,
        pure_delete_elapsed,
        with_subtitle(f"Cumulative pure delete time ({dataset_name})", params_label),
        "Deleted vectors",
        "Pure delete elapsed (ms)",
    )
    save_single_plot(
        IMAGES / f"{output_prefix}delete_cumulative_commit.png",
        deleted_counts,
        delete_commit_elapsed,
        with_subtitle(f"Cumulative delete commit time ({dataset_name})", params_label),
        "Deleted vectors",
        "Commit elapsed (ms)",
    )
    save_single_plot(
        IMAGES / f"{output_prefix}delete_cumulative_durable.png",
        deleted_counts,
        durable_delete_elapsed,
        with_subtitle(f"Cumulative durable delete time ({dataset_name})", params_label),
        "Deleted vectors",
        "Durable delete elapsed (ms)",
    )
    save_single_plot(
        IMAGES / f"{output_prefix}delete_cumulative_wall.png",
        deleted_counts,
        wall_delete_elapsed,
        with_subtitle(f"Cumulative wall delete time ({dataset_name})", params_label),
        "Deleted vectors",
        "Wall elapsed (ms)",
    )

    print(f"Saved deletion complexity plots to {IMAGES}")
    print(
        f"Build wall={format_duration_ms(meta.get('buildWallMs', 0))}, "
        f"build pure insert={format_duration_ms(meta.get('buildTotalInsertMs', 0))}, "
        f"delete pure={format_duration_ms(meta.get('totalDeleteMs', 0))}, "
        f"delete commits={format_duration_ms(meta.get('totalDeleteCommitMs', 0))}, "
        f"delete durable={format_duration_ms(meta.get('totalDurableDeleteMs', meta.get('totalDeleteMs', 0)))}"
    )


if __name__ == "__main__":
    main()
