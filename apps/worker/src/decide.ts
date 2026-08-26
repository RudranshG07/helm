import {
  AnthropicProposalClient,
  MockProposalClient,
  PDN_MIN_LEAD_MS,
  addMs,
  buildPrompt,
  evaluate,
  inferLiquidityWindow,
  isPeak,
  snapOutOfPeak,
} from '@mandate/core';
import type { Bucket, MandateContext, Method, PolicyContext, ProposalClient } from '@mandate/core';
import { withTransaction } from '@mandate/db';
import type { PoolClient } from 'pg';
import { config } from './config.ts';
import { isDegraded } from './degradation.ts';
import { log } from './log.ts';

interface Candidate {
  subscription_id: string;
  merchant_id: string;
  method: Method;
  amount_paise: number;
  status: string;
  cycle: Date;
  cycle_end: Date | null;
  mandate_expiry_at: Date | null;
  write_enabled: boolean;
  risk_band: string;
  risk_score: number;
  consecutive_failures: number;
  attempts_remaining: number;
  attempts_used: number;
  cycle_already_paid: boolean;
  consecutive_soft_cycles: number;
  days_to_expiry: number | null;
  contributions: Record<string, number>;
  error_code: string | null;
  error_reason: string | null;
  error_source: string | null;
  error_step: string | null;
  bucket: Bucket | null;
  taxonomy_version: string | null;
  issuer: string | null;
  success_days: number[];
  contacts_this_cycle: number;
}

const CANDIDATES_SQL = `
WITH latest AS (
  SELECT DISTINCT ON (subscription_id) *
    FROM mandate_health
   ORDER BY subscription_id, scored_at DESC, id DESC
)
SELECT
  s.id AS subscription_id, s.merchant_id, s.method, s.amount_paise, s.status,
  COALESCE(s.current_start, to_timestamp(0)) AS cycle, s.current_end, s.mandate_expiry_at,
  m.write_enabled,
  h.risk_band, h.risk_score::float8 AS risk_score, h.consecutive_failures,
  h.attempts_remaining, h.days_to_expiry, h.contributions,
  (SELECT count(*)::int FROM payment_attempt
    WHERE subscription_id = s.id AND cycle = COALESCE(s.current_start, to_timestamp(0))
      AND counts_against_budget) AS attempts_used,
  EXISTS (SELECT 1 FROM payment_attempt
           WHERE subscription_id = s.id AND cycle = COALESCE(s.current_start, to_timestamp(0))
             AND status = 'captured') AS cycle_already_paid,
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
  a.error_code, a.error_reason, a.error_source, a.error_step, a.bucket, a.taxonomy_version, a.issuer,
  COALESCE((
    SELECT array_agg(EXTRACT(DAY FROM attempted_at AT TIME ZONE 'Asia/Kolkata')::int)
      FROM payment_attempt
     WHERE subscription_id = s.id AND status = 'captured'
  ), ARRAY[]::int[]) AS success_days,
  (SELECT count(*)::int FROM decision
    WHERE subscription_id = s.id AND cycle = COALESCE(s.current_start, to_timestamp(0))
      AND proposed_action = 'REAUTH_OUTREACH' AND verdict = 'ALLOW') AS contacts_this_cycle
FROM latest h
JOIN subscription s ON s.id = h.subscription_id
JOIN merchant m ON m.id = s.merchant_id
LEFT JOIN LATERAL (
  SELECT error_code, error_reason, error_source, error_step, bucket, taxonomy_version, issuer
    FROM payment_attempt
   WHERE subscription_id = s.id AND status = 'failed'
   ORDER BY attempted_at DESC LIMIT 1
) a ON TRUE
WHERE h.risk_band <> 'healthy'
  AND NOT EXISTS (
    SELECT 1 FROM decision d
     WHERE d.subscription_id = s.id
       AND d.cycle = COALESCE(s.current_start, to_timestamp(0))
       AND d.created_at > h.scored_at
  )
ORDER BY h.risk_band DESC, s.amount_paise DESC
LIMIT $1
`;

function earliestLegalSlot(now: Date): Date {
  const floor = addMs(now, PDN_MIN_LEAD_MS);
  return isPeak(floor) ? snapOutOfPeak(floor) : floor;
}

function buildContext(row: Candidate, now: Date, degraded: boolean): MandateContext {
  const liquidity = inferLiquidityWindow(row.success_days ?? []);
  return {
    subscription_id: row.subscription_id,
    method: row.method,
    amount_paise: row.amount_paise,
    cycle_start: row.cycle.toISOString(),
    cycle_end: row.cycle_end?.toISOString() ?? null,
    mandate_expiry_at: row.mandate_expiry_at?.toISOString() ?? null,
    days_to_expiry: row.days_to_expiry,
    error_code: row.error_code,
    error_reason: row.error_reason,
    error_source: row.error_source,
    error_step: row.error_step,
    bucket: row.bucket ?? 'UNKNOWN',
    bucket_confidence: row.bucket ? 'mapped' : 'unmapped',
    taxonomy_version: row.taxonomy_version ?? 'unknown',
    risk_band: row.risk_band,
    risk_score: row.risk_score,
    consecutive_failures: row.consecutive_failures,
    attempts_remaining: row.attempts_remaining,
    contributions: row.contributions ?? {},
    liquidity_window: {
      preferred_day: liquidity.preferred_day,
      window_days: liquidity.window_days,
      confidence: liquidity.confidence,
      tier: liquidity.tier,
    },
    issuer: row.issuer,
    issuer_degraded: degraded,
    degradation_source: degraded ? 'internal_rollup' : null,
    successful_payment_days: row.success_days ?? [],
    now: now.toISOString(),
    earliest_legal_slot: earliestLegalSlot(now).toISOString(),
  };
}

function buildPolicyContext(row: Candidate, now: Date, degraded: boolean): PolicyContext {
  return {
    now,
    kill_switch: false,
    write_enabled: row.write_enabled,
    subscription_status: row.status,
    method: row.method,
    amount_paise: row.amount_paise,
    cycle: row.cycle,
    mandate_expiry_at: row.mandate_expiry_at,
    cycle_already_paid: row.cycle_already_paid,
    attempts_remaining: row.attempts_remaining,
    attempt_number: row.attempts_used + 1,
    last_bucket: row.bucket,
    consecutive_soft_cycles: row.consecutive_soft_cycles,
    max_soft_cycles: config.maxSoftCycles,
    attempt_exists: false,
    attempt_in_flight: false,
    issuer_degraded: degraded,
    contacts_this_cycle: row.contacts_this_cycle,
    max_contacts_per_cycle: 1,
    blast_attempts_used: 0,
    blast_attempts_max: config.blastRadiusMax,
  };
}

async function killSwitchEngaged(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ kill_switch: boolean }>(
    'SELECT kill_switch FROM control_flags WHERE id = 1',
  );
  return rows[0]?.kill_switch ?? true;
}

export function makeProposalClient(): ProposalClient {
  if (process.env['ANTHROPIC_API_KEY']) return new AnthropicProposalClient();
  log.warn('agent.no_api_key', { using: 'mock' });
  return new MockProposalClient();
}

export async function decideBatch(agent: ProposalClient, now = new Date()): Promise<number> {
  const rows = await withTransaction(async (client) => {
    const { rows } = await client.query<Candidate>(CANDIDATES_SQL, [config.decideBatchSize]);
    return rows;
  });

  if (rows.length === 0) return 0;

  const killed = await withTransaction(killSwitchEngaged);

  for (const row of rows) {
    const degraded = await isDegraded(row.issuer, row.method);
    const ctx = buildContext(row, now, degraded);
    const outcome = await agent.propose(ctx);

    const policyCtx = { ...buildPolicyContext(row, now, degraded), kill_switch: killed };

    const proposal = outcome.ok
      ? outcome.proposal
      : {
          subscription_id: row.subscription_id,
          action: 'HOLD' as const,
          reason: 'The proposal could not be validated, so no action was taken this cycle.',
          confidence: 0,
        };

    const verdict = outcome.ok
      ? evaluate(proposal, policyCtx)
      : {
          verdict: 'DEFER' as const,
          rule_id: 'R-MALFORMED',
          explanation: `Agent response rejected: ${outcome.error}`,
        };

    if (!outcome.ok) {
      log.warn('agent.invalid_response', {
        subscription_id: row.subscription_id,
        error: outcome.error,
        model: outcome.model,
      });
    }

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO decision (
           subscription_id, cycle, proposed_action, proposed_by, prompt_version, confidence,
           verdict, rule_id, scheduled_for, proposed_for, rationale, explanation,
           agent_context, taxonomy_version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          row.subscription_id, row.cycle, proposal.action, outcome.model, outcome.prompt_version,
          proposal.confidence, verdict.verdict, verdict.rule_id,
          verdict.scheduled_for ?? null, verdict.proposed_for ?? proposal.scheduled_for ?? null,
          proposal.reason, verdict.explanation, ctx, row.taxonomy_version,
        ],
      );
    });

    log.info('decision.recorded', {
      subscription_id: row.subscription_id,
      action: proposal.action,
      verdict: verdict.verdict,
      rule_id: verdict.rule_id,
    });
  }

  return rows.length;
}

export { buildPrompt };
