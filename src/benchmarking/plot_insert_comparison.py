#!/usr/bin/env python3
"""
Plot combined B+ Tree vs DBMS INSERT performance.
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
        with open(RESULTS_DIR + 'btree_insert_400k.txt', 'r') as f:
            btree_data = np.array(json.load(f))
    except FileNotFoundError:
        print("btree_insert_400k.txt not found - run the test first")
        return
    
    dbms_data = None
    try:
        with open(RESULTS_DIR + 'dbms_insert_400k.txt', 'r') as f:
            dbms_data = np.array(json.load(f))
    except FileNotFoundError:
        print("dbms_insert_400k.txt not found - plotting B+ Tree only")

    N = len(btree_data)
    has_dbms = dbms_data is not None and len(dbms_data) == N

    btree_x, btree_y = batch_average(btree_data)
    if has_dbms:
        dbms_x, dbms_y = batch_average(dbms_data)

    # Create figure with 2 subplots
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))
    
    # === LEFT: INSERT time vs size (log scale) ===
    ax = axes[0]
    ax.semilogx(btree_x, btree_y, 'b-', linewidth=1, label=f'B+ Tree INSERT ({N:,})')
    if has_dbms:
        ax.semilogx(dbms_x, dbms_y, 'g-', linewidth=1, label=f'DBMS INSERT ({N:,})')
    
    # O(log n) fits
    k_btree = np.mean(btree_y) / np.mean(np.log2(btree_x))
    ax.semilogx(btree_x, k_btree * np.log2(btree_x), 'r--', linewidth=2, alpha=0.7, label='O(log n) fit')
    if has_dbms:
        k_dbms = np.mean(dbms_y) / np.mean(np.log2(dbms_x))
        ax.semilogx(dbms_x, k_dbms * np.log2(dbms_x), 'g--', linewidth=2, alpha=0.7, label='DBMS O(log n) fit')
    
    ax.set_xlabel('Tree Size (log scale)')
    ax.set_ylabel(f'Time per operation (ms, avg of {BATCH_SIZE})')
    ax.set_title('INSERT: Time vs Tree Size')
    ax.legend()
    ax.grid(True, alpha=0.3)
    
    # === RIGHT: time/log(n) ratio ===
    ax = axes[1]
    mask = btree_x > 100
    btree_ratio = btree_y[mask] / np.log2(btree_x[mask])
    
    ax.plot(btree_x[mask], btree_ratio, 'b-', linewidth=1, label='B+ Tree')
    
    mean_btree = np.mean(btree_ratio)
    ax.axhline(mean_btree, color='b', linestyle='--', alpha=0.7, label=f'B+ Tree mean: {mean_btree:.5f}')
    
    cv_btree = np.std(btree_ratio) / mean_btree * 100
    
    if has_dbms:
        dbms_ratio = dbms_y[mask] / np.log2(dbms_x[mask])
        ax.plot(dbms_x[mask], dbms_ratio, 'g-', linewidth=1, label='DBMS')
        mean_dbms = np.mean(dbms_ratio)
        ax.axhline(mean_dbms, color='g', linestyle='--', alpha=0.7, label=f'DBMS mean: {mean_dbms:.5f}')
        cv_dbms = np.std(dbms_ratio) / mean_dbms * 100
        ax.set_title(f'INSERT time/log(n) - B+ Tree CV={cv_btree:.1f}%, DBMS CV={cv_dbms:.1f}%')
    else:
        ax.set_title(f'INSERT time/log(n) - B+ Tree CV={cv_btree:.1f}%')
    
    ax.set_xlabel('Tree Size')
    ax.set_ylabel('time / log2(n)')
    ax.legend(loc='upper right')
    ax.grid(True, alpha=0.3)
    
    title_suffix = 'B+ Tree vs DBMS' if has_dbms else 'B+ Tree'
    plt.suptitle(f'INSERT Performance Comparison: {title_suffix} ({N:,} documents)', fontsize=14)
    plt.tight_layout()
    plt.savefig(IMAGES_DIR + 'insert_performance_comparison.png', dpi=150, bbox_inches='tight')
    print("Saved " + IMAGES_DIR + "insert_performance_comparison.png")
    
    # Print summary
    print("\n" + "=" * 70)
    print(f"INSERT PERFORMANCE SUMMARY ({N:,} documents)")
    print("=" * 70)
    print(f"\nB+ Tree ({N:,} documents):")
    print(f"  INSERT time/log(n) CV: {cv_btree:.1f}%")
    print(f"  Mean INSERT time: {np.mean(btree_data):.4f} ms")
    if has_dbms:
        print(f"\nDBMS ({N:,} documents):")
        print(f"  INSERT time/log(n) CV: {cv_dbms:.1f}%")
        print(f"  Mean INSERT time: {np.mean(dbms_data):.4f} ms")
        print(f"\nOverhead ratio (DBMS / B+ Tree): {np.mean(dbms_data) / np.mean(btree_data):.1f}x")

if __name__ == "__main__":
    main()
