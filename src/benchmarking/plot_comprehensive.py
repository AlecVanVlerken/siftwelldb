#!/usr/bin/env python3
"""
Plot comprehensive performance test results.
Generates graphs for B+ Tree and DBMS tests with various configurations.
Same format as plot_btree_only.py - X-axis is tree size (log scale).
"""
import json
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path

RESULTS_DIR = 'results/'
IMAGES_DIR = 'results/images/'

def load_data(filename):
    """Load performance data from file. Returns (inserts, deletes) or None if file missing."""
    filepath = RESULTS_DIR + filename
    try:
        with open(filepath, 'r') as f:
            data = json.load(f)
        return np.array(data[0]), np.array(data[1]) if data[1] else None
    except FileNotFoundError:
        return None, None

def smooth(data, window=500):
    """Apply moving average smoothing."""
    if len(data) < window:
        return data
    return np.convolve(data, np.ones(window)/window, mode='valid')

def plot_comparison(title, configs, output_file):
    """
    Plot comparison of multiple configurations.
    configs: list of (filename, label, color) tuples
    Format matches plot_btree_only.py: X-axis = tree size (log scale)
    """
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))
    window = 500
    
    for filename, label, color in configs:
        inserts, deletes = load_data(filename)
        if inserts is None:
            print(f"Skipping {filename} (not found)")
            continue
        
        N = len(inserts)
        
        # INSERT: X-axis = tree size (1 to N)
        if len(inserts) > 0:
            n_ins = np.arange(1, N + 1)
            n_ins_smooth = n_ins[window//2:N - window//2 + 1]
            ins_smooth = smooth(inserts, window)
            
            axes[0].semilogx(n_ins_smooth, ins_smooth, color=color, linewidth=1, label=label)
            
            # O(log n) fit
            k = np.mean(ins_smooth) / np.mean(np.log2(n_ins_smooth))
            axes[0].semilogx(n_ins_smooth, k * np.log2(n_ins_smooth), color=color, 
                           linestyle='--', alpha=0.5, label=f'{label} O(log n)')
        
        # DELETE: X-axis = tree size at time of delete (N down to 1)
        if deletes is not None and len(deletes) > 0:
            # Tree size: N at first delete, 1 at last delete
            tree_sizes_del = N - np.arange(N)
            tree_del_smooth = tree_sizes_del[window//2:N - window//2 + 1]
            del_smooth = smooth(deletes, window)
            
            axes[1].semilogx(tree_del_smooth, del_smooth, color=color, linewidth=1, label=label)
            
            # O(log n) fit
            k = np.mean(del_smooth) / np.mean(np.log2(tree_del_smooth))
            axes[1].semilogx(tree_del_smooth, k * np.log2(tree_del_smooth), color=color,
                           linestyle='--', alpha=0.5, label=f'{label} O(log n)')
    
    axes[0].set_xlabel('Tree Size (log scale)')
    axes[0].set_ylabel('Time (ms)')
    axes[0].set_title(f'{title} - INSERT')
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)
    
    axes[1].set_xlabel('Tree Size (log scale)')
    axes[1].set_ylabel('Time (ms)')
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
    window = 500
    
    for filename, label, color in configs:
        inserts, deletes = load_data(filename)
        if inserts is None:
            print(f"Skipping {filename} (not found)")
            continue
        
        N = len(inserts)
        
        # INSERT: X-axis = total documents inserted (operation index)
        if len(inserts) > 0:
            n_ins = np.arange(1, N + 1)
            n_ins_smooth = n_ins[window//2:N - window//2 + 1]
            ins_smooth = smooth(inserts, window)
            
            axes[0].semilogx(n_ins_smooth, ins_smooth, color=color, linewidth=1, label=label)
            
            # O(log n) fit
            k = np.mean(ins_smooth) / np.mean(np.log2(n_ins_smooth))
            axes[0].semilogx(n_ins_smooth, k * np.log2(n_ins_smooth), color=color, 
                           linestyle='--', alpha=0.5, label=f'{label} O(log n)')
        
        # DELETE: X-axis = total documents remaining
        if deletes is not None and len(deletes) > 0:
            docs_remaining = N - np.arange(N)
            docs_smooth = docs_remaining[window//2:N - window//2 + 1]
            del_smooth = smooth(deletes, window)
            
            axes[1].semilogx(docs_smooth, del_smooth, color=color, linewidth=1, label=label)
            
            # O(log n) fit
            k = np.mean(del_smooth) / np.mean(np.log2(docs_smooth))
            axes[1].semilogx(docs_smooth, k * np.log2(docs_smooth), color=color,
                           linestyle='--', alpha=0.5, label=f'{label} O(log n)')
    
    axes[0].set_xlabel('Total Documents (log scale)')
    axes[0].set_ylabel('Time (ms)')
    axes[0].set_title(f'{title} - INSERT')
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)
    
    axes[1].set_xlabel('Total Documents Remaining (log scale)')
    axes[1].set_ylabel('Time (ms)')
    axes[1].set_title(f'{title} - DELETE')
    axes[1].legend()
    axes[1].grid(True, alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(IMAGES_DIR + output_file, dpi=150, bbox_inches='tight')
    print(f"Saved {IMAGES_DIR + output_file}")
    plt.close()

def plot_get_performance(title, filename, output_file):
    """Plot GET performance as tree grows (same format as insert)."""
    data, _ = load_data(filename)
    if data is None or len(data) == 0:
        print(f"No GET data in {filename}")
        return
    
    fig, ax = plt.subplots(figsize=(10, 5))
    window = 500
    
    N = len(data)
    smoothed = smooth(data, window)
    n = np.arange(1, N + 1)
    n_smooth = n[window//2:N - window//2 + 1]
    
    # Use semilog x-axis like the original graphs
    ax.semilogx(n_smooth, smoothed, 'b-', linewidth=1, label='GET time')
    
    # O(log n) fit
    k = np.mean(smoothed) / np.mean(np.log2(n_smooth))
    ax.semilogx(n_smooth, k * np.log2(n_smooth), 'r--', alpha=0.7, label='O(log n)')
    
    ax.set_xlabel('Tree Size (log scale)')
    ax.set_ylabel('Time (ms)')
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
    
    # B+ Tree tests
    print("\n--- B+ Tree Tests ---")
    
    # GET performance
    plot_get_performance(
        "B+ Tree",
        "btree_get_performance.txt",
        "btree_get_performance.png"
    )
    
    # Key size comparison
    plot_comparison(
        "B+ Tree Key Size",
        [
            ("btree_keysize_8_performance.txt", "8 bytes", "blue"),
            ("btree_keysize_32_performance.txt", "32 bytes", "green"),
            ("btree_keysize_128_performance.txt", "128 bytes", "red"),
        ],
        "btree_keysize_comparison.png"
    )
    
    # Value size comparison
    plot_comparison(
        "B+ Tree Value Size",
        [
            ("btree_valuesize_10_performance.txt", "10 bytes", "blue"),
            ("btree_valuesize_100_performance.txt", "100 bytes", "green"),
            ("btree_valuesize_500_performance.txt", "500 bytes", "red"),
        ],
        "btree_valuesize_comparison.png"
    )
    
    # Access pattern comparison
    plot_comparison(
        "B+ Tree Access Pattern",
        [
            ("btree_sequential_performance.txt", "Sequential", "blue"),
            ("btree_random_performance.txt", "Random", "red"),
        ],
        "btree_access_pattern_comparison.png"
    )
    
    # DBMS tests
    print("\n--- DBMS Tests ---")
    
    # GET performance
    plot_get_performance(
        "DBMS",
        "dbms_get_performance.txt",
        "dbms_get_performance.png"
    )
    
    # Multiple collections comparison (uses Total Documents, not Tree Size)
    plot_collections_comparison(
        "DBMS Multiple Collections",
        [
            ("dbms_1collections_performance.txt", "1 collection", "blue"),
            ("dbms_5collections_performance.txt", "5 collections", "green"),
            ("dbms_10collections_performance.txt", "10 collections", "red"),
        ],
        "dbms_collections_comparison.png"
    )
    
    # Indexed fields comparison
    plot_comparison(
        "DBMS Indexed Fields",
        [
            ("dbms_1indexed_performance.txt", "1 field", "blue"),
            ("dbms_3indexed_performance.txt", "3 fields", "green"),
            ("dbms_5indexed_performance.txt", "5 fields", "red"),
        ],
        "dbms_indexed_comparison.png"
    )
    
    # Document size comparison
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
