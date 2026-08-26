export interface WindowStats {
  attempts: number;
  successes: number;
}

export interface DegradationInput {
  baseline: WindowStats;
  current: WindowStats;
  minCurrentSamples?: number;
  minBaselineSamples?: number;
  zThreshold?: number;
}

export interface DegradationVerdict {
  degraded: boolean;
  reason:
    | 'insufficient_current_volume'
    | 'insufficient_baseline_volume'
    | 'within_normal_variation'
    | 'significant_drop';
  baseline_rate: number | null;
  current_rate: number | null;
  z: number | null;
  sample_size: number;
}

export const DEFAULT_MIN_CURRENT_SAMPLES = 20;
export const DEFAULT_MIN_BASELINE_SAMPLES = 50;
export const DEFAULT_Z_THRESHOLD = 2.5;

function rate(w: WindowStats): number | null {
  return w.attempts > 0 ? w.successes / w.attempts : null;
}

export function detectDegradation(input: DegradationInput): DegradationVerdict {
  const minCurrent = input.minCurrentSamples ?? DEFAULT_MIN_CURRENT_SAMPLES;
  const minBaseline = input.minBaselineSamples ?? DEFAULT_MIN_BASELINE_SAMPLES;
  const threshold = input.zThreshold ?? DEFAULT_Z_THRESHOLD;

  const baseline = input.baseline;
  const current = input.current;

  const baselineRate = rate(baseline);
  const currentRate = rate(current);

  const base = {
    baseline_rate: baselineRate,
    current_rate: currentRate,
    sample_size: current.attempts,
  };

  if (current.attempts < minCurrent) {
    return { degraded: false, reason: 'insufficient_current_volume', z: null, ...base };
  }
  if (baseline.attempts < minBaseline || baselineRate === null) {
    return { degraded: false, reason: 'insufficient_baseline_volume', z: null, ...base };
  }

  const pooled =
    (baseline.successes + current.successes) / (baseline.attempts + current.attempts);
  const variance = pooled * (1 - pooled) * (1 / baseline.attempts + 1 / current.attempts);

  if (variance <= 0) {
    return { degraded: false, reason: 'within_normal_variation', z: null, ...base };
  }

  const z = (baselineRate - currentRate!) / Math.sqrt(variance);

  if (z >= threshold) {
    return { degraded: true, reason: 'significant_drop', z: round(z), ...base };
  }
  return { degraded: false, reason: 'within_normal_variation', z: round(z), ...base };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
