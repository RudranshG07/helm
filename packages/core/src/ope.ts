export interface LoggedDecision {
  action: string;
  logging_propensity: number;
  target_propensity: number;
  reward_paise: number;
  predicted_reward_paise?: number;
}

export type SupportVerdict = 'usable' | 'weak_support' | 'no_support' | 'deterministic_logger';

export interface OpeEstimate {
  n: number;
  ips_paise: number | null;
  snips_paise: number | null;
  doubly_robust_paise: number | null;
  observed_paise: number;
  effective_sample_size: number;
  max_weight: number;
  clipped: number;
  support: SupportVerdict;
  explanation: string;
}

export const WEIGHT_CLIP = 20;
export const MIN_ESS = 30;
export const WEAK_ESS = 100;

function isDeterministic(rows: LoggedDecision[]): boolean {
  return rows.every((r) => r.logging_propensity >= 0.999);
}

export function evaluateOffPolicy(rows: LoggedDecision[]): OpeEstimate {
  const usable = rows.filter(
    (r) =>
      Number.isFinite(r.logging_propensity) &&
      Number.isFinite(r.target_propensity) &&
      r.logging_propensity > 0 &&
      Number.isFinite(r.reward_paise),
  );

  const observed = usable.reduce((sum, r) => sum + r.reward_paise, 0);

  const base = {
    n: usable.length,
    observed_paise: Math.round(observed),
    ips_paise: null,
    snips_paise: null,
    doubly_robust_paise: null,
    effective_sample_size: 0,
    max_weight: 0,
    clipped: 0,
  };

  if (usable.length === 0) {
    return {
      ...base,
      support: 'no_support',
      explanation: 'No decisions carried a usable logging propensity, so nothing can be estimated.',
    };
  }

  if (isDeterministic(usable)) {
    return {
      ...base,
      support: 'deterministic_logger',
      explanation:
        'Every logged decision was taken with certainty, so the data contains no counterfactual ' +
        'information about actions that were not taken. Importance sampling cannot recover an ' +
        'estimate from a deterministic logging policy. Randomising a small fraction of decisions ' +
        'creates the support this needs.',
    };
  }

  let clipped = 0;
  let maxWeight = 0;
  let sumW = 0;
  let sumW2 = 0;
  let ipsTotal = 0;
  let drTotal = 0;

  for (const r of usable) {
    const raw = r.target_propensity / r.logging_propensity;
    const w = Math.min(WEIGHT_CLIP, raw);
    if (raw > WEIGHT_CLIP) clipped += 1;
    maxWeight = Math.max(maxWeight, raw);

    sumW += w;
    sumW2 += w * w;
    ipsTotal += w * r.reward_paise;

    const predicted = r.predicted_reward_paise ?? 0;
    drTotal += predicted + w * (r.reward_paise - predicted);
  }

  const n = usable.length;
  const ess = sumW2 > 0 ? (sumW * sumW) / sumW2 : 0;

  const support: SupportVerdict =
    ess < MIN_ESS ? 'no_support' : ess < WEAK_ESS ? 'weak_support' : 'usable';

  const explanation =
    support === 'no_support'
      ? `Effective sample size is ${ess.toFixed(1)} against ${n} decisions. Below ${MIN_ESS} the ` +
        'estimate is dominated by a handful of high-weight observations and should not be quoted.'
      : support === 'weak_support'
        ? `Effective sample size is ${ess.toFixed(1)} against ${n} decisions. The estimate is ` +
          'directional but the interval around it is wide.'
        : `Effective sample size is ${ess.toFixed(1)} against ${n} decisions, which is enough ` +
          'overlap between the logged policy and the target policy to estimate a value.';

  return {
    n,
    ips_paise: Math.round(ipsTotal / n),
    snips_paise: sumW > 0 ? Math.round(ipsTotal / sumW) : null,
    doubly_robust_paise: Math.round(drTotal / n),
    observed_paise: Math.round(observed / n),
    effective_sample_size: Math.round(ess * 10) / 10,
    max_weight: Math.round(maxWeight * 100) / 100,
    clipped,
    support,
    explanation,
  };
}

export interface ExplorationChoice<T> {
  chosen: T;
  propensity: number;
  considered: number;
}

export function exploreAmong<T>(
  ranked: T[],
  epsilon: number,
  draw: number,
): ExplorationChoice<T> | null {
  if (ranked.length === 0) return null;

  const e = Math.min(1, Math.max(0, epsilon));
  const best = ranked[0]!;

  if (ranked.length === 1 || e === 0) {
    return { chosen: best, propensity: 1, considered: ranked.length };
  }

  const alternatives = ranked.length - 1;
  const pBest = 1 - e;
  const pOther = e / alternatives;

  if (draw < pBest) {
    return { chosen: best, propensity: pBest, considered: ranked.length };
  }

  const index = Math.min(alternatives, Math.max(1, Math.ceil((draw - pBest) / pOther)));
  return { chosen: ranked[index]!, propensity: pOther, considered: ranked.length };
}
