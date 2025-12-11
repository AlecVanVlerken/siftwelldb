import json
import matplotlib.pyplot as plt
import numpy as np

RESULTS_DIR = 'results/'
IMAGES_DIR = 'results/images/'

# Load the performance data
with open(RESULTS_DIR + 'performance_results.txt', 'r') as f:
    data = json.load(f)

inserts = np.array(data[0])
deletes = np.array(data[1])

print(f"Total insertions: {len(inserts)}")
print(f"Total deletions: {len(deletes)}")

# Create cleaner visualization
fig, axes = plt.subplots(2, 2, figsize=(14, 10))

window = 500  # Larger smoothing window for 50k data

# === TOP LEFT: Insert times (raw + smoothed) ===
ax1 = axes[0, 0]
n = np.arange(1, len(inserts) + 1)
inserts_smooth = np.convolve(inserts, np.ones(window)/window, mode='valid')
n_smooth = n[window//2:len(inserts_smooth)+window//2]

ax1.semilogx(n_smooth, inserts_smooth, 'b-', linewidth=1, label='Insert time (smoothed)')
# O(log n) reference
k = np.mean(inserts_smooth) / np.mean(np.log2(n_smooth))
ax1.semilogx(n_smooth, k * np.log2(n_smooth), 'r--', linewidth=2, label=f'O(log n) ref: {k:.4f}*log2(n)')
ax1.set_xlabel('Tree size (log scale)')
ax1.set_ylabel('Time per insert (ms)')
ax1.set_title(f'INSERT: Time vs Tree Size (window={window})')
ax1.legend()
ax1.grid(True, alpha=0.3)

# === TOP RIGHT: Delete times ===
ax2 = axes[0, 1]
# For deletions, tree_size = total - deletion_index
# First deletion is on tree of size N, last is on tree of size 1
tree_sizes = len(deletes) - np.arange(len(deletes))
deletes_smooth = np.convolve(deletes, np.ones(window)/window, mode='valid')
tree_sizes_smooth = tree_sizes[window//2:len(deletes_smooth)+window//2]

ax2.semilogx(tree_sizes_smooth, deletes_smooth, 'g-', linewidth=1, label='Delete time (smoothed)')
# O(log n) reference
k = np.mean(deletes_smooth) / np.mean(np.log2(tree_sizes_smooth))
ax2.semilogx(tree_sizes_smooth, k * np.log2(tree_sizes_smooth), 'r--', linewidth=2, label=f'O(log n) ref: {k:.4f}*log2(n)')
ax2.set_xlabel('Tree size (log scale)')
ax2.set_ylabel('Time per delete (ms)')
ax2.set_title(f'DELETE: Time vs Tree Size (window={window})')
ax2.legend()
ax2.grid(True, alpha=0.3)

# === BOTTOM LEFT: time/log(n) for insert ===
ax3 = axes[1, 0]
ratio_insert = inserts_smooth / np.log2(n_smooth)
ax3.plot(n_smooth, ratio_insert, 'b-', linewidth=1)
ax3.axhline(np.mean(ratio_insert), color='r', linestyle='--', label=f'Mean: {np.mean(ratio_insert):.4f}')
ax3.fill_between(n_smooth, np.mean(ratio_insert)*0.8, np.mean(ratio_insert)*1.2, alpha=0.2, color='r', label='±20% band')
ax3.set_xlabel('Tree size')
ax3.set_ylabel('time / log2(n)')
ax3.set_title('INSERT: time/log(n) ratio - should be FLAT for O(log n)')
ax3.legend()
ax3.grid(True, alpha=0.3)

# === BOTTOM RIGHT: time/log(n) for delete ===
ax4 = axes[1, 1]
# Filter very small trees
mask = tree_sizes_smooth > 100
ratio_delete = deletes_smooth[mask] / np.log2(tree_sizes_smooth[mask])
ax4.plot(tree_sizes_smooth[mask], ratio_delete, 'g-', linewidth=1)
ax4.axhline(np.mean(ratio_delete), color='r', linestyle='--', label=f'Mean: {np.mean(ratio_delete):.4f}')
ax4.fill_between(tree_sizes_smooth[mask], np.mean(ratio_delete)*0.8, np.mean(ratio_delete)*1.2, alpha=0.2, color='r', label='±20% band')
ax4.set_xlabel('Tree size')
ax4.set_ylabel('time / log2(n)')
ax4.set_title('DELETE: time/log(n) ratio - should be FLAT for O(log n)')
ax4.legend()
ax4.grid(True, alpha=0.3)

plt.tight_layout()
plt.savefig(IMAGES_DIR + 'performance_graphs.png', dpi=150)
# plt.show()  # Skip interactive display

print("\n" + "=" * 60)
print("COEFFICIENT OF VARIATION ANALYSIS")
print("=" * 60)

# Calculate CV for insert ratio
cv_insert = np.std(ratio_insert) / np.mean(ratio_insert) * 100
print(f"\nInsert ratio CV: {cv_insert:.1f}%")

# Calculate CV for delete ratio
cv_delete = np.std(ratio_delete) / np.mean(ratio_delete) * 100
print(f"Delete ratio CV: {cv_delete:.1f}%")

print("\n" + "=" * 60)
print("TREND ANALYSIS")
print("=" * 60)

# Check if ratio increases with tree size (for insert) 
# or decreases with tree size (for delete - which would be bad)
first_third = ratio_insert[:len(ratio_insert)//3]
last_third = ratio_insert[-len(ratio_insert)//3:]
insert_trend = (np.mean(last_third) - np.mean(first_third)) / np.mean(first_third) * 100
print(f"\nInsert ratio change from first to last third: {insert_trend:+.1f}%")

# For delete, tree gets smaller, so first third is BIG trees, last third is SMALL trees
first_third_del = ratio_delete[:len(ratio_delete)//3]
last_third_del = ratio_delete[-len(ratio_delete)//3:]
delete_trend = (np.mean(last_third_del) - np.mean(first_third_del)) / np.mean(first_third_del) * 100
print(f"Delete ratio change from first to last third: {delete_trend:+.1f}%")

print("\nInterpretation:")
print("  For O(log n): ratio should stay constant (±15% is acceptable)")
print("  For O(sqrt n): ratio would increase by ~2x when n increases 4x")
print("  For O(n): ratio would increase linearly with n")
