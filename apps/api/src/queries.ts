import { query } from '@mandate/db';

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

const LATEST_HEALTH = `
  SELECT DISTINCT ON (h.subscription_id) h.*
    FROM mandate_health h
    JOIN subscription s ON s.id = h.subscription_id
   WHERE s.merchant_id = $1
   ORDER BY h.subscription_id, h.scored_at DESC, h.id DESC
`;

export async function overview(merchant: string): Promise<Overview> {
  const { rows } = await query<Overview>(
    `WITH latest AS (${LATEST_HEALTH}),
     bands AS (
       SELECT
         count(*) FILTER (WHERE risk_band = 'at_risk')::int  AS at_risk_count,
         count(*) FILTER (WHERE risk_band = 'critical')::int AS critical_count,
         count(*) FILTER (WHERE risk_band = 'healthy')::int  AS healthy_count,
         COALESCE(sum(amount_at_risk_paise), 0)::bigint      AS amount_at_risk_paise
       FROM latest
     ),
     subs AS (
       SELECT count(*) FILTER (WHERE status = 'halted')::int AS halted_count
         FROM subscription WHERE merchant_id = $1
     ),
     attempts AS (
       SELECT
         count(*)::int                                     AS attempts_last_30d,
         count(*) FILTER (WHERE pa.status = 'failed')::int  AS failed_last_30d
       FROM payment_attempt pa
       JOIN subscription s ON s.id = pa.subscription_id
      WHERE s.merchant_id = $1 AND pa.attempted_at > now() - interval '30 days'
     ),
     unmapped AS (
       SELECT
         count(DISTINCT pa.error_reason)::int AS unmapped_codes,
         count(*)::int                        AS unmapped_attempts
       FROM payment_attempt pa
       JOIN subscription s ON s.id = pa.subscription_id
      WHERE s.merchant_id = $1
        AND COALESCE(pa.bucket, 'UNKNOWN') = 'UNKNOWN' AND pa.status = 'failed'
     )
     SELECT * FROM bands, subs, attempts, unmapped`,
    [merchant],
  );
  return rows[0]!;
}

export interface AtRiskRow {
  subscription_id: string;
  customer_ref: string;
  method: string;
  amount_paise: number;
  status: string;
  risk_band: string;
  risk_score: number;
  consecutive_failures: number;
  attempts_remaining: number;
  days_to_expiry: number | null;
  last_bucket: string | null;
  last_error_reason: string | null;
  scored_at: string;
}

export async function atRisk(merchant: string, limit = 100): Promise<AtRiskRow[]> {
  const { rows } = await query<AtRiskRow>(
    `WITH latest AS (${LATEST_HEALTH})
     SELECT
       s.id AS subscription_id, s.customer_ref, s.method, s.amount_paise, s.status,
       h.risk_band, h.risk_score::float8 AS risk_score, h.consecutive_failures, h.attempts_remaining,
       h.days_to_expiry, h.scored_at,
       COALESCE(a.bucket, 'UNKNOWN') AS last_bucket, a.error_reason AS last_error_reason
     FROM latest h
     JOIN subscription s ON s.id = h.subscription_id
     LEFT JOIN LATERAL (
       SELECT bucket, error_reason FROM payment_attempt
        WHERE subscription_id = s.id AND status = 'failed'
        ORDER BY attempted_at DESC LIMIT 1
     ) a ON TRUE
     WHERE h.risk_band <> 'healthy'
     ORDER BY
       CASE h.risk_band WHEN 'critical' THEN 0 ELSE 1 END,
       s.amount_paise DESC
     LIMIT $2`,
    [merchant, limit],
  );
  return rows;
}

export async function subscriptionDetail(merchant: string, id: string) {
  const sub = await query(
    `SELECT * FROM subscription WHERE id = $1 AND merchant_id = $2`,
    [id, merchant],
  );
  if (!sub.rows[0]) return null;

  const [attempts, decisions, health, intents] = await Promise.all([
    query(
      `SELECT rzp_payment_id, attempted_at, status, amount_paise, error_reason,
              error_source, error_step, COALESCE(bucket, 'UNKNOWN') AS bucket,
              initiated_by, source, taxonomy_version, counts_against_budget
         FROM payment_attempt WHERE subscription_id = $1
        ORDER BY attempted_at DESC LIMIT 100`,
      [id],
    ),
    query(
      `SELECT id, proposed_action, proposed_by, verdict, rule_id, scheduled_for, proposed_for,
              rationale, explanation, created_at, outcome,
              logging_propensity::float8 AS logging_propensity, explored, expected_paise
         FROM decision WHERE subscription_id = $1
        ORDER BY created_at DESC, id DESC LIMIT 50`,
      [id],
    ),
    query(
      `SELECT scored_at, risk_score::float8 AS risk_score, risk_band, consecutive_failures,
              attempts_remaining, days_to_expiry, contributions
         FROM mandate_health WHERE subscription_id = $1
        ORDER BY scored_at DESC, id DESC LIMIT 20`,
      [id],
    ),
    query(
      `SELECT idempotency_key, state, attempt_number, amount_paise, scheduled_for,
              dry_run, amount_mismatch, created_at, settled_at, last_error
         FROM execution_intent WHERE subscription_id = $1
        ORDER BY created_at DESC LIMIT 50`,
      [id],
    ),
  ]);

  return {
    subscription: sub.rows[0],
    attempts: attempts.rows,
    decisions: decisions.rows,
    health: health.rows,
    intents: intents.rows,
  };
}

export async function unmappedCodes(merchant: string) {
  const { rows } = await query(
    `SELECT pa.error_reason, pa.error_source, pa.error_step, s.method,
            count(*)::int AS attempts,
            sum(pa.amount_paise)::bigint AS amount_paise,
            max(pa.attempted_at) AS last_seen
       FROM payment_attempt pa
       JOIN subscription s ON s.id = pa.subscription_id
      WHERE s.merchant_id = $1
        AND COALESCE(pa.bucket, 'UNKNOWN') = 'UNKNOWN' AND pa.status = 'failed'
      GROUP BY 1,2,3,4
      ORDER BY attempts DESC`,
    [merchant],
  );
  return rows;
}

export async function declineDistribution(merchant: string) {
  const { rows } = await query(
    `SELECT COALESCE(pa.bucket, 'UNKNOWN') AS bucket, pa.error_reason, pa.error_source, s.method,
            count(*)::int AS attempts,
            sum(pa.amount_paise)::bigint AS amount_paise
       FROM payment_attempt pa
       JOIN subscription s ON s.id = pa.subscription_id
      WHERE s.merchant_id = $1 AND pa.status = 'failed'
      GROUP BY 1,2,3,4
      ORDER BY attempts DESC`,
    [merchant],
  );
  return rows;
}

export async function decisionLog(merchant: string, limit = 200) {
  const { rows } = await query(
    `SELECT d.id, d.subscription_id, d.proposed_action, d.proposed_by, d.verdict,
            d.rule_id, d.scheduled_for, d.proposed_for, d.rationale, d.explanation,
            d.created_at, d.executed_at, d.outcome
       FROM decision d
       JOIN subscription s ON s.id = d.subscription_id
      WHERE s.merchant_id = $1
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $2`,
    [merchant, limit],
  );
  return rows;
}

export async function denialsByRule(merchant: string) {
  const { rows } = await query(
    `SELECT d.rule_id, d.verdict, count(*)::int AS count
       FROM decision d
       JOIN subscription s ON s.id = d.subscription_id
      WHERE s.merchant_id = $1 AND d.verdict IN ('DENY','DEFER')
      GROUP BY 1,2
      ORDER BY count DESC`,
    [merchant],
  );
  return rows;
}

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
  created_at: Date;
  sent_at: Date | null;
  viewed_at: Date | null;
  converted_at: Date | null;
  expires_at: Date;
}

export async function outreachLog(merchant: string, limit: number): Promise<OutreachRow[]> {
  const { rows } = await query<OutreachRow>(
    `SELECT o.id::text AS id, o.subscription_id, s.customer_ref, s.merchant_id,
            s.amount_paise::bigint AS amount_paise,
            o.channel, o.status, o.recipient_masked, o.error,
            o.created_at, o.sent_at, o.viewed_at, o.converted_at, o.expires_at
       FROM outreach o
       JOIN subscription s ON s.id = o.subscription_id
      WHERE s.merchant_id = $1
      ORDER BY o.created_at DESC
      LIMIT $2`,
    [merchant, limit],
  );
  return rows.map((r) => ({ ...r, amount_paise: Number(r.amount_paise) }));
}

export async function outreachFunnel(merchant: string): Promise<Record<string, number>> {
  const { rows } = await query<{ status: string; n: number }>(
    `SELECT o.status, count(*)::int AS n
       FROM outreach o
       JOIN subscription s ON s.id = o.subscription_id
      WHERE s.merchant_id = $1
      GROUP BY o.status`,
    [merchant],
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export async function decisionBelongsTo(merchant: string, decisionId: string): Promise<boolean> {
  const { rows } = await query<{ ok: boolean }>(
    `SELECT true AS ok
       FROM decision d
       JOIN subscription s ON s.id = d.subscription_id
      WHERE d.id = $2::bigint AND s.merchant_id = $1`,
    [merchant, decisionId],
  );
  return rows.length > 0;
}
