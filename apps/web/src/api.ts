import { actAsOperator } from './operator.ts';
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
  explored?: boolean;
  logging_propensity?: number | null;
  expected_paise?: number | null;
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

export interface Merchant {
  id: string;
  name: string;
  mode: string;
  integration: string | null;
  write_enabled: boolean;
  cross_merchant_signals: boolean;
  consent_signed_at: string | null;
  subscriptions: number;
}

export interface Control {
  kill_switch: boolean;
  kill_switch_reason: string | null;
  updated_at: string;
  dry_run: boolean;
  mode: string;
  release_requires_token: boolean;
}

export interface QueueRow {
  subscription_id: string;
  customer_ref: string;
  method: string;
  amount_paise: number;
  risk_band: string;
  attempts_remaining: number;
  last_error_reason: string | null;
  last_bucket: string | null;
  chargeable: boolean;
  blocked_reason: string | null;
}

export interface AttemptRow {
  rzp_payment_id: string | null;
  attempted_at: string;
  status: string;
  amount_paise: number;
  error_reason: string | null;
  error_source: string | null;
  bucket: string | null;
  initiated_by: string;
  source: string;
  counts_against_budget: boolean;
}

export interface IntentRow {
  idempotency_key: string;
  state: string;
  attempt_number: number;
  amount_paise: number;
  scheduled_for: string;
  dry_run: boolean;
  amount_mismatch: boolean;
  created_at: string;
  settled_at: string | null;
  last_error: string | null;
}

export interface HealthRow {
  scored_at: string;
  risk_score: number;
  risk_band: string;
  consecutive_failures: number;
  attempts_remaining: number;
  days_to_expiry: number | null;
  contributions: Record<string, number>;
}

export interface Detail {
  subscription: Record<string, unknown>;
  attempts: AttemptRow[];
  decisions: DecisionRow[];
  health: HealthRow[];
  intents: IntentRow[];
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await actAsOperator(path, { method: 'POST', body: JSON.stringify(body) });
  const parsed = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(parsed.error ?? `${path} responded ${res.status}`);
  return parsed;
}

export const api = {
  health: () => get<Health>('/health'),
  merchants: () => get<{ merchants: Merchant[] }>('/api/merchants'),
  control: () => get<Control>('/api/control'),
  setKillSwitch: (engaged: boolean, token?: string, reason?: string) =>
    post<{ kill_switch: boolean }>('/api/control/kill-switch', { engaged, token, reason }),
  trace: (id: string) => get<DecisionTrace>(`/api/decisions/${encodeURIComponent(id)}/trace`),
  outreach: () => get<{ outreach: OutreachRow[]; funnel: Record<string, number> }>('/api/outreach?limit=200'),
  chargeQueue: () => get<{ queue: QueueRow[]; note: string }>('/api/charge-queue'),
  reports: () => get<{ reports: { slug: string; title: string; description: string }[] }>('/api/reports'),
  report: (slug: string) => get<{ slug: string; markdown: string }>(`/api/reports/${slug}`),
  detail: (id: string) => get<Detail>(`/api/subscriptions/${encodeURIComponent(id)}`),
  overview: () => get<Overview>('/api/overview'),
  atRisk: () => get<{ subscriptions: AtRiskRow[] }>('/api/at-risk'),
  declines: () => get<{ distribution: DeclineRow[]; unmapped: UnmappedRow[] }>('/api/declines'),
  decisions: () => get<{ decisions: DecisionRow[]; denials_by_rule: DenialRow[] }>('/api/decisions'),
};

export interface OutreachRow {
  id: string;
  subscription_id: string;
  customer_ref: string;
  merchant_id: string;
  amount_paise: number;
  channel: string;
  status: string;
  recipient_masked: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
  viewed_at: string | null;
  converted_at: string | null;
  expires_at: string;
}

export interface TraceStep {
  stage: string;
  headline: string;
  detail: string;
  facts: Record<string, string | number | boolean | null>;
}

export interface Counterfactual {
  default_at: string;
  default_in_peak: boolean;
  default_p: number;
  default_evidence: number;
  chosen_at: string | null;
  chosen_in_peak: boolean;
  chosen_p: number;
  chosen_evidence: number;
  edge: number;
  verdict: string;
}

export interface DecisionTrace {
  decision_id: string;
  subscription_id: string;
  customer_ref: string;
  merchant_id: string;
  amount_paise: number;
  arm: string | null;
  steps: TraceStep[];
  counterfactual: Counterfactual | null;
  outcome: string | null;
  headline: string;
}
