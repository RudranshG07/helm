import { classify, isOurBug, normalize, score } from '@mandate/core';
import type { NormalizedAttempt, NormalizedSubscription, RazorpayEvent } from '@mandate/core';
import { withTransaction } from '@mandate/db';
import type { PoolClient } from 'pg';
import { config } from './config.ts';
import { recordRazorpayDowntime } from './degradation.ts';
import { log } from './log.ts';

interface RawEventRow {
  id: number;
  rzp_event_id: string;
  event_type: string;
  payload: RazorpayEvent;
  merchant_id: string | null;
}

const DEFAULT_MERCHANT = 'merchant_test';

async function ensureMerchant(client: PoolClient, id: string): Promise<void> {
  await client.query(
    `INSERT INTO merchant (id, name, mode) VALUES ($1, $1, 'test')
     ON CONFLICT (id) DO NOTHING`,
    [id],
  );
}

async function upsertSubscription(
  client: PoolClient,
  merchantId: string,
  sub: NormalizedSubscription,
): Promise<string> {
  const id = `${merchantId}:${sub.rzp_subscription_id}`;
  await client.query(
    `INSERT INTO subscription (
       id, merchant_id, rzp_subscription_id, customer_ref, method, amount_paise,
       cycle_interval, status, current_start, current_end, charge_at, mandate_expiry_at
     ) VALUES ($1,$2,$3,$4,$5,GREATEST($6,1),$7,$8,$9,$10,$11,$12)
     ON CONFLICT (id) DO UPDATE SET
       status            = EXCLUDED.status,
       current_start     = COALESCE(EXCLUDED.current_start, subscription.current_start),
       current_end       = COALESCE(EXCLUDED.current_end, subscription.current_end),
       charge_at         = COALESCE(EXCLUDED.charge_at, subscription.charge_at),
       mandate_expiry_at = COALESCE(EXCLUDED.mandate_expiry_at, subscription.mandate_expiry_at),
       amount_paise      = GREATEST(EXCLUDED.amount_paise, subscription.amount_paise),
       updated_at        = now()`,
    [
      id, merchantId, sub.rzp_subscription_id, sub.customer_ref, sub.method, sub.amount_paise,
      sub.cycle_interval, sub.status, sub.current_start, sub.current_end,
      sub.charge_at, sub.mandate_expiry_at,
    ],
  );
  return id;
}

async function insertAttempt(
  client: PoolClient,
  subscriptionId: string,
  cycle: Date,
  attempt: NormalizedAttempt,
  method: NormalizedSubscription['method'],
): Promise<void> {
  const classification = classify(attempt, method);

  if (isOurBug(attempt)) {
    log.error('ingest.malformed_request', {
      subscription_id: subscriptionId,
      error_reason: attempt.error_reason,
    });
  }

  if (classification.bucket === 'UNKNOWN' && attempt.status === 'failed') {
    log.warn('taxonomy.unmapped_code', {
      subscription_id: subscriptionId,
      error_reason: attempt.error_reason,
      error_source: attempt.error_source,
      matched_rule: classification.matched_rule,
    });
  }

  await client.query(
    `INSERT INTO payment_attempt (
       subscription_id, rzp_payment_id, rzp_order_id, cycle, attempted_at, status, amount_paise,
       error_code, error_description, error_source, error_step, error_reason,
       issuer, bank, initiated_by, source, bucket, taxonomy_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'razorpay_default','webhook',$15,$16)
     ON CONFLICT (rzp_payment_id) WHERE rzp_payment_id IS NOT NULL DO UPDATE SET
       status = EXCLUDED.status,
       bucket = EXCLUDED.bucket`,
    [
      subscriptionId, attempt.rzp_payment_id, attempt.rzp_order_id, cycle, attempt.attempted_at,
      attempt.status, attempt.amount_paise, attempt.error_code, attempt.error_description,
      attempt.error_source, attempt.error_step, attempt.error_reason, attempt.issuer, attempt.bank,
      classification.bucket, classification.taxonomy_version, !isOurBug(attempt),
    ],
  );
}

async function rescore(client: PoolClient, subscriptionId: string, cycle: Date): Promise<void> {
  const { rows } = await client.query<{
    consecutive_failures: number;
    attempts_used: number;
    soft_rate: string;
    mandate_expiry_at: Date | null;
    method: NormalizedSubscription['method'];
    amount_paise: number;
    last_bucket: string | null;
  }>(
    `WITH cycle_attempts AS (
       SELECT * FROM payment_attempt
        WHERE subscription_id = $1 AND cycle = $2
     ),
     recent AS (
       SELECT bucket FROM payment_attempt
        WHERE subscription_id = $1 AND status = 'failed'
        ORDER BY attempted_at DESC LIMIT 1
     )
     SELECT
       (SELECT count(*) FROM cycle_attempts WHERE status = 'failed')::int AS consecutive_failures,
       (SELECT count(*) FROM cycle_attempts WHERE counts_against_budget)::int AS attempts_used,
       COALESCE((SELECT avg(CASE WHEN bucket LIKE 'SOFT%' THEN 1 ELSE 0 END)
                   FROM payment_attempt WHERE subscription_id = $1 AND status = 'failed'), 0) AS soft_rate,
       s.mandate_expiry_at, s.method, s.amount_paise,
       (SELECT bucket FROM recent) AS last_bucket
     FROM subscription s WHERE s.id = $1`,
    [subscriptionId, cycle],
  );

  const row = rows[0];
  if (!row) return;

  const health = score({
    now: new Date(),
    consecutive_failures: row.consecutive_failures,
    attempts_used_this_cycle: row.attempts_used,
    mandate_expiry_at: row.mandate_expiry_at,
    soft_decline_rate: Number(row.soft_rate),
    issuer_degraded: false,
    method: row.method,
    last_bucket: (row.last_bucket ?? null) as never,
  });

  await client.query(
    `INSERT INTO mandate_health (
       subscription_id, consecutive_failures, attempts_remaining, days_to_expiry,
       risk_score, risk_band, contributions, amount_at_risk_paise
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      subscriptionId, row.consecutive_failures, health.attempts_remaining, health.days_to_expiry,
      health.risk_score, health.risk_band, health.contributions,
      health.risk_band === 'healthy' ? 0 : row.amount_paise,
    ],
  );
}

interface DowntimeEntity {
  method?: string;
  severity?: string;
  begin?: number;
  end?: number | null;
  instrument?: { issuer?: string; bank?: string };
}

async function handleDowntime(row: RawEventRow): Promise<void> {
  const payload = row.payload as unknown as {
    payload?: { payment?: { downtime?: { entity?: DowntimeEntity } } };
  };
  const entity = payload?.payload?.payment?.downtime?.entity;
  if (!entity?.method) {
    log.warn('downtime.unrecognised_payload', { raw_event_id: row.id, event_type: row.event_type });
    return;
  }

  const resolved = row.event_type === 'payment.downtime.resolved';
  const issuer = entity.instrument?.issuer ?? entity.instrument?.bank ?? null;
  const method = entity.method === 'upi' ? 'upi_autopay' : entity.method;

  await recordRazorpayDowntime({
    issuer,
    method,
    severity: entity.severity ?? null,
    started_at: entity.begin ? new Date(entity.begin * 1000) : new Date(),
    resolved,
  });

  log.info('downtime.recorded', { issuer, method, resolved, severity: entity.severity ?? null });
}

export async function ingestBatch(): Promise<number> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<RawEventRow>(
      `SELECT id, rzp_event_id, event_type, payload, merchant_id
         FROM raw_event
        WHERE processed_at IS NULL AND signature_ok
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [config.ingestBatchSize],
    );

    for (const row of rows) {
      try {
        if (row.event_type.startsWith('payment.downtime.')) {
          await handleDowntime(row);
          await client.query('UPDATE raw_event SET processed_at = now() WHERE id = $1', [row.id]);
          continue;
        }

        const { subscription, attempt } = normalize(row.payload);
        const merchantId = row.merchant_id ?? DEFAULT_MERCHANT;

        if (subscription) {
          await ensureMerchant(client, merchantId);
          const subscriptionId = await upsertSubscription(client, merchantId, subscription);
          const cycle = subscription.current_start ?? new Date(0);

          if (attempt) {
            await insertAttempt(client, subscriptionId, cycle, attempt, subscription.method);
          }
          await rescore(client, subscriptionId, cycle);
        }

        await client.query('UPDATE raw_event SET processed_at = now() WHERE id = $1', [row.id]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('ingest.failed', { raw_event_id: row.id, event_type: row.event_type, message });
        await client.query(
          'UPDATE raw_event SET processed_at = now(), process_error = $2 WHERE id = $1',
          [row.id, message],
        );
      }
    }

    return rows.length;
  });
}
