import type { Bucket, Method } from './types.ts';
import { isHard } from './taxonomy.ts';

export const NPCI_ATTEMPT_BUDGET = 4;

export type RiskBand = 'healthy' | 'at_risk' | 'critical';

export interface HealthInput {
  now: Date;
  consecutive_failures: number;
  attempts_used_this_cycle: number;
  mandate_expiry_at: Date | null;
  soft_decline_rate: number;
  issuer_degraded: boolean;
  method: Method;
  last_bucket: Bucket | null;
}

export interface HealthScore {
  risk_score: number;
  risk_band: RiskBand;
  attempts_remaining: number;
  days_to_expiry: number | null;
  contributions: Record<string, number>;
}

const DAY_MS = 86_400_000;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function safeInt(n: number): number {
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function failureWeight(consecutive: number): number {
  if (consecutive <= 0) return 0;
  if (consecutive === 1) return 0.35;
  if (consecutive === 2) return 0.55;
  return 0.75;
}

function budgetWeight(remaining: number): number {
  if (remaining <= 0) return 0.2;
  if (remaining === 1) return 0.12;
  if (remaining === 2) return 0.05;
  return 0;
}

function expiryWeight(days: number | null): number {
  if (days === null) return 0;
  if (days <= 0) return 0.25;
  if (days <= 7) return 0.2;
  if (days <= 30) return 0.08;
  return 0;
}

export function score(input: HealthInput): HealthScore {
  const consecutive = Math.max(0, safeInt(input.consecutive_failures));
  const used = Math.max(0, safeInt(input.attempts_used_this_cycle));
  const attempts_remaining = Math.max(0, NPCI_ATTEMPT_BUDGET - used);

  const expiryMs = input.mandate_expiry_at?.getTime();
  const days_to_expiry =
    expiryMs !== undefined && Number.isFinite(expiryMs)
      ? Math.floor((expiryMs - input.now.getTime()) / DAY_MS)
      : null;

  const hard = input.last_bucket !== null && isHard(input.last_bucket);

  const contributions: Record<string, number> = {
    consecutive_failures: failureWeight(consecutive),
    attempts_remaining: budgetWeight(attempts_remaining),
    days_to_expiry: expiryWeight(days_to_expiry),
    soft_decline_history: clamp01(input.soft_decline_rate) * 0.1,
    issuer_degraded: input.issuer_degraded ? 0.08 : 0,
    hard_decline: hard ? 0.3 : 0,
  };

  for (const key of Object.keys(contributions)) {
    contributions[key] = Math.round(contributions[key]! * 1000) / 1000;
  }

  const risk_score = Math.round(
    clamp01(Object.values(contributions).reduce((a, b) => a + b, 0)) * 1000,
  ) / 1000;

  const critical =
    hard ||
    attempts_remaining <= 1 ||
    (days_to_expiry !== null && days_to_expiry <= 7);

  const at_risk =
    consecutive >= 1 ||
    input.issuer_degraded ||
    (days_to_expiry !== null && days_to_expiry <= 30) ||
    input.soft_decline_rate >= 0.5;

  const risk_band: RiskBand = critical ? 'critical' : at_risk ? 'at_risk' : 'healthy';

  return { risk_score, risk_band, attempts_remaining, days_to_expiry, contributions };
}
