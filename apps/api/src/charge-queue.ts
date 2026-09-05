import type { FastifyInstance } from 'fastify';
import { query } from '@mandate/db';
import { requireMerchant } from './session.ts';

export interface QueueRow {
  subscription_id: string;
  customer_ref: string;
  method: string;
  amount_paise: number;
  risk_band: string;
  attempts_remaining: number;
  last_error_reason: string | null;
  last_bucket: string | null;
  rzp_subscription_id: string;
  chargeable: boolean;
  blocked_reason: string | null;
}

const QUEUE_SQL = `
WITH latest AS (
  SELECT DISTINCT ON (subscription_id) * FROM mandate_health
   ORDER BY subscription_id, scored_at DESC, id DESC
)
SELECT
  s.id AS subscription_id, s.customer_ref, s.method, s.amount_paise,
  s.rzp_subscription_id,
  h.risk_band, h.attempts_remaining,
  a.error_reason AS last_error_reason,
  COALESCE(a.bucket, 'UNKNOWN') AS last_bucket,
  (s.method <> 'card') AS chargeable,
  CASE WHEN s.method = 'card'
       THEN 'Razorpay does not support manually charging a domestic card'
       ELSE NULL END AS blocked_reason
FROM latest h
JOIN subscription s ON s.id = h.subscription_id
JOIN merchant m ON m.id = s.merchant_id
LEFT JOIN LATERAL (
  SELECT error_reason, bucket FROM payment_attempt
   WHERE subscription_id = s.id AND status = 'failed'
   ORDER BY attempted_at DESC LIMIT 1
) a ON TRUE
WHERE h.risk_band <> 'healthy'
  AND m.id = $1
  AND m.integration IS DISTINCT FROM 'recurring_tokens'
ORDER BY (s.method <> 'card') DESC, s.amount_paise DESC
LIMIT $2
`;

export function registerChargeQueueRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { limit?: string } }>('/api/charge-queue', async (request, reply) => {
    const merchant = await requireMerchant(request, reply);
    if (merchant === null) return reply;
    const limit = Math.min(500, Number(request.query.limit ?? 100) || 100);
    const [{ rows }, integration] = await Promise.all([
      query<QueueRow>(QUEUE_SQL, [merchant, limit]),
      query<{ integration: string | null; at_risk: number }>(
        `SELECT m.integration,
                (SELECT count(*)::int FROM subscription s WHERE s.merchant_id = m.id) AS at_risk
           FROM merchant m WHERE m.id = $1`,
        [merchant],
      ).then((r) => r.rows[0]),
    ]);

    const chargesItself = integration?.integration === 'recurring_tokens';

    return {
      queue: rows,
      integration: integration?.integration ?? null,
      charges_itself: chargesItself,
      note: chargesItself
        ? 'Your account holds saved mandates, which Helm charges itself at the time it chose. ' +
          'Nothing lands here for you to action by hand. This queue only fills for accounts on ' +
          'Razorpay Subscriptions, where an invoice is issued and no API can charge it.'
        : 'Razorpay exposes no API to charge an issued invoice. These are ranked for a human to ' +
          'action from the Razorpay dashboard, highest expected value first. Domestic cards cannot ' +
          'be charged manually by anyone and are listed last.',
    };
  });
}
