import json
import numpy as np
import matplotlib.pyplot as plt

RESULTS_DIR = 'results/'
IMAGES_DIR = 'results/images/'

# Load B+ tree data
with open(RESULTS_DIR + 'btree_performance_results.txt', 'r') as f:
    btree_data = json.load(f)

# Load DBMS data
with open(RESULTS_DIR + 'performance_results.txt', 'r') as f:
    dbms_data = json.load(f)

btree_inserts = np.array(btree_data[0])
btree_deletes = np.array(btree_data[1])
dbms_inserts = np.array(dbms_data[0])
dbms_deletes = np.array(dbms_data[1])

# Use full data for each - they may have different sizes
N_btree = len(btree_inserts)
N_dbms = len(dbms_inserts)
window = 2000

# Create figure with 4 subplots
fig, axes = plt.subplots(2, 2, figsize=(16, 12))

# Smoothing function
def smooth(data, w):
    return np.convolve(data, np.ones(w)/w, mode='valid')

# Tree sizes for B+ tree
n_ins_btree = np.arange(1, N_btree + 1)
n_ins_btree_smooth = n_ins_btree[window//2:N_btree - window//2 + 1]
tree_sizes_del_btree = N_btree - np.arange(N_btree)
tree_del_btree_smooth = tree_sizes_del_btree[window//2:N_btree - window//2 + 1]

# Tree sizes for DBMS
n_ins_dbms = np.arange(1, N_dbms + 1)
n_ins_dbms_smooth = n_ins_dbms[window//2:N_dbms - window//2 + 1]
tree_sizes_del_dbms = N_dbms - np.arange(N_dbms)
tree_del_dbms_smooth = tree_sizes_del_dbms[window//2:N_dbms - window//2 + 1]

# === TOP LEFT: Insert comparison ===
ax = axes[0, 0]
btree_ins_smooth = smooth(btree_inserts, window)
dbms_ins_smooth = smooth(dbms_inserts, window)

ax.semilogx(n_ins_btree_smooth, btree_ins_smooth, 'b-', linewidth=1, label=f'B+ Tree Insert ({N_btree:,})')
ax.semilogx(n_ins_dbms_smooth, dbms_ins_smooth, 'g-', linewidth=1, label=f'DBMS Insert ({N_dbms:,})')

# O(log n) references
k_btree = np.mean(btree_ins_smooth) / np.mean(np.log2(n_ins_btree_smooth))
k_dbms = np.mean(dbms_ins_smooth) / np.mean(np.log2(n_ins_dbms_smooth))
ax.semilogx(n_ins_btree_smooth, k_btree * np.log2(n_ins_btree_smooth), 'b--', linewidth=2, alpha=0.5, label='B+ Tree O(log n) fit')
ax.semilogx(n_ins_dbms_smooth, k_dbms * np.log2(n_ins_dbms_smooth), 'g--', linewidth=2, alpha=0.5, label='DBMS O(log n) fit')

ax.set_xlabel('Tree Size (log scale)')
ax.set_ylabel('Time per operation (ms)')
ax.set_title('INSERT: B+ Tree vs DBMS')
ax.legend()
ax.grid(True, alpha=0.3)

# === TOP RIGHT: Delete comparison ===
ax = axes[0, 1]
btree_del_smooth = smooth(btree_deletes, window)
dbms_del_smooth = smooth(dbms_deletes, window)

ax.semilogx(tree_del_btree_smooth, btree_del_smooth, 'b-', linewidth=1, label=f'B+ Tree Delete ({N_btree:,})')
ax.semilogx(tree_del_dbms_smooth, dbms_del_smooth, 'g-', linewidth=1, label=f'DBMS Delete ({N_dbms:,})')

# O(log n) references
k_btree_d = np.mean(btree_del_smooth) / np.mean(np.log2(tree_del_btree_smooth))
k_dbms_d = np.mean(dbms_del_smooth) / np.mean(np.log2(tree_del_dbms_smooth))
ax.semilogx(tree_del_btree_smooth, k_btree_d * np.log2(tree_del_btree_smooth), 'b--', linewidth=2, alpha=0.5, label='B+ Tree O(log n) fit')
ax.semilogx(tree_del_dbms_smooth, k_dbms_d * np.log2(tree_del_dbms_smooth), 'g--', linewidth=2, alpha=0.5, label='DBMS O(log n) fit')

ax.set_xlabel('Tree Size (log scale)')
ax.set_ylabel('Time per operation (ms)')
ax.set_title('DELETE: B+ Tree vs DBMS')
ax.legend()
ax.grid(True, alpha=0.3)

# === BOTTOM LEFT: time/log(n) for B+ tree ===
ax = axes[1, 0]
mask_btree = n_ins_btree_smooth > 100
btree_ratio_ins = btree_ins_smooth[mask_btree] / np.log2(n_ins_btree_smooth[mask_btree])
btree_ratio_del = btree_del_smooth[tree_del_btree_smooth > 100] / np.log2(tree_del_btree_smooth[tree_del_btree_smooth > 100])

ax.plot(n_ins_btree_smooth[mask_btree], btree_ratio_ins, 'b-', linewidth=1, label='Insert')
tree_del_btree_valid = tree_del_btree_smooth[tree_del_btree_smooth > 100]
ax.plot(tree_del_btree_valid, btree_ratio_del, 'r-', linewidth=1, label='Delete')

mean_ins = np.mean(btree_ratio_ins)
mean_del = np.mean(btree_ratio_del)
ax.axhline(mean_ins, color='b', linestyle='--', alpha=0.7, label=f'Insert mean: {mean_ins:.5f}')
ax.axhline(mean_del, color='r', linestyle='--', alpha=0.7, label=f'Delete mean: {mean_del:.5f}')

cv_ins = np.std(btree_ratio_ins) / mean_ins * 100
cv_del = np.std(btree_ratio_del) / mean_del * 100
ax.set_xlabel('Tree Size')
ax.set_ylabel('time / log2(n)')
ax.set_title(f'B+ TREE ({N_btree:,}): time/log(n) - Insert CV={cv_ins:.1f}%, Delete CV={cv_del:.1f}%')
ax.legend(loc='upper right')
ax.grid(True, alpha=0.3)

# === BOTTOM RIGHT: time/log(n) for DBMS ===
ax = axes[1, 1]
mask_dbms = n_ins_dbms_smooth > 100
dbms_ratio_ins = dbms_ins_smooth[mask_dbms] / np.log2(n_ins_dbms_smooth[mask_dbms])
dbms_ratio_del = dbms_del_smooth[tree_del_dbms_smooth > 100] / np.log2(tree_del_dbms_smooth[tree_del_dbms_smooth > 100])

ax.plot(n_ins_dbms_smooth[mask_dbms], dbms_ratio_ins, 'b-', linewidth=1, label='Insert')
tree_del_dbms_valid = tree_del_dbms_smooth[tree_del_dbms_smooth > 100]
ax.plot(tree_del_dbms_valid, dbms_ratio_del, 'r-', linewidth=1, label='Delete')

mean_ins_d = np.mean(dbms_ratio_ins)
mean_del_d = np.mean(dbms_ratio_del)
ax.axhline(mean_ins_d, color='b', linestyle='--', alpha=0.7, label=f'Insert mean: {mean_ins_d:.5f}')
ax.axhline(mean_del_d, color='r', linestyle='--', alpha=0.7, label=f'Delete mean: {mean_del_d:.5f}')

cv_ins_d = np.std(dbms_ratio_ins) / mean_ins_d * 100
cv_del_d = np.std(dbms_ratio_del) / mean_del_d * 100
ax.set_xlabel('Tree Size')
ax.set_ylabel('time / log2(n)')
ax.set_title(f'DBMS ({N_dbms:,}): time/log(n) - Insert CV={cv_ins_d:.1f}%, Delete CV={cv_del_d:.1f}%')
ax.legend(loc='upper right')
ax.grid(True, alpha=0.3)

plt.suptitle(f'Performance Comparison: B+ Tree ({N_btree:,}) vs DBMS ({N_dbms:,} documents)', fontsize=14)
plt.tight_layout()
plt.savefig(IMAGES_DIR + 'btree_vs_dbms_performance.png', dpi=150, bbox_inches='tight')
print("Saved " + IMAGES_DIR + "btree_vs_dbms_performance.png")

# Print summary
print("\n" + "=" * 70)
print(f"SUMMARY: B+ Tree ({N_btree:,}) vs DBMS ({N_dbms:,})")
print("=" * 70)
print(f"\nB+ TREE ({N_btree:,} documents):")
print(f"  Insert time/log(n) CV: {cv_ins:.1f}% {'✅' if cv_ins < 20 else '⚠️'}")
print(f"  Delete time/log(n) CV: {cv_del:.1f}% {'✅' if cv_del < 20 else '⚠️'}")
print(f"  Mean insert time: {np.mean(btree_inserts):.4f} ms")
print(f"  Mean delete time: {np.mean(btree_deletes):.4f} ms")

print(f"\nDBMS ({N_dbms:,} documents):")
print(f"  Insert time/log(n) CV: {cv_ins_d:.1f}% {'✅' if cv_ins_d < 20 else '⚠️'}")
print(f"  Delete time/log(n) CV: {cv_del_d:.1f}% {'✅' if cv_del_d < 20 else '⚠️'}")
print(f"  Mean insert time: {np.mean(dbms_inserts):.4f} ms")
print(f"  Mean delete time: {np.mean(dbms_deletes):.4f} ms")

print("\nOverhead ratio (DBMS / B+ Tree):")
print(f"  Insert: {np.mean(dbms_inserts) / np.mean(btree_inserts):.1f}x")
print(f"  Delete: {np.mean(dbms_deletes) / np.mean(btree_deletes):.1f}x")
