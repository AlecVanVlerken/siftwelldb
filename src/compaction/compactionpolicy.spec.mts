import assert from 'assert';
import { describe, it } from 'vitest';

import { CompactionPolicy } from './compactionpolicy.mjs';
import type { IncrementalCompactionMetrics } from './incrementaltypes.mjs';

function metrics(overrides: Partial<IncrementalCompactionMetrics> = {}): IncrementalCompactionMetrics {
  return {
    fileSizeBytes: 1000,
    liveDataBytes: 800,
    wastedBytes: 200,
    amplification: 1.25,
    totalBlocks: 10,
    freeBlocks: 2,
    usedBlocks: 8,
    freeTailBlocks: 0,
    ...overrides,
  };
}

describe('CompactionPolicy', () => {
  it('does not compact below the amplification threshold', () => {
    const policy = new CompactionPolicy({ maxAmplification: 1.5 });

    assert.strictEqual(policy.shouldCompact(metrics()), false);
    assert.strictEqual(policy.getReason(metrics()), undefined);
  });

  it('compacts above the amplification threshold', () => {
    const policy = new CompactionPolicy({ maxAmplification: 1.5 });
    const high = metrics({ amplification: 1.75 });

    assert.strictEqual(policy.shouldCompact(high), true);
    assert(policy.getReason(high)?.includes('amplification'));
  });

  it('uses soft amplification when provided', () => {
    const policy = new CompactionPolicy({ maxAmplification: 2.0, softAmplification: 1.2 });

    assert.strictEqual(policy.shouldCompact(metrics({ amplification: 1.25 })), true);
    assert.strictEqual(policy.shouldEscalate(metrics({ amplification: 1.25 })), false);
  });

  it('compacts when a free tail is available', () => {
    const policy = new CompactionPolicy({ maxAmplification: 10 });
    const withTail = metrics({ amplification: 1.0, freeTailBlocks: 2 });

    assert.strictEqual(policy.shouldCompact(withTail), true);
    assert(policy.getReason(withTail)?.includes('free tail'));
  });
});
