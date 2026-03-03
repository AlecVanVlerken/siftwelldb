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

# Load B+ tree data
with open(RESULTS_DIR + 'btree_performance_results.txt', 'r') as f:
    btree_data = json.load(f)

btree_inserts = np.array(btree_data[0])
btree_deletes = np.array(btree_data[1])

N_btree = len(btree_inserts)

# Create figure with 4 subplots
fig, axes = plt.subplots(2, 2, figsize=(16, 12))

# Batch-average
ins_x, ins_y = batch_average(btree_inserts)

# For deletes, tree size decreases
n_batches_del = N_btree // BATCH_SIZE
del_sizes = N_btree - np.arange(N_btree)
del_sizes_batched = del_sizes[:n_batches_del * BATCH_SIZE].reshape(n_batches_del, BATCH_SIZE).mean(axis=1)
del_times_batched = btree_deletes[:n_batches_del * BATCH_SIZE].reshape(n_batches_del, BATCH_SIZE).mean(axis=1)

# === TOP LEFT: Insert time vs tree size (log scale) ===
ax = axes[0, 0]
ax.semilogx(ins_x, ins_y, 'b-', linewidth=1, label='B+ Tree Insert')

k_btree = np.mean(ins_y) / np.mean(np.log2(ins_x))
ax.semilogx(ins_x, k_btree * np.log2(ins_x), 'r--', linewidth=2, alpha=0.7, label='O(log n) fit')

ax.set_xlabel('Tree Size (log scale)')
ax.set_ylabel(f'Time per operation (ms, avg of {BATCH_SIZE})')
ax.set_title(f'INSERT: Time vs Tree Size ({N_btree:,} documents)')
ax.legend()
ax.grid(True, alpha=0.3)

# === TOP RIGHT: Delete time vs tree size (log scale) ===
ax = axes[0, 1]
ax.semilogx(del_sizes_batched, del_times_batched, 'b-', linewidth=1, label='B+ Tree Delete')

k_btree_d = np.mean(del_times_batched) / np.mean(np.log2(del_sizes_batched))
ax.semilogx(del_sizes_batched, k_btree_d * np.log2(del_sizes_batched), 'r--', linewidth=2, alpha=0.7, label='O(log n) fit')

ax.set_xlabel('Tree Size (log scale)')
ax.set_ylabel(f'Time per operation (ms, avg of {BATCH_SIZE})')
ax.set_title(f'DELETE: Time vs Tree Size ({N_btree:,} documents)')
ax.legend()
ax.grid(True, alpha=0.3)

# === BOTTOM LEFT: time/log(n) for Insert ===
ax = axes[1, 0]
mask_ins = ins_x > 100
btree_ratio_ins = ins_y[mask_ins] / np.log2(ins_x[mask_ins])

ax.plot(ins_x[mask_ins], btree_ratio_ins, 'b-', linewidth=1, label='Insert time/log(n)')

mean_ins = np.mean(btree_ratio_ins)
ax.axhline(mean_ins, color='r', linestyle='--', alpha=0.7, label=f'Mean: {mean_ins:.5f}')

cv_ins = np.std(btree_ratio_ins) / mean_ins * 100
ax.set_xlabel('Tree Size')
ax.set_ylabel('time / log2(n)')
ax.set_title(f'INSERT: time/log(n) ratio - CV={cv_ins:.1f}%')
ax.legend(loc='upper right')
ax.grid(True, alpha=0.3)

# === BOTTOM RIGHT: time/log(n) for Delete ===
ax = axes[1, 1]
mask_del = del_sizes_batched > 100
btree_ratio_del = del_times_batched[mask_del] / np.log2(del_sizes_batched[mask_del])

ax.plot(del_sizes_batched[mask_del], btree_ratio_del, 'b-', linewidth=1, label='Delete time/log(n)')

mean_del = np.mean(btree_ratio_del)
ax.axhline(mean_del, color='r', linestyle='--', alpha=0.7, label=f'Mean: {mean_del:.5f}')

cv_del = np.std(btree_ratio_del) / mean_del * 100
ax.set_xlabel('Tree Size')
ax.set_ylabel('time / log2(n)')
ax.set_title(f'DELETE: time/log(n) ratio - CV={cv_del:.1f}%')
ax.legend(loc='upper right')
ax.grid(True, alpha=0.3)

plt.suptitle(f'B+ Tree Performance Analysis ({N_btree:,} documents)', fontsize=14)
plt.tight_layout()
plt.savefig(IMAGES_DIR + 'btree_only_performance.png', dpi=150, bbox_inches='tight')
print("Saved " + IMAGES_DIR + "btree_only_performance.png")

# Print summary
print("\n" + "=" * 70)
print(f"B+ TREE PERFORMANCE SUMMARY ({N_btree:,} documents)")
print("=" * 70)
print(f"\nInsert:")
print(f"  time/log(n) CV: {cv_ins:.1f}%")
print(f"  Mean time: {np.mean(btree_inserts):.4f} ms")
print(f"  Min time: {np.min(btree_inserts):.4f} ms")
print(f"  Max time: {np.max(btree_inserts):.4f} ms")

print(f"\nDelete:")
print(f"  time/log(n) CV: {cv_del:.1f}%")
print(f"  Mean time: {np.mean(btree_deletes):.4f} ms")
print(f"  Min time: {np.min(btree_deletes):.4f} ms")
print(f"  Max time: {np.max(btree_deletes):.4f} ms")
