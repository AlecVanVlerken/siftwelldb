#!/usr/bin/env python3
"""
Plot comprehensive performance test results.
Generates graphs for B+ Tree and DBMS tests with various configurations.
Uses batch averaging (non-overlapping bins) for clean visualization.
"""
import json
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path

RESULTS_DIR = 'results/'
IMAGES_DIR = 'results/images/'

BATCH_SIZE = 500

def load_data(filename):
    """Load performance data from file. Returns (inserts, deletes) or None if file missing."""
    filepath = RESULTS_DIR + filename
    try:
        with open(filepath, 'r') as f:
            data = json.load(f)
        return np.array(data[0]), np.array(data[1]) if data[1] else None
    except FileNotFoundError:
        return None, None

def batch_average(data, batch_size=BATCH_SIZE):
    """Bin data into non-overlapping batches and return (midpoints, averages)."""
    n = len(data)
    n_batches = n // batch_size
    if n_batches == 0:
        return np.arange(len(data)), data
    trimmed = data[:n_batches * batch_size].reshape(n_batches, batch_size)
    avgs = trimmed.mean(axis=1)
    midpoints = np.arange(batch_size // 2, n_batches * batch_size, batch_size)
    return midpoints, avgs

def batch_average_with_sizes(sizes, times, batch_size=BATCH_SIZE):
    """Batch-average both tree sizes and times together."""
    n = len(times)
    n_batches = n // batch_size
    if n_batches == 0:
        return sizes, times
    s = sizes[:n_batches * batch_size].reshape(n_batches, batch_size).mean(axis=1)
    t = times[:n_batches * batch_size].reshape(n_batches, batch_size).mean(axis=1)
    return s, t

def plot_comparison(title, configs, output_file):
    """
    Plot comparison of multiple configurations.
    configs: list of (filename, label, color) tuples
    """
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))
    
    for filename, label, color in configs:
        inserts, deletes = load_data(filename)
        if inserts is None:
            print(f"Skipping {filename} (not found)")
            continue
        
        N = len(inserts)
        
        if len(inserts) > 0:
            ins_x, ins_y = batch_average(inserts)
            axes[0].semilogx(ins_x, ins_y, color=color, linewidth=1, label=label)
            
            k = np.mean(ins_y) / np.mean(np.log2(ins_x))
            axes[0].semilogx(ins_x, k * np.log2(ins_x), color=color, 
                           linestyle='--', alpha=0.5, label=f'{label} O(log n)')
        
        if deletes is not None and len(deletes) > 0:
            tree_sizes_del = N - np.arange(N)
            del_sx, del_ty = batch_average_with_sizes(tree_sizes_del, deletes)
            
            axes[1].semilogx(del_sx, del_ty, color=color, linewidth=1, label=label)
            
            k = np.mean(del_ty) / np.mean(np.log2(del_sx))
            axes[1].semilogx(del_sx, k * np.log2(del_sx), color=color,
                           linestyle='--', alpha=0.5, label=f'{label} O(log n)')
    
    axes[0].set_xlabel('Tree Size (log scale)')
    axes[0].set_ylabel(f'Time (ms, avg of {BATCH_SIZE})')
    axes[0].set_title(f'{title} - INSERT')
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)
    
    axes[1].set_xlabel('Tree Size (log scale)')
    axes[1].set_ylabel(f'Time (ms, avg of {BATCH_SIZE})')
    axes[1].set_title(f'{title} - DELETE')
    axes[1].legend()
    axes[1].grid(True, alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(IMAGES_DIR + output_file, dpi=150, bbox_inches='tight')
    print(f"Saved {IMAGES_DIR + output_file}")
    plt.close()

def plot_collections_comparison(title, configs, output_file):
    """
    Plot comparison of multiple collections configurations.
    Uses 'Total Documents' as x-axis since each collection has its own tree.
    """
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))
    
    for filename, label, color in configs:
        inserts, deletes = load_data(filename)
        if inserts is None:
            print(f"Skipping {filename} (not found)")
            continue
        
        N = len(inserts)
        
        if len(inserts) > 0:
            ins_x, ins_y = batch_average(inserts)
            axes[0].semilogx(ins_x, ins_y, color=color, linewidth=1, label=label)
            
            k = np.mean(ins_y) / np.mean(np.log2(ins_x))
            axes[0].semilogx(ins_x, k * np.log2(ins_x), color=color, 
                           linestyle='--', alpha=0.5, label=f'{label} O(log n)')
        
        if deletes is not None and len(deletes) > 0:
            docs_remaining = N - np.arange(N)
            del_sx, del_ty = batch_average_with_sizes(docs_remaining, deletes)
            
            axes[1].semilogx(del_sx, del_ty, color=color, linewidth=1, label=label)
            
            k = np.mean(del_ty) / np.mean(np.log2(del_sx))
            axes[1].semilogx(del_sx, k * np.log2(del_sx), color=color,
                           linestyle='--', alpha=0.5, label=f'{label} O(log n)')
    
    axes[0].set_xlabel('Total Documents (log scale)')
    axes[0].set_ylabel(f'Time (ms, avg of {BATCH_SIZE})')
    axes[0].set_title(f'{title} - INSERT')
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)
    
    axes[1].set_xlabel('Total Documents Remaining (log scale)')
    axes[1].set_ylabel(f'Time (ms, avg of {BATCH_SIZE})')
    axes[1].set_title(f'{title} - DELETE')
    axes[1].legend()
    axes[1].grid(True, alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(IMAGES_DIR + output_file, dpi=150, bbox_inches='tight')
    print(f"Saved {IMAGES_DIR + output_file}")
    plt.close()

def plot_get_performance(title, filename, output_file):
    """Plot GET performance as tree grows."""
    data, _ = load_data(filename)
    if data is None or len(data) == 0:
        print(f"No GET data in {filename}")
        return
    
    fig, ax = plt.subplots(figsize=(10, 5))
    
    get_x, get_y = batch_average(data)
    
    ax.semilogx(get_x, get_y, 'b-', linewidth=1, label='GET time')
    
    k = np.mean(get_y) / np.mean(np.log2(get_x))
    ax.semilogx(get_x, k * np.log2(get_x), 'r--', alpha=0.7, label='O(log n)')
    
    ax.set_xlabel('Tree Size (log scale)')
    ax.set_ylabel(f'Time (ms, avg of {BATCH_SIZE})')
    ax.set_title(f'{title} - GET Performance')
    ax.legend()
    ax.grid(True, alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(IMAGES_DIR + output_file, dpi=150, bbox_inches='tight')
    print(f"Saved {IMAGES_DIR + output_file}")
    plt.close()

def main():
    print("=" * 60)
    print("Generating Comprehensive Performance Graphs")
    print("=" * 60)
    
    print("\n--- B+ Tree Tests ---")
    
    plot_get_performance(
        "B+ Tree",
        "btree_get_performance.txt",
        "btree_get_performance.png"
    )
    
    plot_comparison(
        "B+ Tree Key Size",
        [
            ("btree_keysize_8_performance.txt", "8 bytes", "blue"),
            ("btree_keysize_32_performance.txt", "32 bytes", "green"),
            ("btree_keysize_128_performance.txt", "128 bytes", "red"),
        ],
        "btree_keysize_comparison.png"
    )
    
    plot_comparison(
        "B+ Tree Value Size",
        [
            ("btree_valuesize_10_performance.txt", "10 bytes", "blue"),
            ("btree_valuesize_100_performance.txt", "100 bytes", "green"),
            ("btree_valuesize_500_performance.txt", "500 bytes", "red"),
        ],
        "btree_valuesize_comparison.png"
    )
    
    plot_comparison(
        "B+ Tree Access Pattern",
        [
            ("btree_sequential_performance.txt", "Sequential", "blue"),
            ("btree_random_performance.txt", "Random", "red"),
        ],
        "btree_access_pattern_comparison.png"
    )
    
    print("\n--- DBMS Tests ---")
    
    plot_get_performance(
        "DBMS",
        "dbms_get_performance.txt",
        "dbms_get_performance.png"
    )
    
    plot_collections_comparison(
        "DBMS Multiple Collections",
        [
            ("dbms_1collections_performance.txt", "1 collection", "blue"),
            ("dbms_5collections_performance.txt", "5 collections", "green"),
            ("dbms_10collections_performance.txt", "10 collections", "red"),
        ],
        "dbms_collections_comparison.png"
    )
    
    plot_comparison(
        "DBMS Indexed Fields",
        [
            ("dbms_1indexed_performance.txt", "1 field", "blue"),
            ("dbms_3indexed_performance.txt", "3 fields", "green"),
            ("dbms_5indexed_performance.txt", "5 fields", "red"),
        ],
        "dbms_indexed_comparison.png"
    )
    
    plot_comparison(
        "DBMS Document Size",
        [
            ("dbms_smalldocs_performance.txt", "Small", "blue"),
            ("dbms_mediumdocs_performance.txt", "Medium", "green"),
            ("dbms_largedocs_performance.txt", "Large", "red"),
        ],
        "dbms_docsize_comparison.png"
    )
    
    print("\n" + "=" * 60)
    print("Done! Check for generated .png files")
    print("=" * 60)

if __name__ == "__main__":
    main()
