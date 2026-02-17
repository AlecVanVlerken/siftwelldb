#!/usr/bin/env python3
"""
Plot combined B+ Tree vs DBMS INSERT performance.
Format matches plot_btree_vs_dbms.py for consistency.
"""
import json
import numpy as np
import matplotlib.pyplot as plt

RESULTS_DIR = 'results/'
IMAGES_DIR = 'results/images/'

def smooth(data, window=2000):
    """Apply moving average smoothing."""
    if len(data) < window:
        return data
    return np.convolve(data, np.ones(window)/window, mode='valid')

def main():
    # Load data
    try:
        with open(RESULTS_DIR + 'btree_insert_200k.txt', 'r') as f:
            btree_data = np.array(json.load(f))
    except FileNotFoundError:
        print("btree_insert_200k.txt not found - run the test first")
        return
    
    try:
        with open(RESULTS_DIR + 'dbms_insert_200k.txt', 'r') as f:
            dbms_data = np.array(json.load(f))
    except FileNotFoundError:
        print("dbms_insert_200k.txt not found - run the test first")
        return

    window = 2000
    N = len(btree_data)
    
    # Smooth data
    btree_smooth = smooth(btree_data, window)
    dbms_smooth = smooth(dbms_data, window)
    
    # X-axis: tree/database size
    n = np.arange(1, N + 1)
    n_smooth = n[window//2:N - window//2 + 1]
    
    # Create figure with 2 subplots
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))
    
    # === LEFT: GET time vs size (log scale) ===
    ax = axes[0]
    ax.semilogx(n_smooth, btree_smooth, 'b-', linewidth=1, label=f'B+ Tree INSERT ({N:,})')
    ax.semilogx(n_smooth, dbms_smooth, 'g-', linewidth=1, label=f'DBMS INSERT ({N:,})')
    
    # O(log n) fits
    k_btree = np.mean(btree_smooth) / np.mean(np.log2(n_smooth))
    k_dbms = np.mean(dbms_smooth) / np.mean(np.log2(n_smooth))
    ax.semilogx(n_smooth, k_btree * np.log2(n_smooth), 'b--', linewidth=2, alpha=0.5, label='B+ Tree O(log n) fit')
    ax.semilogx(n_smooth, k_dbms * np.log2(n_smooth), 'g--', linewidth=2, alpha=0.5, label='DBMS O(log n) fit')
    
    ax.set_xlabel('Tree Size (log scale)')
    ax.set_ylabel('Time per operation (ms)')
    ax.set_title('INSERT: B+ Tree vs DBMS')
    ax.legend()
    ax.grid(True, alpha=0.3)
    
    # === RIGHT: time/log(n) ratio ===
    ax = axes[1]
    mask = n_smooth > 100
    btree_ratio = btree_smooth[mask] / np.log2(n_smooth[mask])
    dbms_ratio = dbms_smooth[mask] / np.log2(n_smooth[mask])
    
    ax.plot(n_smooth[mask], btree_ratio, 'b-', linewidth=1, label='B+ Tree')
    ax.plot(n_smooth[mask], dbms_ratio, 'g-', linewidth=1, label='DBMS')
    
    mean_btree = np.mean(btree_ratio)
    mean_dbms = np.mean(dbms_ratio)
    ax.axhline(mean_btree, color='b', linestyle='--', alpha=0.7, label=f'B+ Tree mean: {mean_btree:.5f}')
    ax.axhline(mean_dbms, color='g', linestyle='--', alpha=0.7, label=f'DBMS mean: {mean_dbms:.5f}')
    
    cv_btree = np.std(btree_ratio) / mean_btree * 100
    cv_dbms = np.std(dbms_ratio) / mean_dbms * 100
    
    ax.set_xlabel('Tree Size')
    ax.set_ylabel('time / log2(n)')
    ax.set_title(f'INSERT time/log(n) - B+ Tree CV={cv_btree:.1f}%, DBMS CV={cv_dbms:.1f}%')
    ax.legend(loc='upper right')
    ax.grid(True, alpha=0.3)
    
    plt.suptitle(f'INSERT Performance Comparison: B+ Tree vs DBMS ({N:,} documents)', fontsize=14)
    plt.tight_layout()
    plt.savefig(IMAGES_DIR + 'insert_performance_comparison.png', dpi=150, bbox_inches='tight')
    print("Saved " + IMAGES_DIR + "insert_performance_comparison.png")
    
    # Print summary
    print("\n" + "=" * 70)
    print(f"SLECT PERFORMANCE SUMMARY ({N:,} documents)")
    print("=" * 70)
    print(f"\nB+ Tree ({N:,} documents):")
    print(f"  INSERT time/log(n) CV: {cv_btree:.1f}%")
    print(f"  Mean INSERT time: {np.mean(btree_data):.4f} ms")
    print(f"\nDBMS ({N:,} documents):")
    print(f"  INSERT time/log(n) CV: {cv_dbms:.1f}%")
    print(f"  Mean INSERT time: {np.mean(dbms_data):.4f} ms")
    print(f"\nOverhead ratio (DBMS / B+ Tree): {np.mean(dbms_data) / np.mean(btree_data):.1f}x")

if __name__ == "__main__":
    main()
