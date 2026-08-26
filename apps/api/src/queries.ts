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
  SELECT DISTINCT ON (subscription_id) *
    FROM mandate_health
   ORDER BY subscription_id, scored_at DESC, id DESC
`;

export async function overview(): Promise<Overview> {
  const { rows } = await query<Overview>(`
    WITH latest AS (${LATEST_HEALTH}),
    bands AS (
      SELECT
        count(*) FILTER (WHERE risk_band = 'at_risk')::int  AS at_risk_count,
        count(*) FILTER (WHERE risk_band = 'critical')::int AS critical_count,
        count(*) FILTER (WHERE risk_band = 'healthy')::int  AS healthy_count,
        COALESCE(sum(amount_at_risk_paise), 0)::bigint      AS amount_at_risk_paise
      FROM latest
    ),
    subs AS (
      SELECT count(*) FILTER (WHERE status = 'halted')::int AS halted_count FROM subscription
    ),
    attempts AS (
      SELECT
        count(*)::int                                     AS attempts_last_30d,
        count(*) FILTER (WHERE status = 'failed')::int    AS failed_last_30d
      FROM payment_attempt
      WHERE attempted_at > now() - interval '30 days'
    ),
    unmapped AS (
      SELECT
        count(DISTINCT error_reason)::int AS unmapped_codes,
        count(*)::int                     AS unmapped_attempts
      FROM payment_attempt
      WHERE bucket = 'UNKNOWN' AND status = 'failed'
    )
    SELECT * FROM bands, subs, attempts, unmapped
  `);
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

export async function atRisk(limit = 100): Promise<AtRiskRow[]> {
  const { rows } = await query<AtRiskRow>(
    `WITH latest AS (${LATEST_HEALTH})
     SELECT
       s.id AS subscription_id, s.customer_ref, s.method, s.amount_paise, s.status,
       h.risk_band, h.risk_score::float8 AS risk_score, h.consecutive_failures, h.attempts_remaining,
       h.days_to_expiry, h.scored_at,
       a.bucket AS last_bucket, a.error_reason AS last_error_reason
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
     LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function subscriptionDetail(id: string) {
  const [sub, attempts, decisions, health] = await Promise.all([
    query(`SELECT * FROM subscription WHERE id = $1`, [id]),
    query(
      `SELECT rzp_payment_id, attempted_at, status, amount_paise, error_reason,
              error_source, bucket, initiated_by, taxonomy_version
         FROM payment_attempt WHERE subscription_id = $1
        ORDER BY attempted_at DESC LIMIT 50`,
      [id],
    ),
    query(
      `SELECT proposed_action, verdict, rule_id, scheduled_for, proposed_for,
              rationale, explanation, created_at, outcome
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
  ]);

  if (!sub.rows[0]) return null;
  return {
    subscription: sub.rows[0],
    attempts: attempts.rows,
    decisions: decisions.rows,
    health: health.rows,
  };
}

export async function unmappedCodes() {
  const { rows } = await query(
    `SELECT error_reason, error_source, error_step, method,
            count(*)::int AS attempts,
            sum(pa.amount_paise)::bigint AS amount_paise,
            max(attempted_at) AS last_seen
       FROM payment_attempt pa
       JOIN subscription s ON s.id = pa.subscription_id
      WHERE pa.bucket = 'UNKNOWN' AND pa.status = 'failed'
      GROUP BY 1,2,3,4
      ORDER BY attempts DESC`,
  );
  return rows;
}

export async function declineDistribution() {
  const { rows } = await query(
    `SELECT pa.bucket, pa.error_reason, pa.error_source, s.method,
            count(*)::int AS attempts,
            sum(pa.amount_paise)::bigint AS amount_paise
       FROM payment_attempt pa
       JOIN subscription s ON s.id = pa.subscription_id
      WHERE pa.status = 'failed'
      GROUP BY 1,2,3,4
      ORDER BY attempts DESC`,
  );
  return rows;
}

export async function decisionLog(limit = 200) {
  const { rows } = await query(
    `SELECT d.id, d.subscription_id, d.proposed_action, d.proposed_by, d.verdict,
            d.rule_id, d.scheduled_for, d.proposed_for, d.rationale, d.explanation,
            d.created_at, d.executed_at, d.outcome
       FROM decision d
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function denialsByRule() {
  const { rows } = await query(
    `SELECT rule_id, verdict, count(*)::int AS count
       FROM decision
      WHERE verdict IN ('DENY','DEFER')
      GROUP BY 1,2
      ORDER BY count DESC`,
  );
  return rows;
}
