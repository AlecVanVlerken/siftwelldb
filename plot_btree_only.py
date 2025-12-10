import json
import numpy as np
import matplotlib.pyplot as plt

# Load B+ tree data
with open('btree_performance_results.txt', 'r') as f:
    btree_data = json.load(f)

btree_inserts = np.array(btree_data[0])
btree_deletes = np.array(btree_data[1])

N_btree = len(btree_inserts)
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

# Smooth data
btree_ins_smooth = smooth(btree_inserts, window)
btree_del_smooth = smooth(btree_deletes, window)

# === TOP LEFT: Insert time vs tree size (log scale) ===
ax = axes[0, 0]
ax.semilogx(n_ins_btree_smooth, btree_ins_smooth, 'b-', linewidth=1, label='B+ Tree Insert')

# O(log n) reference
k_btree = np.mean(btree_ins_smooth) / np.mean(np.log2(n_ins_btree_smooth))
ax.semilogx(n_ins_btree_smooth, k_btree * np.log2(n_ins_btree_smooth), 'r--', linewidth=2, alpha=0.7, label='O(log n) fit')

ax.set_xlabel('Tree Size (log scale)')
ax.set_ylabel('Time per operation (ms)')
ax.set_title(f'INSERT: Time vs Tree Size ({N_btree:,} documents)')
ax.legend()
ax.grid(True, alpha=0.3)

# === TOP RIGHT: Delete time vs tree size (log scale) ===
ax = axes[0, 1]
ax.semilogx(tree_del_btree_smooth, btree_del_smooth, 'b-', linewidth=1, label='B+ Tree Delete')

# O(log n) reference
k_btree_d = np.mean(btree_del_smooth) / np.mean(np.log2(tree_del_btree_smooth))
ax.semilogx(tree_del_btree_smooth, k_btree_d * np.log2(tree_del_btree_smooth), 'r--', linewidth=2, alpha=0.7, label='O(log n) fit')

ax.set_xlabel('Tree Size (log scale)')
ax.set_ylabel('Time per operation (ms)')
ax.set_title(f'DELETE: Time vs Tree Size ({N_btree:,} documents)')
ax.legend()
ax.grid(True, alpha=0.3)

# === BOTTOM LEFT: time/log(n) for Insert ===
ax = axes[1, 0]
mask_btree = n_ins_btree_smooth > 100
btree_ratio_ins = btree_ins_smooth[mask_btree] / np.log2(n_ins_btree_smooth[mask_btree])

ax.plot(n_ins_btree_smooth[mask_btree], btree_ratio_ins, 'b-', linewidth=1, label='Insert time/log(n)')

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
btree_ratio_del = btree_del_smooth[tree_del_btree_smooth > 100] / np.log2(tree_del_btree_smooth[tree_del_btree_smooth > 100])
tree_del_btree_valid = tree_del_btree_smooth[tree_del_btree_smooth > 100]

ax.plot(tree_del_btree_valid, btree_ratio_del, 'b-', linewidth=1, label='Delete time/log(n)')

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
plt.savefig('btree_only_performance.png', dpi=150, bbox_inches='tight')
print("Saved btree_only_performance.png")

# Print summary
print("\n" + "=" * 70)
print(f"B+ TREE PERFORMANCE SUMMARY ({N_btree:,} documents)")
print("=" * 70)
print(f"\nInsert:")
print(f"  time/log(n) CV: {cv_ins:.1f}% {'✅' if cv_ins < 20 else '⚠️'}")
print(f"  Mean time: {np.mean(btree_inserts):.4f} ms")
print(f"  Min time: {np.min(btree_inserts):.4f} ms")
print(f"  Max time: {np.max(btree_inserts):.4f} ms")

print(f"\nDelete:")
print(f"  time/log(n) CV: {cv_del:.1f}% {'✅' if cv_del < 20 else '⚠️'}")
print(f"  Mean time: {np.mean(btree_deletes):.4f} ms")
print(f"  Min time: {np.min(btree_deletes):.4f} ms")
print(f"  Max time: {np.max(btree_deletes):.4f} ms")
