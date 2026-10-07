# @author: Alec Van Vlerken 
# @date: 2026-02-20

## Overview

The benchmark consists of three steps:

1. **Loader**  
   Builds a large database by inserting documents in batches until the data file reaches a target size.

2. **Workload runner**  
   Opens the existing database and runs a mixed read workload (random point lookups and range scans).

3. **Plotter**  
   Reads the CSV logs produced by the loader and workload and generates PNG plots.

## What the benchmark measures

### Loader
- Sustained insert throughput (docs/sec)
- Data growth rate (MB/sec)
- Process memory usage (RSS, heap)
- Behavior as the on-disk database grows large

### Workload
- Queries per second (QPS)
- Average and tail latency (p50, p95)
- Memory usage while reading from a large on-disk dataset
- Impact of mixed point lookups and range scans

## How it works

### Loader ("large_dataset_loader.mts")

- Inserts JSON documents into a single collection
- Commits once per batch ("--batch")
- Stops when the size of "db.data" reaches "--targetGB"
- Writes one CSV row per batch to "results/progress.csv"

Each document contains:
- an "id" field ("doc1234")
- one or more fixed-size indexed fields
- a large "_payload" field (KB-sized, **not indexed**)
- additional non-indexed text fields

This simulates realistic large documents without inflating index size.

### Workload ("large_dataset_workload.mts")

- Opens the existing database produced by the loader
- Runs for a fixed duration ("--seconds")
- Executes:
  - random GET-by-ID operations
  - periodic range scans every "--scanEvery" operations
- Logs metrics once per second to "results/workload.csv"

The workload size (number of documents) is inferred from the loader’s "progress.csv".

### Plotter ("plot_large_dataset.py")

- Reads "progress.csv" and "workload.csv"
- Produces plots for:
  - DB size over time
  - Loader RSS over time
  - Workload RSS over time
  - Workload latency (avg and p95)
  - Workload QPS over time
- Writes PNGs to "results/images/"

## Example workflow

### Generate a large database

- npx tsx benchmarks/large-dataset/large_dataset_loader.mts \
  --targetGB 20 \
  --payloadKB 512 \
  --batch 200
- Arguments:
    - --targetGB (default: 50): target size of db.data
    - --payloadKB (default: 512): size of document payload
    - --batch (default: 200): documents per commit
- Output:
    - db/db.data
    - db/db.log
    - results/progress.csv

### Run the read workload

- npx tsx benchmarks/large-dataset/large_dataset_workload.mts \
  --seconds 120 \
  --scanEvery 10 \
  --scanLen 100
- Arguments:
    - --seconds (default: 120): workload duration
    - --scanEvery (default: 10): one scan every N operations
    - --scanLen (default: 100): number of documents per scan
- Output:
    - results/workload.csv

### Generate plots

- python benchmarks/large-dataset/plot_large_dataset.py
- Arguments:
    - results/images/*.png

## CSV output format

### results/progress.csv (loader)

- t_ms,docs,data_bytes,docs_per_sec,avg_mb_per_sec,rss_bytes,heap_used_bytes:
    - t_ms: elapsed time since start (ms)
    - docs: total documents inserted
    - data_bytes: size of db.data
    - docs_per_sec: instantaneous insert rate
    - avg_mb_per_sec: average data growth rate
    - rss_bytes: resident set size
    - heap_used_bytes: JS heap usage

### results/workload.csv (workload)

- t_ms,rss,heapUsed,external,dataBytes,qps,avgLat,p50,p95,gets,scans:
    - t_ms: elapsed time since workload start (ms)
    - rss: resident set size
    - heapUsed: JS heap usage
    - external: external memory usage
    - dataBytes: database size
    - qps: operations per second
    - avgLat: average latency (ms)
    - p50, p95: median and 95th percentile latency
    - gets, scans: operations executed in the interval

## Example results (20GB run)

These example results were collected on:

- System:
    - CPU: 12th Gen Intel(R) Core(TM) i7-1255U @ 1.70 GHz
    - RAM: 16.0 GB (15.7 GB usable)
    - OS: 64-bit, x64-based processor

- Loader (20GB):
    - Insert throughput: ~130–150 docs/sec
    - Data growth rate: ~60–72 MB/sec early, trending to ~64–69 MB/sec later
    - RSS: roughly 600–800 MB
    - Workload (20GB, scanEvery=10, scanLen=100)
    - Throughput: ~18–22 QPS
    - Average latency: ~45–55 ms
    - p95 latency: ~420–575 ms
    - RSS: ~170–290 MB