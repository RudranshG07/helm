export type Method = 'upi_autopay' | 'card' | 'emandate';

export type Bucket =
  | 'SOFT_LIQUIDITY'
  | 'SOFT_TRANSIENT'
  | 'HARD_INSTRUMENT'
  | 'HARD_CUSTOMER'
  | 'UNKNOWN';

export type Action = 'RETRY_SCHEDULED' | 'HOLD' | 'REAUTH_OUTREACH' | 'STOP';

export type Verdict = 'ALLOW' | 'DENY' | 'DEFER';

export interface Proposal {
  subscription_id: string;
  action: Action;
  scheduled_for?: string;
  reason: string;
  confidence: number;
}

export interface PolicyContext {
  now: Date;

  kill_switch: boolean;
  write_enabled: boolean;

  subscription_status: string;
  method: Method;
  amount_paise: number;
  cycle: Date;
  mandate_expiry_at: Date | null;
  cycle_already_paid: boolean;

  attempts_remaining: number;
  attempt_number: number;

  last_bucket: Bucket | null;
  consecutive_soft_cycles: number;
  max_soft_cycles: number;
  attempt_exists: boolean;
  attempt_in_flight: boolean;

  issuer_degraded: boolean;
  contacts_this_cycle: number;
  max_contacts_per_cycle: number;

  blast_attempts_used: number;
  blast_attempts_max: number;
}

export interface PolicyVerdict {
  verdict: Verdict;
  rule_id: string;
  scheduled_for?: string;
  proposed_for?: string;
  explanation: string;
}
