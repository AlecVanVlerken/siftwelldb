/// Squared Euclidean distance between two equal-length f32 slices.
///
/// Written as a tight loop with `get_unchecked` so the compiler (LLVM at
/// opt-level=3 + target-cpu=native) can auto-vectorise into AVX2 instructions.
/// dim=384 → 48 × f32x8 chunks = zero scalar tail on any x86-64 AVX2 CPU.
#[inline(always)]
pub fn l2_squared(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let len = a.len();
    let mut acc = 0.0f32;
    // SAFETY: both slices are `len` long (asserted above).
    for i in 0..len {
        let d = unsafe { a.get_unchecked(i) - b.get_unchecked(i) };
        acc += d * d;
    }
    acc
}
