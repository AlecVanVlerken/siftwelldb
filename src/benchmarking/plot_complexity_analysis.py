import json
import numpy as np
import matplotlib.pyplot as plt
from scipy.optimize import curve_fit

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

# Load DBMS performance data
with open(RESULTS_DIR + 'performance_results.txt', 'r') as f:
    data = json.load(f)
    insert_times = np.array(data[0])
    delete_times = np.array(data[1])

# Create n values (1 to len)
n_insert = np.arange(1, len(insert_times) + 1)
n_delete = np.arange(len(delete_times), 0, -1)

# Define complexity models
def O_1(n, a):
    return a * np.ones_like(n, dtype=float)

def O_log_n(n, a):
    return a * np.log2(np.maximum(n, 1))

def O_log_n_pow_1_1(n, a):
    return a * np.power(np.log2(np.maximum(n, 1)), 1.1)

def O_log_n_pow_1_2(n, a):
    return a * np.power(np.log2(np.maximum(n, 1)), 1.2)

def O_log_n_pow_1_25(n, a):
    return a * np.power(np.log2(np.maximum(n, 1)), 1.25)

def O_log_n_pow_1_3(n, a):
    return a * np.power(np.log2(np.maximum(n, 1)), 1.3)

def O_log_n_pow_1_4(n, a):
    return a * np.power(np.log2(np.maximum(n, 1)), 1.4)

def O_log_n_pow_1_5(n, a):
    return a * np.power(np.log2(np.maximum(n, 1)), 1.5)

def O_log_n_pow_1_6(n, a):
    return a * np.power(np.log2(np.maximum(n, 1)), 1.6)

def O_log_n_pow_1_7(n, a):
    return a * np.power(np.log2(np.maximum(n, 1)), 1.7)

def O_log_n_pow_1_75(n, a):
    return a * np.power(np.log2(np.maximum(n, 1)), 1.75)

def O_log_n_pow_1_8(n, a):
    return a * np.power(np.log2(np.maximum(n, 1)), 1.8)

def O_log_n_pow_1_9(n, a):
    return a * np.power(np.log2(np.maximum(n, 1)), 1.9)

def O_log_n_squared(n, a):
    return a * np.power(np.log2(np.maximum(n, 1)), 2)

def O_log_n_pow_2_5(n, a):
    return a * np.power(np.log2(np.maximum(n, 1)), 2.5)

def O_log_n_pow_3(n, a):
    return a * np.power(np.log2(np.maximum(n, 1)), 3)

def O_n_pow_0_1(n, a):
    return a * np.power(n, 0.1)

def O_n_pow_0_15(n, a):
    return a * np.power(n, 0.15)

def O_n_pow_0_2(n, a):
    return a * np.power(n, 0.2)

def O_n_pow_0_22(n, a):
    return a * np.power(n, 0.22)

def O_n_pow_0_24(n, a):
    return a * np.power(n, 0.24)

def O_n_pow_0_25(n, a):
    return a * np.power(n, 0.25)

def O_n_pow_0_26(n, a):
    return a * np.power(n, 0.26)

def O_n_pow_0_28(n, a):
    return a * np.power(n, 0.28)

def O_n_pow_0_3(n, a):
    return a * np.power(n, 0.3)

def O_n_pow_0_32(n, a):
    return a * np.power(n, 0.32)

def O_n_pow_0_34(n, a):
    return a * np.power(n, 0.34)

def O_n_pow_0_35(n, a):
    return a * np.power(n, 0.35)

def O_n_pow_0_38(n, a):
    return a * np.power(n, 0.38)

def O_n_pow_0_4(n, a):
    return a * np.power(n, 0.4)

def O_n_pow_0_45(n, a):
    return a * np.power(n, 0.45)

def O_sqrt_n(n, a):
    return a * np.sqrt(n)

def O_n(n, a):
    return a * n

def O_n_log_n(n, a):
    return a * n * np.log2(np.maximum(n, 1))

# Model definitions with names
models = [
    ('O(1)', O_1),
    ('O(log n)', O_log_n),
    ('O(log^1.1 n)', O_log_n_pow_1_1),
    ('O(log^1.2 n)', O_log_n_pow_1_2),
    ('O(log^1.25 n)', O_log_n_pow_1_25),
    ('O(log^1.3 n)', O_log_n_pow_1_3),
    ('O(log^1.4 n)', O_log_n_pow_1_4),
    ('O(log^1.5 n)', O_log_n_pow_1_5),
    ('O(log^1.6 n)', O_log_n_pow_1_6),
    ('O(log^1.7 n)', O_log_n_pow_1_7),
    ('O(log^1.75 n)', O_log_n_pow_1_75),
    ('O(log^1.8 n)', O_log_n_pow_1_8),
    ('O(log^1.9 n)', O_log_n_pow_1_9),
    ('O(log\u00b2 n)', O_log_n_squared),
    ('O(log^2.5 n)', O_log_n_pow_2_5),
    ('O(log\u00b3 n)', O_log_n_pow_3),
    ('O(n^0.1)', O_n_pow_0_1),
    ('O(n^0.15)', O_n_pow_0_15),
    ('O(n^0.2)', O_n_pow_0_2),
    ('O(n^0.22)', O_n_pow_0_22),
    ('O(n^0.24)', O_n_pow_0_24),
    ('O(n^0.25)', O_n_pow_0_25),
    ('O(n^0.26)', O_n_pow_0_26),
    ('O(n^0.28)', O_n_pow_0_28),
    ('O(n^0.3)', O_n_pow_0_3),
    ('O(n^0.32)', O_n_pow_0_32),
    ('O(n^0.34)', O_n_pow_0_34),
    ('O(n^0.35)', O_n_pow_0_35),
    ('O(n^0.38)', O_n_pow_0_38),
    ('O(n^0.4)', O_n_pow_0_4),
    ('O(n^0.45)', O_n_pow_0_45),
    ('O(\u221an)', O_sqrt_n),
    ('O(n)', O_n),
    ('O(n log n)', O_n_log_n),
]

def fit_and_score(n_vals, times, model_func):
    """Fit model to batch-averaged data and return R\u00b2 score."""
    try:
        bx, by = batch_average(times)
        # Use the corresponding n midpoints
        n_batches = len(times) // BATCH_SIZE
        n_mid = n_vals[:n_batches * BATCH_SIZE].reshape(n_batches, BATCH_SIZE).mean(axis=1)
        
        popt, _ = curve_fit(model_func, n_mid, by, p0=[1], maxfev=10000)
        
        predicted = model_func(n_mid, *popt)
        ss_res = np.sum((by - predicted) ** 2)
        ss_tot = np.sum((by - np.mean(by)) ** 2)
        r_squared = 1 - (ss_res / ss_tot)
        
        return r_squared, popt[0], n_mid, by, predicted
    except Exception:
        return -999, 0, None, None, None

# Analyze both insert and delete
results = {}
for op_name, n_vals, times in [('Insert', n_insert, insert_times), ('Delete', n_delete, delete_times)]:
    results[op_name] = []
    for model_name, model_func in models:
        r2, coef, n_s, t_s, pred = fit_and_score(n_vals, times, model_func)
        results[op_name].append((model_name, r2, coef, n_s, t_s, pred))

# Print results
print("=" * 80)
print("COMPLEXITY ANALYSIS RESULTS")
print("=" * 80)

for op_name in ['Insert', 'Delete']:
    print(f"\n{op_name} Operation:")
    print("-" * 60)
    sorted_results = sorted(results[op_name], key=lambda x: x[1], reverse=True)
    for i, (model_name, r2, coef, _, _, _) in enumerate(sorted_results):
        marker = "  \u2605 BEST FIT" if i == 0 else ""
        if r2 > -900:
            print(f"  {model_name:15} R\u00b2 = {r2:7.4f}  (coef = {coef:.6f}){marker}")
        else:
            print(f"  {model_name:15} FAILED TO FIT")

# Create visualization
fig, axes = plt.subplots(2, 2, figsize=(16, 12))

for idx, (op_name, n_vals, times) in enumerate([('Insert', n_insert, insert_times), ('Delete', n_delete, delete_times)]):
    sorted_results = sorted(results[op_name], key=lambda x: x[1], reverse=True)[:5]
    
    ax1 = axes[idx, 0]
    
    bx, by = batch_average(times)
    n_batches = len(times) // BATCH_SIZE
    n_mid = n_vals[:n_batches * BATCH_SIZE].reshape(n_batches, BATCH_SIZE).mean(axis=1)
    ax1.plot(n_mid, by, 'b-', alpha=0.7, linewidth=1, label=f'Data (avg of {BATCH_SIZE})')
    
    colors = ['red', 'orange', 'green', 'purple', 'brown']
    for i, (model_name, r2, coef, n_s, t_s, pred) in enumerate(sorted_results):
        if pred is not None:
            ax1.plot(n_s, pred, colors[i], linewidth=2, label=f'{model_name} (R\u00b2={r2:.4f})')
    
    ax1.set_xlabel('n (number of items)')
    ax1.set_ylabel('Time (ms)')
    ax1.set_title(f'{op_name}: Data vs Best Fit Models')
    ax1.legend(loc='upper left')
    ax1.grid(True, alpha=0.3)
    
    ax2 = axes[idx, 1]
    model_names = [r[0] for r in results[op_name] if r[1] > -900]
    r2_values = [r[1] for r in results[op_name] if r[1] > -900]
    
    colors_bar = ['green' if r2 > 0.9 else 'yellow' if r2 > 0.7 else 'orange' if r2 > 0.5 else 'red' for r2 in r2_values]
    
    bars = ax2.barh(model_names, r2_values, color=colors_bar)
    ax2.set_xlabel('R\u00b2 (higher = better fit)')
    ax2.set_title(f'{op_name}: Model Comparison (R\u00b2 values)')
    ax2.set_xlim(min(0, min(r2_values) - 0.1), 1.05)
    ax2.axvline(x=0.9, color='green', linestyle='--', alpha=0.5, label='Excellent (>0.9)')
    ax2.axvline(x=0.7, color='orange', linestyle='--', alpha=0.5, label='Good (>0.7)')
    ax2.grid(True, alpha=0.3, axis='x')
    
    for bar, r2 in zip(bars, r2_values):
        ax2.text(max(r2, 0) + 0.02, bar.get_y() + bar.get_height()/2, 
                f'{r2:.4f}', va='center', fontsize=9)

plt.tight_layout()
plt.savefig(IMAGES_DIR + 'complexity_analysis.png', dpi=150, bbox_inches='tight')
print(f"\nSaved {IMAGES_DIR}complexity_analysis.png")

# Summary
print("\n" + "=" * 80)
print("SUMMARY")
print("=" * 80)
best_insert = max(results['Insert'], key=lambda x: x[1])
best_delete = max(results['Delete'], key=lambda x: x[1])
print(f"\nInsert best fit: {best_insert[0]} with R\u00b2 = {best_insert[1]:.4f}")
print(f"Delete best fit: {best_delete[0]} with R\u00b2 = {best_delete[1]:.4f}")

if 'log' in best_insert[0].lower() and 'log' in best_delete[0].lower():
    print("\nBoth operations show logarithmic complexity - consistent with B+ tree O(log n)!")
elif best_insert[1] > 0.9 and best_delete[1] > 0.9:
    print(f"\nGood fits found but not pure O(log n)")
else:
    print(f"\nPerformance may not be optimal")
