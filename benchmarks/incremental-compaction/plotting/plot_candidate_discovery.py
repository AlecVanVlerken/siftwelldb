"""Plot real-file candidate discovery and actual compaction-step comparisons."""
from __future__ import annotations

import argparse
import csv
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workload", default="records-btree")
    args = parser.parse_args()
    try:
        import matplotlib.pyplot as plt
    except ModuleNotFoundError as exc:
        raise SystemExit("matplotlib is required to plot benchmark results") from exc

    rows = []
    for label in ("before", "after"):
        source = ROOT / "results" / "raw" / f"candidate-discovery-{args.workload}-{label}-summary.csv"
        with source.open(newline="", encoding="utf-8") as handle:
            rows.extend(csv.DictReader(handle))
    sizes = sorted({int(row["n"]) for row in rows})
    batches = sorted({int(row["batch"]) for row in rows})
    output = ROOT / "results" / "plots" / "performance"
    output.mkdir(parents=True, exist_ok=True)
    metrics = (
        ("discoveryMs", "Candidate discovery (ms)"),
        ("totalStepMs", "Actual compaction step (ms)"),
        ("decodedDocuments", "Documents decoded during discovery"),
    )
    figure, axes = plt.subplots(len(metrics), len(sizes), figsize=(5 * len(sizes), 10), squeeze=False)
    for column, size in enumerate(sizes):
        for row_index, (metric, description) in enumerate(metrics):
            axis = axes[row_index][column]
            for label, color in (("before", "#9b3b38"), ("after", "#26759b")):
                for phase, style in (("cold", "--"), ("reused", "-")):
                    selected = sorted(
                        (row for row in rows if row["label"] == label and row["phase"] == phase and int(row["n"]) == size),
                        key=lambda row: int(row["batch"]),
                    )
                    axis.plot(
                        [int(row["batch"]) for row in selected],
                        [float(row[metric]) for row in selected],
                        marker="o",
                        linestyle=style,
                        color=color,
                        label=f"{label}, {phase}",
                    )
            axis.set_xscale("log")
            axis.set_xticks(batches, [str(batch) for batch in batches])
            if metric != "decodedDocuments":
                axis.set_yscale("log")
            axis.set_title(f"{size:,} inserted documents")
            axis.set_ylabel(description)
            axis.set_xlabel("Relocation batch size")
            axis.grid(alpha=0.2)
    axes[0][0].legend(fontsize=8)
    figure.suptitle(f"{args.workload}: medians of real-file relocation, commit and truncation steps")
    figure.tight_layout()
    destination = output / f"candidate-discovery-{args.workload}.png"
    figure.savefig(destination, dpi=180)
    plt.close(figure)
    print(destination)


if __name__ == "__main__":
    main()
