import { createHash } from 'node:crypto';
import { query } from '@mandate/db';

export type Arm = 'control' | 'treatment';

export function armFor(subscriptionId: string, salt: string): Arm {
  const digest = createHash('sha256').update(`${salt}|${subscriptionId}`).digest();
  return (digest[0]! & 1) === 0 ? 'control' : 'treatment';
}

export async function assignArm(
  subscriptionId: string,
  salt = process.env['ARM_SALT'] ?? 'helm',
): Promise<Arm> {
  const { rows: existing } = await query<{ arm: Arm }>(
    `SELECT arm FROM arm_assignment WHERE subscription_id = $1`,
    [subscriptionId],
  );
  if (existing[0]) return existing[0].arm;

  const arm = armFor(subscriptionId, salt);
  await query(
    `INSERT INTO arm_assignment (subscription_id, arm, assigned_by)
     VALUES ($1,$2,'hash') ON CONFLICT (subscription_id) DO NOTHING`,
    [subscriptionId, arm],
  );

  const { rows } = await query<{ arm: Arm }>(
    `SELECT arm FROM arm_assignment WHERE subscription_id = $1`,
    [subscriptionId],
  );
  return rows[0]?.arm ?? arm;
}

export interface ArmTotals {
  arm: Arm;
  mandates: number;
  attempts_by_us: number;
  attempts_by_default: number;
  amount_at_risk_paise: number;
  amount_recovered_paise: number;
  mandates_halted: number;
}

const TOTALS_SQL = `
  WITH ranked AS (
    SELECT a.arm, pa.subscription_id, pa.cycle, pa.status, pa.initiated_by,
           s.amount_paise,
           row_number() OVER (
             PARTITION BY pa.subscription_id, pa.cycle ORDER BY pa.attempted_at, pa.id
           ) AS seq
      FROM payment_attempt pa
      JOIN subscription s ON s.id = pa.subscription_id
      JOIN arm_assignment a ON a.subscription_id = pa.subscription_id
     WHERE ($1::text IS NULL OR s.merchant_id = $1)
  ),
  cycles AS (
    SELECT arm, subscription_id, cycle,
           max(amount_paise)::bigint AS amount_paise,
           bool_or(status = 'captured') AS recovered,
           count(*) FILTER (WHERE seq > 1 AND initiated_by = 'mandate_rescue')::int AS ours,
           count(*) FILTER (WHERE seq > 1 AND initiated_by = 'razorpay_default')::int AS theirs
      FROM ranked
     GROUP BY arm, subscription_id, cycle
    HAVING bool_or(status = 'failed')
  )
  SELECT arm,
         count(DISTINCT subscription_id)::int AS mandates,
         COALESCE(sum(ours), 0)::int AS attempts_by_us,
         COALESCE(sum(theirs), 0)::int AS attempts_by_default,
         COALESCE(sum(amount_paise), 0)::bigint AS amount_at_risk_paise,
         COALESCE(sum(amount_paise) FILTER (WHERE recovered), 0)::bigint AS amount_recovered_paise,
         count(*) FILTER (WHERE NOT recovered)::int AS mandates_halted
    FROM cycles
   GROUP BY arm`;

export async function armTotals(merchantId?: string): Promise<ArmTotals[]> {
  const { rows } = await query<ArmTotals>(TOTALS_SQL, [merchantId ?? null]);
  return rows.map((r) => ({
    ...r,
    amount_at_risk_paise: Number(r.amount_at_risk_paise),
    amount_recovered_paise: Number(r.amount_recovered_paise),
  }));
}
