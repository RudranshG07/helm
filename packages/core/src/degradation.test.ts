import { describe, expect, it } from 'vitest';
import { DEFAULT_MIN_CURRENT_SAMPLES, detectDegradation } from './degradation.ts';

const healthyBaseline = { attempts: 1000, successes: 900 };

describe('the volume gate is the whole thing', () => {
  it('refuses to fire on two failures out of two', () => {
    const v = detectDegradation({ baseline: healthyBaseline, current: { attempts: 2, successes: 0 } });
    expect(v.degraded).toBe(false);
    expect(v.reason).toBe('insufficient_current_volume');
  });

  it('refuses to fire just below the sample floor, even on a total collapse', () => {
    const n = DEFAULT_MIN_CURRENT_SAMPLES - 1;
    const v = detectDegradation({ baseline: healthyBaseline, current: { attempts: n, successes: 0 } });
    expect(v.degraded).toBe(false);
  });

  it('fires at the sample floor on a total collapse', () => {
    const v = detectDegradation({
      baseline: healthyBaseline,
      current: { attempts: DEFAULT_MIN_CURRENT_SAMPLES, successes: 0 },
    });
    expect(v.degraded).toBe(true);
  });

  it('refuses to fire without enough baseline to compare against', () => {
    const v = detectDegradation({
      baseline: { attempts: 10, successes: 9 },
      current: { attempts: 100, successes: 10 },
    });
    expect(v.degraded).toBe(false);
    expect(v.reason).toBe('insufficient_baseline_volume');
  });
});

describe('it distinguishes a real drop from noise', () => {
  it('does not fire when the current rate matches the baseline', () => {
    const v = detectDegradation({ baseline: healthyBaseline, current: { attempts: 100, successes: 90 } });
    expect(v.degraded).toBe(false);
    expect(v.reason).toBe('within_normal_variation');
  });

  it('does not fire on a small dip within sampling noise', () => {
    const v = detectDegradation({ baseline: healthyBaseline, current: { attempts: 100, successes: 86 } });
    expect(v.degraded).toBe(false);
  });

  it('fires on a large drop with volume behind it', () => {
    const v = detectDegradation({ baseline: healthyBaseline, current: { attempts: 100, successes: 55 } });
    expect(v.degraded).toBe(true);
    expect(v.z).toBeGreaterThan(2.5);
  });

  it('never fires when the current rate is better than the baseline', () => {
    const v = detectDegradation({ baseline: healthyBaseline, current: { attempts: 200, successes: 200 } });
    expect(v.degraded).toBe(false);
    expect(v.z).toBeLessThan(0);
  });

  it('needs more evidence from a smaller sample than a larger one', () => {
    const small = detectDegradation({ baseline: healthyBaseline, current: { attempts: 25, successes: 20 } });
    const large = detectDegradation({ baseline: healthyBaseline, current: { attempts: 400, successes: 320 } });
    expect(small.current_rate).toBe(large.current_rate);
    expect(small.degraded).toBe(false);
    expect(large.degraded).toBe(true);
  });

  it('is tunable, so an operator can trade sensitivity against false alarms', () => {
    const current = { attempts: 100, successes: 80 };
    expect(detectDegradation({ baseline: healthyBaseline, current, zThreshold: 10 }).degraded).toBe(false);
    expect(detectDegradation({ baseline: healthyBaseline, current, zThreshold: 1 }).degraded).toBe(true);
  });
});

describe('it is total', () => {
  it.each([
    [{ attempts: 0, successes: 0 }, { attempts: 0, successes: 0 }],
    [{ attempts: 100, successes: 100 }, { attempts: 100, successes: 100 }],
    [{ attempts: 100, successes: 0 }, { attempts: 100, successes: 0 }],
    [{ attempts: -1, successes: -1 }, { attempts: 50, successes: 10 }],
  ])('does not throw on %j / %j', (baseline, current) => {
    const v = detectDegradation({ baseline, current });
    expect(v).toBeDefined();
    expect(typeof v.degraded).toBe('boolean');
  });

  it('always reports the sample size behind the verdict', () => {
    expect(detectDegradation({ baseline: healthyBaseline, current: { attempts: 42, successes: 5 } }).sample_size).toBe(42);
  });
});
