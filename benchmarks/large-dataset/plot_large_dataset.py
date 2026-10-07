# @author: Alec Van Vlerken
# @date: 2026-02-20
#
# Reads progress.csv and workload.csv plots images with the data

from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt

BASE = Path("benchmarks/large-dataset")
RESULTS = BASE / "results"
IMAGES = RESULTS / "images"

LOADER_CSV = RESULTS / "progress.csv"
WORKLOAD_CSV = RESULTS / "workload.csv"


def bytes_to_gb(x): 
    return x / (1024**3)

def bytes_to_mb(x): 
    return x / (1024**2)


def main():
    IMAGES.mkdir(parents=True, exist_ok=True)

    if not LOADER_CSV.exists():
        raise FileNotFoundError(f"Missing loader CSV: {LOADER_CSV}")
    if not WORKLOAD_CSV.exists():
        raise FileNotFoundError(f"Missing workload CSV: {WORKLOAD_CSV}")

    loader = pd.read_csv(LOADER_CSV)
    workload = pd.read_csv(WORKLOAD_CSV)

    # Compute DB size ONCE, then reuse in titles.
    # Prefer loader final size, fall back to workload's constant dataBytes.-
    final_db_bytes = None
    if "data_bytes" in loader.columns and len(loader) > 0:
        final_db_bytes = int(loader["data_bytes"].iloc[-1])
    elif "dataBytes" in workload.columns and len(workload) > 0:
        final_db_bytes = int(workload["dataBytes"].iloc[0])
    else:
        raise ValueError("Could not determine DB size: missing loader.data_bytes and workload.dataBytes")

    final_db_gb = bytes_to_gb(final_db_bytes)

    # Plot 1: Loader DB size vs time
    fig = plt.figure(figsize=(10, 5))
    t = loader["t_ms"] / 1000.0
    db_gb = bytes_to_gb(loader["data_bytes"])

    plt.plot(t, db_gb)
    plt.xlabel("time (s)")
    plt.ylabel("db size (GB)")
    plt.title(f"Loader: DB size growth over time (final ≈ {final_db_gb:.2f} GB)")
    plt.grid(True, alpha=0.3)
    out1 = IMAGES / "loader_dbsize_gb.png"
    plt.tight_layout()
    plt.savefig(out1, dpi=150)
    plt.close(fig)

    # Plot 1b: Loader RSS over time
    fig = plt.figure(figsize=(10, 5))
    rss_mb = bytes_to_mb(loader["rss_bytes"])

    plt.plot(t, rss_mb)
    plt.xlabel("time (s)")
    plt.ylabel("RSS (MB)")
    plt.title(f"Loader: RSS over time while inserting (final DB ≈ {final_db_gb:.2f} GB)")
    plt.grid(True, alpha=0.3)
    out1b = IMAGES / "loader_rss_mb.png"
    plt.tight_layout()
    plt.savefig(out1b, dpi=150)
    plt.close(fig)

    # Plot 2: Workload RSS vs time
    fig = plt.figure(figsize=(10, 5))
    tw = workload["t_ms"] / 1000.0
    rssw_mb = bytes_to_mb(workload["rss"])

    plt.plot(tw, rssw_mb)
    plt.xlabel("time (s)")
    plt.ylabel("RSS (MB)")
    plt.title(f"Workload: RSS over time (DB size ≈ {final_db_gb:.2f} GB)")
    plt.grid(True, alpha=0.3)
    out2 = IMAGES / "workload_rss_mb.png"
    plt.tight_layout()
    plt.savefig(out2, dpi=150)
    plt.close(fig)

    # Plot 3: Workload latency vs time (avg + p95)
    fig = plt.figure(figsize=(10, 5))
    plt.plot(tw, workload["avgLat"])
    plt.plot(tw, workload["p95"])
    plt.xlabel("time (s)")
    plt.ylabel("latency (ms)")
    plt.title(f"Workload: latency over time (DB size ≈ {final_db_gb:.2f} GB)")
    plt.grid(True, alpha=0.3)
    plt.legend(["avgLat", "p95"])
    out3 = IMAGES / "workload_latency_ms.png"
    plt.tight_layout()
    plt.savefig(out3, dpi=150)
    plt.close(fig)

    # Plot 4: Workload QPS vs time
    fig = plt.figure(figsize=(10, 5))
    plt.plot(tw, workload["qps"])
    plt.xlabel("time (s)")
    plt.ylabel("queries / sec")
    plt.title(f"Workload: QPS over time (DB size ≈ {final_db_gb:.2f} GB)")
    plt.grid(True, alpha=0.3)
    out4 = IMAGES / "workload_qps.png"
    plt.tight_layout()
    plt.savefig(out4, dpi=150)
    plt.close(fig)

    print("Saved plots:")
    print(" -", out1)
    print(" -", out1b)
    print(" -", out2)
    print(" -", out3)
    print(" -", out4)


if __name__ == "__main__":
    main()