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

def batch_average_with_sizes(sizes, times, batch_size=BATCH_SIZE):
    """Batch-average both tree sizes and times together."""
    n = len(times)
    n_batches = n // batch_size
    s = sizes[:n_batches * batch_size].reshape(n_batches, batch_size).mean(axis=1)
    t = times[:n_batches * batch_size].reshape(n_batches, batch_size).mean(axis=1)
    return s, t

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

N_btree = len(btree_inserts)
N_dbms = len(dbms_inserts)

# Create figure with 4 subplots
fig, axes = plt.subplots(2, 2, figsize=(16, 12))

# Batch-average inserts
btree_ins_x, btree_ins_y = batch_average(btree_inserts)
dbms_ins_x, dbms_ins_y = batch_average(dbms_inserts)

# Batch-average deletes (tree size decreases)
btree_del_sizes = N_btree - np.arange(N_btree)
dbms_del_sizes = N_dbms - np.arange(N_dbms)
btree_del_sx, btree_del_ty = batch_average_with_sizes(btree_del_sizes, btree_deletes)
dbms_del_sx, dbms_del_ty = batch_average_with_sizes(dbms_del_sizes, dbms_deletes)

# === TOP LEFT: Insert comparison ===
ax = axes[0, 0]
ax.semilogx(btree_ins_x, btree_ins_y, 'b-', linewidth=1, label=f'B+ Tree Insert ({N_btree:,})')
ax.semilogx(dbms_ins_x, dbms_ins_y, 'g-', linewidth=1, label=f'DBMS Insert ({N_dbms:,})')

k_btree = np.mean(btree_ins_y) / np.mean(np.log2(btree_ins_x))
k_dbms = np.mean(dbms_ins_y) / np.mean(np.log2(dbms_ins_x))
ax.semilogx(btree_ins_x, k_btree * np.log2(btree_ins_x), 'b--', linewidth=2, alpha=0.5, label='B+ Tree O(log n) fit')
ax.semilogx(dbms_ins_x, k_dbms * np.log2(dbms_ins_x), 'g--', linewidth=2, alpha=0.5, label='DBMS O(log n) fit')

ax.set_xlabel('Tree Size (log scale)')
ax.set_ylabel(f'Time per operation (ms, avg of {BATCH_SIZE})')
ax.set_title('INSERT: B+ Tree vs DBMS')
ax.legend()
ax.grid(True, alpha=0.3)

# === TOP RIGHT: Delete comparison ===
ax = axes[0, 1]
ax.semilogx(btree_del_sx, btree_del_ty, 'b-', linewidth=1, label=f'B+ Tree Delete ({N_btree:,})')
ax.semilogx(dbms_del_sx, dbms_del_ty, 'g-', linewidth=1, label=f'DBMS Delete ({N_dbms:,})')

k_btree_d = np.mean(btree_del_ty) / np.mean(np.log2(btree_del_sx))
k_dbms_d = np.mean(dbms_del_ty) / np.mean(np.log2(dbms_del_sx))
ax.semilogx(btree_del_sx, k_btree_d * np.log2(btree_del_sx), 'b--', linewidth=2, alpha=0.5, label='B+ Tree O(log n) fit')
ax.semilogx(dbms_del_sx, k_dbms_d * np.log2(dbms_del_sx), 'g--', linewidth=2, alpha=0.5, label='DBMS O(log n) fit')

ax.set_xlabel('Tree Size (log scale)')
ax.set_ylabel(f'Time per operation (ms, avg of {BATCH_SIZE})')
ax.set_title('DELETE: B+ Tree vs DBMS')
ax.legend()
ax.grid(True, alpha=0.3)

# === BOTTOM LEFT: time/log(n) for B+ tree ===
ax = axes[1, 0]
mask_btree_ins = btree_ins_x > 100
btree_ratio_ins = btree_ins_y[mask_btree_ins] / np.log2(btree_ins_x[mask_btree_ins])
mask_btree_del = btree_del_sx > 100
btree_ratio_del = btree_del_ty[mask_btree_del] / np.log2(btree_del_sx[mask_btree_del])

ax.plot(btree_ins_x[mask_btree_ins], btree_ratio_ins, 'b-', linewidth=1, label='Insert')
ax.plot(btree_del_sx[mask_btree_del], btree_ratio_del, 'r-', linewidth=1, label='Delete')

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
mask_dbms_ins = dbms_ins_x > 100
dbms_ratio_ins = dbms_ins_y[mask_dbms_ins] / np.log2(dbms_ins_x[mask_dbms_ins])
mask_dbms_del = dbms_del_sx > 100
dbms_ratio_del = dbms_del_ty[mask_dbms_del] / np.log2(dbms_del_sx[mask_dbms_del])

ax.plot(dbms_ins_x[mask_dbms_ins], dbms_ratio_ins, 'b-', linewidth=1, label='Insert')
ax.plot(dbms_del_sx[mask_dbms_del], dbms_ratio_del, 'r-', linewidth=1, label='Delete')

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
print(f"  Insert time/log(n) CV: {cv_ins:.1f}%")
print(f"  Delete time/log(n) CV: {cv_del:.1f}%")
print(f"  Mean insert time: {np.mean(btree_inserts):.4f} ms")
print(f"  Mean delete time: {np.mean(btree_deletes):.4f} ms")

print(f"\nDBMS ({N_dbms:,} documents):")
print(f"  Insert time/log(n) CV: {cv_ins_d:.1f}%")
print(f"  Delete time/log(n) CV: {cv_del_d:.1f}%")
print(f"  Mean insert time: {np.mean(dbms_inserts):.4f} ms")
print(f"  Mean delete time: {np.mean(dbms_deletes):.4f} ms")

print("\nOverhead ratio (DBMS / B+ Tree):")
print(f"  Insert: {np.mean(dbms_inserts) / np.mean(btree_inserts):.1f}x")
print(f"  Delete: {np.mean(dbms_deletes) / np.mean(btree_deletes):.1f}x")
