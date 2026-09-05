import { TAXONOMY_VERSION } from '@mandate/core';
import { query } from '@mandate/db';
import { armTotals } from '../arms.ts';
import type { ArmTotals } from '../arms.ts';
import { buildDecisionTrace } from '../trace/decision.ts';
import type { DecisionTrace } from '../trace/decision.ts';
import { SCENARIOS } from '../adversarial/catalog.ts';
import { findCollisions } from '@mandate/core';
import type { ScheduledDebit } from '@mandate/core';
import { analyzeContention } from '../contention/analyze.ts';

export interface ProofScale {
  merchants: number;
  mandates: number;
  attempts: number;
  decisions: number;
  executions: number;
  outreach: number;
  promises: number;
}

export interface ProofHonesty {
  taxonomy_version: string;
  unmapped_attempts: number;
  unmapped_share: number;
  scenarios: number;
  handled: number;
  detected: number;
  unhandled: number;
  open_gaps: { id: string; title: string; note: string | null }[];
  money_is_simulated: boolean;
}

export interface ProofOutreach {
  funnel: Record<string, number>;
  languages: Record<string, number>;
  promises_open: number;
  promises_kept: number;
  promises_broken: number;
}

export interface CrossMerchant {
  merchants_sharing_signals: number;
  customers_seen_by_more_than_one: number;
  debits_spread: number;
  collisions_pending: number;
  contention_verdict: string;
  contention_explanation: string;
  contention_threshold_paise: number;
  contested_label: string;
  uncontested_label: string;
}

export interface RealAccount {
  connected: boolean;
  merchants: number;
  mandates: number;
  attempts: number;
  failures: number;
  recovered_paise: number;
  lost_paise: number;
  decline_codes: { reason: string | null; bucket: string; source: string; n: number }[];
  live_mandates: number;
  events_via_webhook: number;
  attempts_via_backfill: number;
}

import { buildCalibration } from '../calibration.ts';
import type { Calibration } from '../calibration.ts';

export interface Proof {
  generated_at: string;
  scale: ProofScale;
  real: RealAccount;
  arms: ArmTotals[];
  edge_per_attempt_pct: number | null;
  allowed_trace: DecisionTrace | null;
  refused_trace: DecisionTrace | null;
  outreach: ProofOutreach;
  cross_merchant: CrossMerchant;
  honesty: ProofHonesty;
  calibration: Calibration;
}

async function one<T extends Record<string, unknown>>(sql: string): Promise<T | undefined> {
  const { rows } = await query<T>(sql);
  return rows[0];
}

async function pickTrace(sql: string): Promise<DecisionTrace | null> {
  const row = await one<{ id: string }>(sql);
  return row ? buildDecisionTrace(row.id) : null;
}

export async function buildProof(): Promise<Proof> {
  const scale = await one<Record<string, string>>(`
    SELECT (SELECT count(*) FROM merchant)::text AS merchants,
           (SELECT count(*) FROM subscription)::text AS mandates,
           (SELECT count(*) FROM payment_attempt)::text AS attempts,
           (SELECT count(*) FROM decision)::text AS decisions,
           (SELECT count(*) FROM execution_intent)::text AS executions,
           (SELECT count(*) FROM outreach)::text AS outreach,
           (SELECT count(*) FROM promise_to_pay)::text AS promises`);

  const arms = await armTotals();
  const perAttempt = (a?: ArmTotals) => {
    if (!a) return null;
    const n = a.attempts_by_us + a.attempts_by_default;
    return n > 0 ? a.amount_recovered_paise / n : null;
  };
  const c = perAttempt(arms.find((a) => a.arm === 'control'));
  const t = perAttempt(arms.find((a) => a.arm === 'treatment'));
  const edge = c !== null && t !== null && c > 0 ? ((t - c) / c) * 100 : null;

  const allowed = await pickTrace(`
    SELECT d.id::text AS id FROM decision d
     WHERE d.verdict = 'ALLOW'
       AND d.proposed_action = 'RETRY_SCHEDULED'
       AND d.scheduled_for IS NOT NULL
       AND d.agent_context IS NOT NULL
       AND EXISTS (SELECT 1 FROM payment_attempt pa
                    WHERE pa.subscription_id = d.subscription_id
                      AND pa.cycle = d.cycle AND pa.status = 'failed')
       AND EXISTS (SELECT 1 FROM subscription s
                    JOIN merchant m ON m.id = s.merchant_id
                   WHERE s.id = d.subscription_id AND m.synthetic)
     ORDER BY (d.outcome = 'recovered') DESC NULLS LAST, d.id DESC
     LIMIT 1`);

  const refused = await pickTrace(`
    SELECT d.id::text AS id FROM decision d
     WHERE d.verdict = 'DENY'
       AND d.agent_context IS NOT NULL
       AND EXISTS (SELECT 1 FROM payment_attempt pa
                    WHERE pa.subscription_id = d.subscription_id
                      AND pa.cycle = d.cycle AND pa.status = 'failed')
       AND EXISTS (SELECT 1 FROM subscription s
                    JOIN merchant m ON m.id = s.merchant_id
                   WHERE s.id = d.subscription_id AND m.synthetic)
     ORDER BY (d.rule_id = 'R-HARD') DESC, d.id DESC
     LIMIT 1`);

  const { rows: funnelRows } = await query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM outreach GROUP BY status`);
  const { rows: langRows } = await query<{ language: string; n: number }>(
    `SELECT language, count(*)::int AS n FROM outreach GROUP BY language`);
  const promises = await one<Record<string, string>>(`
    SELECT count(*) FILTER (WHERE status='open')::text AS open,
           count(*) FILTER (WHERE status='kept')::text AS kept,
           count(*) FILTER (WHERE status='broken')::text AS broken
      FROM promise_to_pay`);

  const unmapped = await one<{ unmapped: string; total: string }>(`
    SELECT count(*) FILTER (WHERE COALESCE(bucket,'UNKNOWN') = 'UNKNOWN')::text AS unmapped,
           count(*)::text AS total
      FROM payment_attempt WHERE status = 'failed'`);

  const shared = await one<Record<string, string>>(`
    SELECT (SELECT count(*) FROM merchant WHERE cross_merchant_signals)::text AS merchants,
           (SELECT count(*) FROM (
              SELECT COALESCE(customer_key, customer_ref) AS ck
                FROM subscription
               GROUP BY 1 HAVING count(DISTINCT merchant_id) > 1
            ) q)::text AS shared_customers,
           (SELECT count(*) FROM decision
             WHERE explanation LIKE '%same-account collision%')::text AS spread`);

  const { rows: pending } = await query<{
    id: string; merchant_id: string; customer_key: string; amount_paise: string; scheduled_for: Date;
  }>(`
    SELECT d.id::text AS id, s.merchant_id,
           COALESCE(s.customer_key, s.customer_ref) AS customer_key,
           s.amount_paise::text AS amount_paise, d.scheduled_for
      FROM decision d
      JOIN subscription s ON s.id = d.subscription_id
      JOIN merchant m ON m.id = s.merchant_id
     WHERE d.verdict = 'ALLOW' AND d.proposed_action = 'RETRY_SCHEDULED'
       AND d.executed_at IS NULL AND d.outcome IS NULL
       AND d.scheduled_for IS NOT NULL AND m.cross_merchant_signals`);

  const debits: ScheduledDebit[] = pending.map((r) => ({
    id: r.id, merchant_id: r.merchant_id, customer_key: r.customer_key,
    amount_paise: Number(r.amount_paise), at: r.scheduled_for,
    earliest: r.scheduled_for, latest: r.scheduled_for,
  }));

  const realTotals = await one<Record<string, string>>(`
    SELECT (SELECT count(*) FROM merchant WHERE rzp_key_id IS NOT NULL)::text AS merchants,
           (SELECT count(*) FROM subscription s
              JOIN merchant m ON m.id = s.merchant_id
             WHERE m.rzp_key_id IS NOT NULL)::text AS mandates,
           (SELECT count(*) FROM payment_attempt pa
              JOIN subscription s2 ON s2.id = pa.subscription_id
              JOIN merchant m2 ON m2.id = s2.merchant_id
             WHERE m2.rzp_key_id IS NOT NULL)::text AS attempts,
           (SELECT count(*) FROM payment_attempt pa3
              JOIN subscription s3 ON s3.id = pa3.subscription_id
              JOIN merchant m3 ON m3.id = s3.merchant_id
             WHERE m3.rzp_key_id IS NOT NULL AND pa3.status = 'failed')::text AS failures,
           (SELECT COALESCE(sum(pa4.amount_paise),0) FROM payment_attempt pa4
              JOIN subscription s4 ON s4.id = pa4.subscription_id
              JOIN merchant m4 ON m4.id = s4.merchant_id
             WHERE m4.rzp_key_id IS NOT NULL AND pa4.status = 'captured')::text AS recovered,
           (SELECT COALESCE(sum(pa5.amount_paise),0) FROM payment_attempt pa5
              JOIN subscription s5 ON s5.id = pa5.subscription_id
              JOIN merchant m5 ON m5.id = s5.merchant_id
             WHERE m5.rzp_key_id IS NOT NULL AND pa5.status = 'failed')::text AS lost,
           (SELECT count(*) FROM subscription s6
              JOIN merchant m6 ON m6.id = s6.merchant_id
             WHERE m6.rzp_key_id IS NOT NULL AND s6.rzp_token_id IS NOT NULL)::text AS live_mandates,
           (SELECT count(*) FROM payment_attempt pa7
              JOIN subscription s7 ON s7.id = pa7.subscription_id
              JOIN merchant m7 ON m7.id = s7.merchant_id
             WHERE m7.rzp_key_id IS NOT NULL AND pa7.source = 'webhook')::text AS via_webhook,
           (SELECT count(*) FROM payment_attempt pa8
              JOIN subscription s8 ON s8.id = pa8.subscription_id
              JOIN merchant m8 ON m8.id = s8.merchant_id
             WHERE m8.rzp_key_id IS NOT NULL AND pa8.source = 'backfill')::text AS via_backfill`);

  const { rows: realCodes } = await query<{ reason: string | null; bucket: string; source: string; n: number }>(`
    SELECT pa.error_reason AS reason, COALESCE(pa.bucket,'UNKNOWN') AS bucket,
           pa.source, count(*)::int AS n
      FROM payment_attempt pa
      JOIN subscription s ON s.id = pa.subscription_id
      JOIN merchant m ON m.id = s.merchant_id
     WHERE m.rzp_key_id IS NOT NULL AND pa.status = 'failed'
     GROUP BY 1,2,3 ORDER BY n DESC LIMIT 8`);

  const contention = await analyzeContention();
  const calibration = await buildCalibration();

  const gaps = SCENARIOS.filter((s) => s.outcome === 'UNHANDLED');
  const total = Number(unmapped?.total ?? 0);

  return {
    generated_at: new Date().toISOString(),
    scale: {
      merchants: Number(scale?.['merchants'] ?? 0),
      mandates: Number(scale?.['mandates'] ?? 0),
      attempts: Number(scale?.['attempts'] ?? 0),
      decisions: Number(scale?.['decisions'] ?? 0),
      executions: Number(scale?.['executions'] ?? 0),
      outreach: Number(scale?.['outreach'] ?? 0),
      promises: Number(scale?.['promises'] ?? 0),
    },
    calibration,
    real: {
      connected: Number(realTotals?.['merchants'] ?? 0) > 0,
      merchants: Number(realTotals?.['merchants'] ?? 0),
      mandates: Number(realTotals?.['mandates'] ?? 0),
      attempts: Number(realTotals?.['attempts'] ?? 0),
      failures: Number(realTotals?.['failures'] ?? 0),
      recovered_paise: Number(realTotals?.['recovered'] ?? 0),
      lost_paise: Number(realTotals?.['lost'] ?? 0),
      decline_codes: realCodes,
      live_mandates: Number(realTotals?.['live_mandates'] ?? 0),
      events_via_webhook: Number(realTotals?.['via_webhook'] ?? 0),
      attempts_via_backfill: Number(realTotals?.['via_backfill'] ?? 0),
    },
    arms,
    edge_per_attempt_pct: edge,
    allowed_trace: allowed,
    refused_trace: refused,
    outreach: {
      funnel: Object.fromEntries(funnelRows.map((r) => [r.status, r.n])),
      languages: Object.fromEntries(langRows.map((r) => [r.language, r.n])),
      promises_open: Number(promises?.['open'] ?? 0),
      promises_kept: Number(promises?.['kept'] ?? 0),
      promises_broken: Number(promises?.['broken'] ?? 0),
    },
    cross_merchant: {
      merchants_sharing_signals: Number(shared?.['merchants'] ?? 0),
      customers_seen_by_more_than_one: Number(shared?.['shared_customers'] ?? 0),
      debits_spread: Number(shared?.['spread'] ?? 0),
      collisions_pending: findCollisions(debits).length,
      contention_verdict: contention.test.verdict,
      contention_explanation: contention.test.explanation,
      contention_threshold_paise: contention.test.threshold_paise,
      contested_label: contention.contested_label,
      uncontested_label: contention.uncontested_label,
    },
    honesty: {
      taxonomy_version: TAXONOMY_VERSION,
      unmapped_attempts: Number(unmapped?.unmapped ?? 0),
      unmapped_share: total > 0 ? Number(unmapped?.unmapped ?? 0) / total : 0,
      scenarios: SCENARIOS.length,
      handled: SCENARIOS.filter((s) => s.outcome === 'HANDLED').length,
      detected: SCENARIOS.filter((s) => s.outcome === 'DETECTED').length,
      unhandled: gaps.length,
      open_gaps: gaps.map((g) => ({ id: g.id, title: g.title, note: g.note ?? null })),
      money_is_simulated: true,
    },
  };
}
