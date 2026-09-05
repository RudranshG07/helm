import { requireMerchant } from './session.ts';
import type { FastifyInstance } from 'fastify';
import { query, withTransaction } from '@mandate/db';
import { cleanup, runLiveBatch } from '@mandate/worker/batch/live';
import { nightlySweep } from '@mandate/worker/nightly';
import { probeAccount } from './account.ts';

interface RzpOrder { id: string; amount: number; status: string }
interface RzpCustomer { id: string }
interface RzpPayment {
  id: string;
  status: string;
  token_id: string | null;
  customer_id: string | null;
  order_id: string | null;
  method: string | null;
  error_reason?: string | null;
}

function credentials(): { keyId: string; keySecret: string } {
  const keyId = process.env['RAZORPAY_KEY_ID'];
  const keySecret = process.env['RAZORPAY_KEY_SECRET'];
  if (!keyId || !keySecret) throw new Error('Razorpay keys are not configured.');
  if (!keyId.startsWith('rzp_test_')) throw new Error('Authorization setup runs in test mode only.');
  return { keyId, keySecret };
}

async function rzp<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { keyId, keySecret } = credentials();
  const auth = Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64');
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    let message = `Razorpay responded ${response.status}`;
    try {
      const body = JSON.parse(text) as { error?: { description?: string } | string };
      message = typeof body.error === 'string'
        ? body.error
        : body.error?.description ?? message;
    } catch { /* keep status message */ }
    throw new Error(message);
  }
  return JSON.parse(text) as T;
}

export const RECURRING_METHODS = ['upi_autopay', 'card', 'nach', 'emandate'] as const;
export type RecurringMethod = (typeof RECURRING_METHODS)[number];

export const MANDATE_SET: {
  label: string;
  amount_paise: number;
  method: RecurringMethod;
  frequency: 'monthly' | 'weekly' | 'yearly';
}[] = [
  { label: 'Gym membership', amount_paise: 149900, method: 'upi_autopay', frequency: 'monthly' },
  { label: 'Tiffin service', amount_paise: 49900, method: 'upi_autopay', frequency: 'weekly' },
  { label: 'Streaming', amount_paise: 19900, method: 'upi_autopay', frequency: 'monthly' },
  { label: 'Coaching fees', amount_paise: 499900, method: 'card', frequency: 'monthly' },
  { label: 'Insurance premium', amount_paise: 89900, method: 'card', frequency: 'yearly' },
  { label: 'Society maintenance', amount_paise: 249900, method: 'nach', frequency: 'monthly' },
  { label: 'Newspaper delivery', amount_paise: 4900, method: 'upi_autopay', frequency: 'monthly' },
  { label: 'Broadband', amount_paise: 119900, method: 'emandate', frequency: 'monthly' },
];

const MERCHANT_ID = 'helm_test_account';
const DEMO_MERCHANT_ID = 'helm_demo_batch';
const MAX_AMOUNT_PAISE = 1_500_000;

export function registerAuthorizeRoutes(app: FastifyInstance): void {
  app.get('/api/authorize/config', async (request, reply) => {
    if ((await requireMerchant(request, reply)) === null) return reply;
    let ready = true;
    let problem: string | null = null;
    try {
      credentials();
    } catch (err) {
      ready = false;
      problem = (err as Error).message;
    }
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM subscription
        WHERE merchant_id = $1 AND rzp_token_id IS NOT NULL`,
      [MERCHANT_ID],
    );
    const account = await probeAccount(ready ? process.env['RAZORPAY_KEY_ID'] : undefined);

    return {
      ready,
      problem,
      key_id: ready ? process.env['RAZORPAY_KEY_ID'] : null,
      mandates: MANDATE_SET,
      authorized: rows[0]!.n,
      account,
    };
  });

  app.get('/api/authorize/account', async (request, reply) => {
    if ((await requireMerchant(request, reply)) === null) return reply;
    return probeAccount(process.env['RAZORPAY_KEY_ID']);
  });

  app.post<{
    Body: {
      label?: string; amount_paise?: number; method?: string; frequency?: string;
      contact?: string; email?: string;
    };
  }>(
    '/api/authorize/prepare',
    async (request, reply) => {
      if ((await requireMerchant(request, reply)) === null) return reply;
      const label = (request.body?.label ?? '').trim() || 'Mandate';
      const amount = Number(request.body?.amount_paise ?? 0);
      const requested = request.body?.method ?? '';
      const method: RecurringMethod = (RECURRING_METHODS as readonly string[]).includes(requested)
        ? (requested as RecurringMethod)
        : 'upi_autopay';
      const frequency = request.body?.frequency === 'weekly' || request.body?.frequency === 'yearly'
        ? request.body.frequency
        : 'monthly';

      if (!Number.isInteger(amount) || amount < 100) {
        return reply.code(400).send({ error: 'Amount must be a whole number of paise, at least 100.' });
      }

      try {
        const customer = await rzp<RzpCustomer>('/customers', {
          method: 'POST',
          body: JSON.stringify({
            name: label,
            contact: request.body?.contact ?? '9876543210',
            email: request.body?.email ?? 'mandate@helm.test',
            fail_existing: '0',
          }),
        });

        const maxAmount = Math.min(MAX_AMOUNT_PAISE, Math.max(amount * 2, 100000));
        const expireAt = Math.floor(Date.now() / 1000) + 365 * 86400;

        const receipt = `helm_auth_${Date.now()}`;
        const notes = { helm_label: label, helm_amount: String(amount) };
        const bankAccount = {
          beneficiary_name: label,
          account_number: '11214311570503',
          account_type: 'savings',
          ifsc_code: 'HDFC0000053',
        };

        const bodies: Record<RecurringMethod, Record<string, unknown>> = {
          upi_autopay: {
            amount: 100, currency: 'INR', method: 'upi', customer_id: customer.id,
            receipt, payment_capture: true, notes,
            token: { max_amount: maxAmount, expire_at: expireAt, frequency },
          },
          card: {
            amount: 100, currency: 'INR', method: 'card', customer_id: customer.id,
            receipt, payment_capture: true, notes,
            token: { max_amount: maxAmount, expire_at: expireAt, frequency },
          },
          nach: {
            amount: 0, currency: 'INR', method: 'nach', customer_id: customer.id,
            receipt, payment_capture: true, notes,
            token: {
              auth_type: 'physical', max_amount: maxAmount, expire_at: expireAt,
              bank_account: bankAccount,
              nach: { description: label.slice(0, 30) },
            },
          },
          emandate: {
            amount: 0, currency: 'INR', method: 'emandate', customer_id: customer.id,
            receipt, payment_capture: true, notes,
            token: {
              auth_type: 'netbanking', max_amount: maxAmount, expire_at: expireAt,
              bank_account: bankAccount,
            },
          },
        };
        const body = bodies[method];

        const order = await rzp<RzpOrder>('/orders', {
          method: 'POST',
          body: JSON.stringify(body),
        });

        return {
          order_id: order.id,
          customer_id: customer.id,
          key_id: process.env['RAZORPAY_KEY_ID'],
          label,
          amount_paise: amount,
          method,
          frequency,
          bank: method === 'emandate' || method === 'nach' ? 'HDFC' : null,
        };
      } catch (err) {
        app.log.error({ event: 'authorize.prepare_failed', message: (err as Error).message });
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Body: { payment_id?: string; label?: string; amount_paise?: number } }>(
    '/api/authorize/complete',
    async (request, reply) => {
      if ((await requireMerchant(request, reply)) === null) return reply;
      const paymentId = (request.body?.payment_id ?? '').trim();
      if (!paymentId) return reply.code(400).send({ error: 'No payment id supplied.' });

      let payment: RzpPayment;
      try {
        payment = await rzp<RzpPayment>(`/payments/${encodeURIComponent(paymentId)}`);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      if (!payment.token_id || !payment.customer_id) {
        return reply.code(400).send({
          error: 'That payment did not produce a mandate token. It may have failed or not been a recurring authorisation.',
        });
      }

      const label = (request.body?.label ?? 'Mandate').trim();
      const amount = Number(request.body?.amount_paise ?? 0) || 49900;
      const subscriptionId = `${MERCHANT_ID}:${payment.token_id}`;
      const cycleStart = new Date();
      const cycleEnd = new Date(cycleStart.getTime() + 30 * 86_400_000);

      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO merchant (id, name, mode, integration, onboarding_state,
                                 cross_merchant_signals, write_enabled, synthetic)
           VALUES ($1,'Helm test account','test','recurring_tokens','ready',TRUE,FALSE,TRUE)
           ON CONFLICT (id) DO UPDATE SET synthetic = TRUE`,
          [MERCHANT_ID],
        );
        await client.query(
          `INSERT INTO subscription (
             id, merchant_id, rzp_subscription_id, customer_ref, customer_key, method,
             amount_paise, status, current_start, current_end,
             rzp_token_id, rzp_customer_id, mandate_expiry_at
           ) VALUES ($1,$2,$3,$4,$5,$12,$6,'active',$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO UPDATE SET
             rzp_token_id = EXCLUDED.rzp_token_id,
             rzp_customer_id = EXCLUDED.rzp_customer_id,
             status = 'active'`,
          [
            subscriptionId, MERCHANT_ID, payment.token_id, label,
            `ck_${payment.customer_id}`, amount, cycleStart, cycleEnd,
            payment.token_id, payment.customer_id,
            new Date(cycleStart.getTime() + 365 * 86_400_000),
            payment.method === 'card' ? 'card' : 'emandate',
          ],
        );
      });

      app.log.info({ event: 'authorize.mandate_created', subscription_id: subscriptionId, label });
      return {
        subscription_id: subscriptionId,
        token_id: payment.token_id,
        label,
        amount_paise: amount,
      };
    },
  );

  app.post<{ Body: { count?: number } }>('/api/authorize/demo', async (request, reply) => {
    if ((await requireMerchant(request, reply)) === null) return reply;
    const count = Math.min(Math.max(Number(request.body?.count ?? 40), 1), 200);

    try {
      await cleanup(DEMO_MERCHANT_ID);
      const anchored = new Date(Date.now());
      anchored.setUTCHours(3, 30, 0, 0);
      const result = await runLiveBatch({
        count,
        merchantId: DEMO_MERCHANT_ID,
        now: anchored,
      });
      const sweep = await nightlySweep(new Date());

      app.log.info({
        event: 'authorize.demo_batch',
        count,
        merchant_id: DEMO_MERCHANT_ID,
        scored: sweep.scored,
      });

      return {
        ...result,
        simulated: true,
        anchored_at: anchored.toISOString(),
        scored: sweep.scored,
      };
    } catch (err) {
      app.log.error({ event: 'authorize.demo_failed', message: (err as Error).message });
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.get('/api/authorize/mandates', async (request, reply) => {
    if ((await requireMerchant(request, reply)) === null) return reply;
    const { rows } = await query(
      `SELECT id, customer_ref AS label, amount_paise, rzp_token_id, status, current_start
         FROM subscription
        WHERE merchant_id = $1 AND rzp_token_id IS NOT NULL
        ORDER BY created_at DESC`,
      [MERCHANT_ID],
    );
    return { mandates: rows };
  });
}
