import { query } from '@mandate/db';
import type { Bucket, Method, PolicyContext } from '@mandate/core';
import { config } from './config.ts';
import { isDegraded } from './degradation.ts';

interface ContextRow {
  status: string;
  method: Method;
  amount_paise: number;
  mandate_expiry_at: Date | null;
  write_enabled: boolean;
  kill_switch: boolean;
  attempts_used: number;
  cycle_already_paid: boolean;
  consecutive_soft_cycles: number;
  last_bucket: Bucket | null;
  attempt_exists: boolean;
  attempt_in_flight: boolean;
  contacts_this_cycle: number;
  blast_attempts_used: number;
  issuer: string | null;
  integration: string | null;
}

const NPCI_ATTEMPT_BUDGET = 4;

const CONTEXT_SQL = `
SELECT
  s.status, s.method, s.amount_paise, s.mandate_expiry_at,
  m.write_enabled, m.integration,
  ((SELECT kill_switch FROM control_flags WHERE id = 1)
     OR m.halted_at IS NOT NULL) AS kill_switch,
  (SELECT count(*)::int FROM payment_attempt
    WHERE subscription_id = s.id AND cycle = $2 AND counts_against_budget) AS attempts_used,
  EXISTS (SELECT 1 FROM payment_attempt
           WHERE subscription_id = s.id AND cycle = $2 AND status = 'captured') AS cycle_already_paid,
  (SELECT count(*)::int FROM (
     SELECT cycle, bool_or(status = 'captured') AS paid,
            bool_or(bucket LIKE 'SOFT%') AS soft
       FROM payment_attempt
      WHERE subscription_id = s.id
      GROUP BY cycle
      ORDER BY cycle DESC
   ) c WHERE c.cycle > COALESCE(
     (SELECT max(cycle) FROM payment_attempt
       WHERE subscription_id = s.id AND status = 'captured'),
     to_timestamp(0)
   ) AND c.soft AND NOT c.paid) AS consecutive_soft_cycles,
  (SELECT bucket FROM payment_attempt
    WHERE subscription_id = s.id AND status = 'failed'
    ORDER BY attempted_at DESC LIMIT 1) AS last_bucket,
  EXISTS (SELECT 1 FROM execution_intent
           WHERE subscription_id = s.id AND cycle = $2 AND attempt_number = $3) AS attempt_exists,
  EXISTS (SELECT 1 FROM execution_intent
           WHERE subscription_id = s.id AND cycle = $2
             AND state IN ('INTENDED','SUBMITTED')) AS attempt_in_flight,
  (SELECT count(*)::int FROM decision
    WHERE subscription_id = s.id AND cycle = $2
      AND proposed_action = 'REAUTH_OUTREACH' AND verdict = 'ALLOW') AS contacts_this_cycle,
  (SELECT count(*)::int FROM execution_intent i
     JOIN subscription s2 ON s2.id = i.subscription_id
    WHERE s2.merchant_id = s.merchant_id AND i.dry_run = FALSE) AS blast_attempts_used,
  (SELECT issuer FROM payment_attempt
    WHERE subscription_id = s.id AND status = 'failed'
    ORDER BY attempted_at DESC LIMIT 1) AS issuer
FROM subscription s
JOIN merchant m ON m.id = s.merchant_id
WHERE s.id = $1
`;

export async function loadPolicyContext(
  subscriptionId: string,
  cycle: Date,
  attemptNumber: number,
  now: Date,
): Promise<PolicyContext | null> {
  const { rows } = await query<ContextRow>(CONTEXT_SQL, [subscriptionId, cycle, attemptNumber]);
  const row = rows[0];
  if (!row) return null;

  return {
    now,
    kill_switch: row.kill_switch,
    write_enabled: row.write_enabled,
    subscription_status: row.status,
    method: row.method,
    integration: (row.integration ?? 'recurring_tokens') as never,
    amount_paise: row.amount_paise,
    cycle,
    mandate_expiry_at: row.mandate_expiry_at,
    cycle_already_paid: row.cycle_already_paid,
    attempts_remaining: Math.max(0, NPCI_ATTEMPT_BUDGET - row.attempts_used),
    attempt_number: attemptNumber,
    last_bucket: row.last_bucket,
    consecutive_soft_cycles: row.consecutive_soft_cycles,
    max_soft_cycles: config.maxSoftCycles,
    attempt_exists: row.attempt_exists,
    attempt_in_flight: row.attempt_in_flight,
    issuer_degraded: await isDegraded(row.issuer, row.method),
    contacts_this_cycle: row.contacts_this_cycle,
    max_contacts_per_cycle: 1,
    blast_attempts_used: row.blast_attempts_used,
    blast_attempts_max: config.blastRadiusMax,
  };
}
