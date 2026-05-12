"""Plot grouped incremental compaction benchmark outputs."""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "results" / "raw"
PLOTS = ROOT / "results" / "plots"
SUMMARY = RAW / "incremental_compaction_summary.csv"

GROUPS: dict[str, list[str]] = {
    "core": [
        "k-convergence",
        "heavy-delete-shrink",
        "mixed-churn-shrink",
        "mixed-tail-blockers",
    ],
    "relocation": [
        "recordstore-only-shrink",
        "large-record-chain",
        "head-low-tail-high-record",
        "multi-index-shrink",
        "btree-tail-blocker",
        "btree-dominant-tail-blocker",
        "btree-tail-clear-sequence",
        "hnsw-tail-blocker",
        "hnsw-dominant-tail-blocker",
        "hnsw-tail-clear-sequence",
        "ordered-mixed-tail-blockers",
        "mixed-blockers-records-minimized",
    ],
    "consistency": [
        "record-btree-reference-stability",
        "record-hnsw-reference-stability",
        "mixed-cross-structure-durability",
        "hnsw-semantic-equivalence",
    ],
    "durability": [
        "mixed-cross-structure-durability",
    ],
    "maintenance": [
        "under-k-noop",
        "fragmented-but-already-healthy",
        "no-further-safe-progress",
        "bounded-step-idle",
        "repeated-idle-steps",
        "long-run-idle-maintenance",
        "maintenance-stability",
        "rolling-churn",
        "no-further-safe-progress-explicit",
        "partial-convergence-then-plateau",
    ],
    "performance": [
        "incremental-performance",
        "compaction-overhead-light-churn",
        "compaction-overhead-heavy-churn",
    ],
    "adversarial": [
        "alternating-tail-layout",
        "one-small-blocker-huge-tail",
        "many-small-blockers",
    ],
}


def main() -> None:
    if not SUMMARY.exists():
        raise SystemExit("Run an incremental benchmark before plotting.")

    try:
        import matplotlib.pyplot as plt
    except ModuleNotFoundError as exc:
        raise SystemExit("matplotlib is required to plot benchmark results.") from exc

    rows = read_summary()
    PLOTS.mkdir(parents=True, exist_ok=True)

    plot_core(rows, plt)
    plot_relocation(rows, plt)
    plot_consistency(rows, plt)
    plot_durability(rows, plt)
    plot_maintenance(rows, plt)
    plot_performance(rows, plt)
    plot_adversarial(rows, plt)
    write_manifest(rows)

    print(f"Wrote grouped plots to {PLOTS}")


def read_summary() -> list[dict[str, str]]:
    with SUMMARY.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def plot_core(rows: list[dict[str, str]], plt) -> None:
    core = select_rows(rows, "core")
    if not core:
        return
    out = ensure_plot_dir("core")
    before_after_bar(
        core,
        plt,
        "core_shrink_comparison.png",
        out,
        "Core shrink scenarios: total blocks",
        "totalBlocksBefore",
        "totalBlocksAfter",
        "blocks",
    )
    before_after_bar(
        core,
        plt,
        "core_amplification_comparison.png",
        out,
        "Core shrink scenarios: amplification",
        "amplificationBefore",
        "amplificationAfter",
        "total blocks / used blocks",
        value_type=float,
        k_line=True,
    )
    single_bar(core, plt, "core_steps_to_status.png", out, "Core shrink scenarios: steps", "stepsTaken", "steps")


def plot_relocation(rows: list[dict[str, str]], plt) -> None:
    relocation = select_rows(rows, "relocation")
    if not relocation:
        return
    out = ensure_plot_dir("relocation")
    stacked_work_bar(relocation, plt, "relocation_type_comparison.png", out, "Relocation scenarios: work by type")
    single_bar(
        relocation,
        plt,
        "relocation_shrink_comparison.png",
        out,
        "Relocation scenarios: bytes shrunk",
        "shrunkBytes",
        "bytes",
    )
    step_lines(
        GROUPS["relocation"],
        plt,
        "relocation_step_attribution.png",
        out,
        "Relocation scenarios: total blocks by step",
        "totalBlocks",
        "blocks",
        annotate=True,
    )


def plot_consistency(rows: list[dict[str, str]], plt) -> None:
    consistency = select_rows(rows, "consistency")
    hnsw_equivalence = read_optional_json("hnsw-semantic-equivalence")
    if not consistency and hnsw_equivalence is None:
        return

    out = ensure_plot_dir("consistency")
    labels: list[str] = []
    checks: dict[str, list[int]] = {
        "same ids": [],
        "same docs": [],
        "same indexes": [],
        "same cursors": [],
        "same semantic": [],
        "reopen": [],
    }

    for row in consistency:
        labels.append(row["scenario"])
        checks["same ids"].append(bool_int(row.get("sameIds")))
        checks["same docs"].append(bool_int(row.get("sameDocumentContents")))
        checks["same indexes"].append(bool_int(row.get("sameIndexedResults")))
        checks["same cursors"].append(bool_int(row.get("sameCursorResults")))
        checks["same semantic"].append(bool_int(row.get("sameSemanticResults")))
        checks["reopen"].append(bool_int(row.get("postReopenChecksPassed")))

    if hnsw_equivalence is not None:
        labels.append("hnsw-semantic-equivalence")
        checks["same ids"].append(1)
        checks["same docs"].append(1)
        checks["same indexes"].append(0)
        checks["same cursors"].append(0)
        checks["same semantic"].append(
            int(
                hnsw_equivalence.get("exactAfterIncremental") is True
                and hnsw_equivalence.get("exactAfterVacuum") is True
            )
        )
        checks["reopen"].append(
            int(
                hnsw_equivalence.get("exactAfterIncrementalReopen") is True
                and hnsw_equivalence.get("exactAfterVacuumReopen") is True
            )
        )

    fig, axis = plt.subplots(figsize=(max(9, len(labels) * 0.9), 5))
    bottom = [0] * len(labels)
    for check, values in checks.items():
        axis.bar(range(len(labels)), values, bottom=bottom, label=check)
        bottom = [old + value for old, value in zip(bottom, values)]
    axis.set_title("Consistency benchmarks: passed checks")
    axis.set_ylabel("passed check count")
    axis.set_xticks(list(range(len(labels))), labels, rotation=35, ha="right")
    axis.legend(fontsize="small")
    fig.tight_layout()
    fig.savefig(out / "consistency_summary.png", dpi=140)
    plt.close(fig)


def plot_maintenance(rows: list[dict[str, str]], plt) -> None:
    maintenance = select_rows(rows, "maintenance")
    if not maintenance:
        return
    out = ensure_plot_dir("maintenance")
    before_after_bar(
        maintenance,
        plt,
        "maintenance_amplification_summary.png",
        out,
        "Maintenance scenarios: amplification",
        "amplificationBefore",
        "amplificationAfter",
        "total blocks / used blocks",
        value_type=float,
        k_line=True,
    )
    step_lines(
        GROUPS["maintenance"],
        plt,
        "maintenance_step_amplification.png",
        out,
        "Maintenance scenarios: amplification by step",
        "amplification",
        "amplification",
    )
    timeline_plot(plt, out)


def plot_durability(rows: list[dict[str, str]], plt) -> None:
    durability = select_rows(rows, "durability")
    if not durability:
        return
    out = ensure_plot_dir("durability")
    before_after_bar(
        durability,
        plt,
        "durability_reopen_amplification.png",
        out,
        "Durability scenarios: amplification after compact/reopen",
        "amplificationBefore",
        "amplificationAfter",
        "total blocks / used blocks",
        value_type=float,
        k_line=True,
    )
    single_bar(
        durability,
        plt,
        "durability_reopen_checks.png",
        out,
        "Durability scenarios: post-reopen checks",
        "postReopenChecksPassed",
        "passed",
    )


def plot_performance(rows: list[dict[str, str]], plt) -> None:
    performance = select_rows(rows, "performance")
    if not performance:
        return
    out = ensure_plot_dir("performance")

    fig, axis = plt.subplots(figsize=(8, 5))
    for row in performance:
        axis.scatter(safe_float(row, "timeTakenMs"), safe_int(row, "shrunkBytes"), label=row["scenario"])
    axis.set_title("Performance scenarios: maintenance cost vs reclaimed bytes")
    axis.set_xlabel("maintenance time (ms)")
    axis.set_ylabel("shrunk bytes")
    axis.legend(fontsize="small")
    fig.tight_layout()
    fig.savefig(out / "performance_overhead.png", dpi=140)
    plt.close(fig)

    single_bar(
        performance,
        plt,
        "performance_step_count.png",
        out,
        "Performance scenarios: compaction steps",
        "stepsTaken",
        "steps",
    )


def plot_adversarial(rows: list[dict[str, str]], plt) -> None:
    adversarial = select_rows(rows, "adversarial")
    if not adversarial:
        return
    out = ensure_plot_dir("adversarial")
    before_after_bar(
        adversarial,
        plt,
        "adversarial_amplification.png",
        out,
        "Adversarial scenarios: amplification",
        "amplificationBefore",
        "amplificationAfter",
        "total blocks / used blocks",
        value_type=float,
        k_line=True,
    )
    stacked_work_bar(adversarial, plt, "adversarial_work_by_kind.png", out, "Adversarial scenarios: work by type")


def before_after_bar(
    rows: list[dict[str, str]],
    plt,
    filename: str,
    out: Path,
    title: str,
    before_key: str,
    after_key: str,
    ylabel: str,
    value_type=int,
    k_line: bool = False,
) -> None:
    labels = [row["scenario"] for row in rows]
    before = [value_type(row[before_key]) for row in rows]
    after = [value_type(row[after_key]) for row in rows]
    positions = list(range(len(labels)))
    width = 0.35

    fig, axis = plt.subplots(figsize=(max(9, len(labels) * 0.8), 5))
    axis.bar([x - width / 2 for x in positions], before, width, label="before")
    axis.bar([x + width / 2 for x in positions], after, width, label="after")
    if k_line:
        axis.axhline(1.25, color="black", linestyle="--", linewidth=1, label="K=1.25")
    axis.set_title(title)
    axis.set_ylabel(ylabel)
    axis.set_xticks(positions, labels, rotation=35, ha="right")
    axis.legend(fontsize="small")
    fig.tight_layout()
    fig.savefig(out / filename, dpi=140)
    plt.close(fig)


def single_bar(
    rows: list[dict[str, str]],
    plt,
    filename: str,
    out: Path,
    title: str,
    key: str,
    ylabel: str,
) -> None:
    labels = [row["scenario"] for row in rows]
    values = [safe_float(row, key) for row in rows]
    positions = list(range(len(labels)))

    fig, axis = plt.subplots(figsize=(max(9, len(labels) * 0.8), 5))
    axis.bar(positions, values)
    axis.set_title(title)
    axis.set_ylabel(ylabel)
    axis.set_xticks(positions, labels, rotation=35, ha="right")
    fig.tight_layout()
    fig.savefig(out / filename, dpi=140)
    plt.close(fig)


def stacked_work_bar(rows: list[dict[str, str]], plt, filename: str, out: Path, title: str) -> None:
    labels = [row["scenario"] for row in rows]
    values = {
        "records": [safe_int(row, "relocatedDocuments") for row in rows],
        "btree": [safe_int(row, "relocatedBtreeNodes") for row in rows],
        "hnsw": [safe_int(row, "relocatedHnswUnits") for row in rows],
        "tail blocks": [safe_int(row, "reclaimedTailBlocks") for row in rows],
    }
    positions = list(range(len(labels)))
    bottom = [0] * len(labels)

    fig, axis = plt.subplots(figsize=(max(10, len(labels) * 0.8), 5))
    for label, series in values.items():
        axis.bar(positions, series, bottom=bottom, label=label)
        bottom = [old + value for old, value in zip(bottom, series)]
    axis.set_title(title)
    axis.set_ylabel("count")
    axis.set_xticks(positions, labels, rotation=35, ha="right")
    axis.legend(fontsize="small")
    fig.tight_layout()
    fig.savefig(out / filename, dpi=140)
    plt.close(fig)


def step_lines(
    scenarios: Iterable[str],
    plt,
    filename: str,
    out: Path,
    title: str,
    y_key: str,
    ylabel: str,
    annotate: bool = False,
) -> None:
    fig, axis = plt.subplots(figsize=(10, 5))
    plotted = False
    for scenario in scenarios:
        step_file = RAW / f"{scenario}-steps.csv"
        if not step_file.exists():
            continue
        with step_file.open(newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        if not rows:
            continue
        plotted = True
        steps = [int(row["step"]) for row in rows]
        values = [float(row[y_key]) for row in rows]
        axis.plot(steps, values, marker="o", label=scenario)
        if annotate:
            for row, step, value in zip(rows, steps, values):
                label = step_label(row)
                if label:
                    axis.annotate(label, (step, value), textcoords="offset points", xytext=(0, 7), ha="center", fontsize=7)
    if not plotted:
        plt.close(fig)
        return
    axis.set_title(title)
    axis.set_xlabel("step")
    axis.set_ylabel(ylabel)
    axis.legend(fontsize="small")
    fig.tight_layout()
    fig.savefig(out / filename, dpi=140)
    plt.close(fig)


def timeline_plot(plt, out: Path) -> None:
    timeline_files = sorted(RAW.glob("*-timeline.csv"))
    if not timeline_files:
        return

    fig, axis = plt.subplots(figsize=(10, 5))
    for timeline_file in timeline_files:
        with timeline_file.open(newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        if not rows:
            continue
        phases = [int(row["phase"]) for row in rows]
        axis.plot(
            phases,
            [float(row["beforeAmplification"]) for row in rows],
            marker="o",
            linestyle="--",
            label=f"{rows[0]['scenario']} before",
        )
        axis.plot(
            phases,
            [float(row["afterAmplification"]) for row in rows],
            marker="o",
            label=f"{rows[0]['scenario']} after",
        )
    axis.axhline(1.25, color="black", linestyle="--", linewidth=1, label="K=1.25")
    axis.set_title("Long-run maintenance timelines")
    axis.set_xlabel("phase")
    axis.set_ylabel("amplification")
    axis.legend(fontsize="small")
    fig.tight_layout()
    fig.savefig(out / "maintenance_timeline.png", dpi=140)
    plt.close(fig)


def write_manifest(rows: list[dict[str, str]]) -> None:
    manifest = {
        group: {
            "scenarios": [row["scenario"] for row in select_rows(rows, group)],
            "plotDirectory": str((PLOTS / group).relative_to(ROOT)),
        }
        for group in GROUPS
    }
    manifest["consistency"]["extraJsonInputs"] = ["hnsw-semantic-equivalence.json"]
    PLOTS.mkdir(parents=True, exist_ok=True)
    (PLOTS / "plot_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def select_rows(rows: list[dict[str, str]], group: str) -> list[dict[str, str]]:
    wanted = set(GROUPS[group])
    by_name = {row["scenario"]: row for row in rows}
    return [by_name[name] for name in GROUPS[group] if name in wanted and name in by_name]


def read_optional_json(scenario: str) -> dict | None:
    path = RAW / f"{scenario}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def ensure_plot_dir(group: str) -> Path:
    path = PLOTS / group
    path.mkdir(parents=True, exist_ok=True)
    return path


def bool_int(value: str | None) -> int:
    return 1 if value == "true" else 0


def safe_int(row: dict[str, str], key: str) -> int:
    value = row.get(key, "")
    if value == "true":
        return 1
    if value == "false":
        return 0
    return int(float(value)) if value not in ("", None) else 0


def safe_float(row: dict[str, str], key: str) -> float:
    value = row.get(key, "")
    if value == "true":
        return 1.0
    if value == "false":
        return 0.0
    return float(value) if value not in ("", None) else 0.0


def step_label(row: dict[str, str]) -> str:
    labels: list[str] = []
    if safe_int(row, "stepRelocatedDocuments") > 0:
        labels.append("R")
    if safe_int(row, "stepRelocatedBtreeNodes") > 0:
        labels.append("B")
    if safe_int(row, "stepRelocatedHnswUnits") > 0:
        labels.append("H")
    if safe_int(row, "stepReclaimedTailBlocks") > 0:
        labels.append("T")
    return "".join(labels)


if __name__ == "__main__":
    main()
