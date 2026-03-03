import json
import matplotlib.pyplot as plt
import numpy as np

RESULTS_DIR = 'results/'
IMAGES_DIR = 'results/images/'

BATCH_SIZE = 500

def batch_average(data, batch_size=BATCH_SIZE):
    """Bin data into non-overlapping batches and return (midpoints, averages)."""
    n = len(data)
    n_batches = n // batch_size
    trimmed = data[:n_batches * batch_size].reshape(n_batches, batch_size)
    avgs = trimmed.mean(axis=1)
    midpoints = np.arange(batch_size // 2, n_batches * batch_size, batch_size)
    return midpoints, avgs

# Load the performance data
with open(RESULTS_DIR + 'performance_results.txt', 'r') as f:
    data = json.load(f)

inserts = np.array(data[0])
deletes = np.array(data[1])

print(f"Total insertions: {len(inserts)}")
print(f"Total deletions: {len(deletes)}")

# Create cleaner visualization
fig, axes = plt.subplots(2, 2, figsize=(14, 10))

# Batch-average the data
ins_x, ins_y = batch_average(inserts)
del_sizes = len(deletes) - np.arange(len(deletes))
del_x, del_y = batch_average(del_sizes), batch_average(deletes)
# For deletes, tree size decreases; batch the sizes and times together
n_del = len(deletes)
n_batches_del = n_del // BATCH_SIZE
del_sizes_batched = del_sizes[:n_batches_del * BATCH_SIZE].reshape(n_batches_del, BATCH_SIZE).mean(axis=1)
del_times_batched = deletes[:n_batches_del * BATCH_SIZE].reshape(n_batches_del, BATCH_SIZE).mean(axis=1)

# === TOP LEFT: Insert times ===
ax1 = axes[0, 0]
ax1.semilogx(ins_x, ins_y, 'b-', linewidth=1, label='Insert time')
k = np.mean(ins_y) / np.mean(np.log2(ins_x))
ax1.semilogx(ins_x, k * np.log2(ins_x), 'r--', linewidth=2, label=f'O(log n) ref: {k:.4f}*log2(n)')
ax1.set_xlabel('Tree size (log scale)')
ax1.set_ylabel(f'Time per insert (ms, avg of {BATCH_SIZE})')
ax1.set_title('INSERT: Time vs Tree Size')
ax1.legend()
ax1.grid(True, alpha=0.3)

# === TOP RIGHT: Delete times ===
ax2 = axes[0, 1]
ax2.semilogx(del_sizes_batched, del_times_batched, 'g-', linewidth=1, label='Delete time')
k = np.mean(del_times_batched) / np.mean(np.log2(del_sizes_batched))
ax2.semilogx(del_sizes_batched, k * np.log2(del_sizes_batched), 'r--', linewidth=2, label=f'O(log n) ref: {k:.4f}*log2(n)')
ax2.set_xlabel('Tree size (log scale)')
ax2.set_ylabel(f'Time per delete (ms, avg of {BATCH_SIZE})')
ax2.set_title('DELETE: Time vs Tree Size')
ax2.legend()
ax2.grid(True, alpha=0.3)

# === BOTTOM LEFT: time/log(n) for insert ===
ax3 = axes[1, 0]
mask_ins = ins_x > 100
ratio_insert = ins_y[mask_ins] / np.log2(ins_x[mask_ins])
ax3.plot(ins_x[mask_ins], ratio_insert, 'b-', linewidth=1)
ax3.axhline(np.mean(ratio_insert), color='r', linestyle='--', label=f'Mean: {np.mean(ratio_insert):.4f}')
ax3.fill_between(ins_x[mask_ins], np.mean(ratio_insert)*0.8, np.mean(ratio_insert)*1.2, alpha=0.2, color='r', label='\u00b120% band')
ax3.set_xlabel('Tree size')
ax3.set_ylabel('time / log2(n)')
ax3.set_title('INSERT: time/log(n) ratio - should be FLAT for O(log n)')
ax3.legend()
ax3.grid(True, alpha=0.3)

# === BOTTOM RIGHT: time/log(n) for delete ===
ax4 = axes[1, 1]
mask_del = del_sizes_batched > 100
ratio_delete = del_times_batched[mask_del] / np.log2(del_sizes_batched[mask_del])
ax4.plot(del_sizes_batched[mask_del], ratio_delete, 'g-', linewidth=1)
ax4.axhline(np.mean(ratio_delete), color='r', linestyle='--', label=f'Mean: {np.mean(ratio_delete):.4f}')
ax4.fill_between(del_sizes_batched[mask_del], np.mean(ratio_delete)*0.8, np.mean(ratio_delete)*1.2, alpha=0.2, color='r', label='\u00b120% band')
ax4.set_xlabel('Tree size')
ax4.set_ylabel('time / log2(n)')
ax4.set_title('DELETE: time/log(n) ratio - should be FLAT for O(log n)')
ax4.legend()
ax4.grid(True, alpha=0.3)

plt.tight_layout()
plt.savefig(IMAGES_DIR + 'performance_graphs.png', dpi=150)

print("\n" + "=" * 60)
print("COEFFICIENT OF VARIATION ANALYSIS")
print("=" * 60)

cv_insert = np.std(ratio_insert) / np.mean(ratio_insert) * 100
print(f"\nInsert ratio CV: {cv_insert:.1f}%")

cv_delete = np.std(ratio_delete) / np.mean(ratio_delete) * 100
print(f"Delete ratio CV: {cv_delete:.1f}%")

print("\n" + "=" * 60)
print("TREND ANALYSIS")
print("=" * 60)

first_third = ratio_insert[:len(ratio_insert)//3]
last_third = ratio_insert[-len(ratio_insert)//3:]
insert_trend = (np.mean(last_third) - np.mean(first_third)) / np.mean(first_third) * 100
print(f"\nInsert ratio change from first to last third: {insert_trend:+.1f}%")

first_third_del = ratio_delete[:len(ratio_delete)//3]
last_third_del = ratio_delete[-len(ratio_delete)//3:]
delete_trend = (np.mean(last_third_del) - np.mean(first_third_del)) / np.mean(first_third_del) * 100
print(f"Delete ratio change from first to last third: {delete_trend:+.1f}%")

print("\nInterpretation:")
print("  For O(log n): ratio should stay constant (\u00b115% is acceptable)")
print("  For O(sqrt n): ratio would increase by ~2x when n increases 4x")
print("  For O(n): ratio would increase linearly with n")
