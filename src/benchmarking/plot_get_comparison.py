#!/usr/bin/env python3
"""
Plot combined B+ Tree vs DBMS GET performance.
Uses batch averaging (non-overlapping bins) instead of moving-average smoothing.
"""
import json
import numpy as np
import matplotlib.pyplot as plt

RESULTS_DIR = 'results/'
IMAGES_DIR = 'results/images/'

BATCH_SIZE = 1000

def batch_average(data, batch_size=BATCH_SIZE):
    """Bin data into non-overlapping batches and return (midpoints, averages)."""
    n = len(data)
    n_batches = n // batch_size
    trimmed = data[:n_batches * batch_size].reshape(n_batches, batch_size)
    avgs = trimmed.mean(axis=1)
    midpoints = np.arange(batch_size // 2, n_batches * batch_size, batch_size)
    return midpoints, avgs

def main():
    try:
        with open(RESULTS_DIR + 'btree_get_200k.txt', 'r') as f:
            btree_data = np.array(json.load(f))
    except FileNotFoundError:
        print("btree_get_200k.txt not found - run the test first")
        return
    
    try:
        with open(RESULTS_DIR + 'dbms_get_200k.txt', 'r') as f:
            dbms_data = np.array(json.load(f))
    except FileNotFoundError:
        print("dbms_get_200k.txt not found - run the test first")
        return

    N = len(btree_data)

    btree_x, btree_y = batch_average(btree_data)
    dbms_x, dbms_y = batch_average(dbms_data)
    
    # Create figure with 2 subplots
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))
    
    # === LEFT: GET time vs size (log scale) ===
    ax = axes[0]
    ax.semilogx(btree_x, btree_y, 'b-', linewidth=1, label=f'B+ Tree GET ({N:,})')
    ax.semilogx(dbms_x, dbms_y, 'g-', linewidth=1, label=f'DBMS GET ({N:,})')
    
    # O(log n) fits
    k_btree = np.mean(btree_y) / np.mean(np.log2(btree_x))
    k_dbms = np.mean(dbms_y) / np.mean(np.log2(dbms_x))
    ax.semilogx(btree_x, k_btree * np.log2(btree_x), 'b--', linewidth=2, alpha=0.5, label='B+ Tree O(log n) fit')
    ax.semilogx(dbms_x, k_dbms * np.log2(dbms_x), 'g--', linewidth=2, alpha=0.5, label='DBMS O(log n) fit')
    
    ax.set_xlabel('Tree Size (log scale)')
    ax.set_ylabel(f'Time per operation (ms, avg of {BATCH_SIZE})')
    ax.set_title('GET: B+ Tree vs DBMS')
    ax.legend()
    ax.grid(True, alpha=0.3)
    
    # === RIGHT: time/log(n) ratio ===
    ax = axes[1]
    mask = btree_x > 100
    btree_ratio = btree_y[mask] / np.log2(btree_x[mask])
    dbms_ratio = dbms_y[mask] / np.log2(dbms_x[mask])
    
    ax.plot(btree_x[mask], btree_ratio, 'b-', linewidth=1, label='B+ Tree')
    ax.plot(dbms_x[mask], dbms_ratio, 'g-', linewidth=1, label='DBMS')
    
    mean_btree = np.mean(btree_ratio)
    mean_dbms = np.mean(dbms_ratio)
    ax.axhline(mean_btree, color='b', linestyle='--', alpha=0.7, label=f'B+ Tree mean: {mean_btree:.5f}')
    ax.axhline(mean_dbms, color='g', linestyle='--', alpha=0.7, label=f'DBMS mean: {mean_dbms:.5f}')
    
    cv_btree = np.std(btree_ratio) / mean_btree * 100
    cv_dbms = np.std(dbms_ratio) / mean_dbms * 100
    
    ax.set_xlabel('Tree Size')
    ax.set_ylabel('time / log2(n)')
    ax.set_title(f'GET time/log(n) - B+ Tree CV={cv_btree:.1f}%, DBMS CV={cv_dbms:.1f}%')
    ax.legend(loc='upper right')
    ax.grid(True, alpha=0.3)
    
    plt.suptitle(f'GET Performance Comparison: B+ Tree vs DBMS ({N:,} documents)', fontsize=14)
    plt.tight_layout()
    plt.savefig(IMAGES_DIR + 'get_performance_comparison.png', dpi=150, bbox_inches='tight')
    print("Saved " + IMAGES_DIR + "get_performance_comparison.png")
    
    # Print summary
    print("\n" + "=" * 70)
    print(f"GET PERFORMANCE SUMMARY ({N:,} documents)")
    print("=" * 70)
    print(f"\nB+ Tree ({N:,} documents):")
    print(f"  GET time/log(n) CV: {cv_btree:.1f}%")
    print(f"  Mean GET time: {np.mean(btree_data):.4f} ms")
    print(f"\nDBMS ({N:,} documents):")
    print(f"  GET time/log(n) CV: {cv_dbms:.1f}%")
    print(f"  Mean GET time: {np.mean(dbms_data):.4f} ms")
    print(f"\nOverhead ratio (DBMS / B+ Tree): {np.mean(dbms_data) / np.mean(btree_data):.1f}x")

if __name__ == "__main__":
    main()
