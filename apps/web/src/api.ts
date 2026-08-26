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
  risk_band: 'healthy' | 'at_risk' | 'critical';
  risk_score: number;
  consecutive_failures: number;
  attempts_remaining: number;
  days_to_expiry: number | null;
  last_bucket: string | null;
  last_error_reason: string | null;
  scored_at: string;
}

export interface DeclineRow {
  bucket: string;
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

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  overview: () => get<Overview>('/api/overview'),
  atRisk: () => get<{ subscriptions: AtRiskRow[] }>('/api/at-risk'),
  declines: () => get<{ distribution: DeclineRow[]; unmapped: UnmappedRow[] }>('/api/declines'),
};
