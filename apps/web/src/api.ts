export interface Overview {
  at_risk_count: number;
  critical_count: number;
  healthy_count: number;
  amount_at_risk_paise: number;
  halted_count: number;
  attempts_last_30d: number;
  failed_last_30d: number;
  unmapped_codes: number;
  unmapped_attempts: number;
}

export interface AtRiskRow {
  subscription_id: string;
  customer_ref: string;
  method: string;
  amount_paise: number;
  status: string;
  risk_band: 'healthy' | 'at_risk' | 'critical' | null;
  risk_score: number;
  consecutive_failures: number;
  attempts_remaining: number;
  days_to_expiry: number | null;
  last_bucket: string | null;
  last_error_reason: string | null;
  scored_at: string;
}

export interface DeclineRow {
  bucket: string | null;
  error_reason: string | null;
  error_source: string | null;
  method: string;
  attempts: number;
  amount_paise: number;
}

export interface UnmappedRow extends DeclineRow {
  error_step: string | null;
  last_seen: string;
}

export interface DecisionRow {
  id: number;
  subscription_id: string;
  proposed_action: string;
  proposed_by: string;
  verdict: 'ALLOW' | 'DENY' | 'DEFER';
  rule_id: string;
  scheduled_for: string | null;
  proposed_for: string | null;
  rationale: string | null;
  explanation: string | null;
  created_at: string;
  executed_at: string | null;
  outcome: string | null;
}

export interface DenialRow {
  rule_id: string;
  verdict: string;
  count: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  return res.json() as Promise<T>;
}

export interface Health {
  ok: boolean;
  mode: string;
  dry_run: boolean;
}

export const api = {
  health: () => get<Health>('/health'),
  overview: () => get<Overview>('/api/overview'),
  atRisk: () => get<{ subscriptions: AtRiskRow[] }>('/api/at-risk'),
  declines: () => get<{ distribution: DeclineRow[]; unmapped: UnmappedRow[] }>('/api/declines'),
  decisions: () => get<{ decisions: DecisionRow[]; denials_by_rule: DenialRow[] }>('/api/decisions'),
};
