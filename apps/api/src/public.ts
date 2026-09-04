import { query } from '@mandate/db';

export interface PublicTotals {
  merchants_connected: number;
  mandates_watched: number;
  decisions_made: number;
  decisions_denied: number;
  attempts_made: number;
  recovered_paise: number;
  recovered_count: number;
  at_risk_paise: number;
  first_connected_at: string | null;
}

const REAL_MERCHANTS = `SELECT id FROM merchant WHERE rzp_key_id IS NOT NULL`;

export async function publicTotals(): Promise<PublicTotals> {
  const { rows } = await query<PublicTotals>(`
    WITH real AS (${REAL_MERCHANTS}),
    subs AS (
      SELECT s.id, s.amount_paise FROM subscription s JOIN real r ON r.id = s.merchant_id
    ),
    ours AS (
      SELECT pa.status, pa.amount_paise
        FROM payment_attempt pa
        JOIN subs s ON s.id = pa.subscription_id
       WHERE pa.initiated_by = 'mandate_rescue'
    ),
    dec AS (
      SELECT d.verdict FROM decision d JOIN subs s ON s.id = d.subscription_id
    ),
    risk AS (
      SELECT DISTINCT ON (h.subscription_id) h.amount_at_risk_paise, h.risk_band
        FROM mandate_health h JOIN subs s ON s.id = h.subscription_id
       ORDER BY h.subscription_id, h.scored_at DESC, h.id DESC
    )
    SELECT
      (SELECT count(*)::int FROM real)                                    AS merchants_connected,
      (SELECT count(*)::int FROM subs)                                    AS mandates_watched,
      (SELECT count(*)::int FROM dec)                                     AS decisions_made,
      (SELECT count(*)::int FROM dec WHERE verdict IN ('DENY','DEFER'))   AS decisions_denied,
      (SELECT count(*)::int FROM ours)                                    AS attempts_made,
      (SELECT COALESCE(sum(amount_paise), 0)::bigint FROM ours
        WHERE status = 'captured')                                        AS recovered_paise,
      (SELECT count(*)::int FROM ours WHERE status = 'captured')           AS recovered_count,
      (SELECT COALESCE(sum(amount_at_risk_paise), 0)::bigint FROM risk
        WHERE risk_band <> 'healthy')                                     AS at_risk_paise,
      (SELECT min(connected_at) FROM merchant WHERE rzp_key_id IS NOT NULL) AS first_connected_at
  `);
  const r = rows[0]!;
  return {
    ...r,
    recovered_paise: Number(r.recovered_paise),
    at_risk_paise: Number(r.at_risk_paise),
  };
}
