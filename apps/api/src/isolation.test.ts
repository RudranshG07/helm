import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { registerControlRoutes } from './control.ts';
import { registerDashboardRoutes } from './dashboard.ts';
import { registerOnboardRoutes } from './onboard.ts';
import { issueSession } from './session.ts';

const A = 'merchant_isolation_a';
const B = 'merchant_isolation_b';

let app: FastifyInstance;
let tokenA = '';
let tokenB = '';

async function seed(merchant: string, subscription: string, customer: string, paise: number) {
  await query(
    `INSERT INTO merchant (id, name, mode, rzp_key_id)
     VALUES ($1, $1, 'test', 'rzp_test_isolation')
     ON CONFLICT (id) DO UPDATE SET rzp_key_id = EXCLUDED.rzp_key_id`,
    [merchant],
  );
  await query(
    `INSERT INTO subscription (id, merchant_id, rzp_subscription_id, customer_ref, method,
                               amount_paise, status, current_start)
     VALUES ($1, $2, $1, $3, 'upi_autopay', $4, 'active', now() - interval '2 days')
     ON CONFLICT (id) DO NOTHING`,
    [subscription, merchant, customer, paise],
  );
  await query(
    `INSERT INTO payment_attempt (subscription_id, rzp_payment_id, attempted_at, status,
                                  amount_paise, error_reason, bucket, initiated_by, cycle)
     VALUES ($1, $2, now() - interval '1 day', 'failed', $3, 'insufficient_funds',
             'SOFT_LIQUIDITY', 'razorpay_default', now() - interval '2 days')
     ON CONFLICT DO NOTHING`,
    [subscription, `pay_${subscription}`, paise],
  );
  await query(
    `INSERT INTO decision (subscription_id, cycle, proposed_action, proposed_by, verdict, rule_id)
     VALUES ($1, now() - interval '2 days', 'RETRY_SCHEDULED', 'agent', 'ALLOW', 'R-OK')`,
    [subscription],
  );
  await query(
    `INSERT INTO mandate_health (subscription_id, scored_at, risk_score, risk_band,
                                 consecutive_failures, attempts_remaining, amount_at_risk_paise)
     VALUES ($1, now(), 0.8, 'at_risk', 1, 3, $2)`,
    [subscription, paise],
  );
}

beforeAll(async () => {
  for (const m of [A, B]) {
    await query(`DELETE FROM mandate_health WHERE subscription_id LIKE $1`, [`sub_${m}%`]);
    await query(`DELETE FROM decision WHERE subscription_id LIKE $1`, [`sub_${m}%`]);
    await query(`DELETE FROM payment_attempt WHERE subscription_id LIKE $1`, [`sub_${m}%`]);
    await query(`DELETE FROM subscription WHERE merchant_id = $1`, [m]);
  }
  await seed(A, `sub_${A}_1`, 'alice@example.com', 50000);
  await seed(B, `sub_${B}_1`, 'bob@example.com', 70000);

  tokenA = await issueSession(A);
  tokenB = await issueSession(B);

  app = Fastify();
  registerDashboardRoutes(app);
  registerControlRoutes(app);
  registerOnboardRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await close();
});

const as = (token: string) => ({ [`x-helm-session`]: token });

describe('a dashboard belongs to one merchant', () => {
  it('refuses every read without a session', async () => {
    for (const url of ['/api/overview', '/api/at-risk', '/api/declines', '/api/decisions',
                       '/api/outreach', '/api/merchants']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, `${url} must not be readable by a stranger`).toBe(401);
    }
  });

  it('refuses a session token that was never issued', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/overview', headers: as('not-a-token') });
    expect(r.statusCode).toBe(401);
  });

  it('shows each merchant only their own mandates', async () => {
    const a = await app.inject({ method: 'GET', url: '/api/at-risk', headers: as(tokenA) });
    const b = await app.inject({ method: 'GET', url: '/api/at-risk', headers: as(tokenB) });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const refsA = a.json().subscriptions.map((s: { customer_ref: string }) => s.customer_ref);
    const refsB = b.json().subscriptions.map((s: { customer_ref: string }) => s.customer_ref);

    expect(refsA).toContain('alice@example.com');
    expect(refsA).not.toContain('bob@example.com');
    expect(refsB).toContain('bob@example.com');
    expect(refsB).not.toContain('alice@example.com');
  });

  it('counts only the caller mandates in the overview', async () => {
    const a = await app.inject({ method: 'GET', url: '/api/overview', headers: as(tokenA) });
    expect(a.json().at_risk_count).toBe(1);
  });

  it('will not open another merchant mandate by id', async () => {
    const r = await app.inject({
      method: 'GET', url: `/api/subscriptions/sub_${B}_1`, headers: as(tokenA),
    });
    expect(r.statusCode).toBe(404);
  });

  it('lists only the caller own account', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/merchants', headers: as(tokenA) });
    const ids = r.json().merchants.map((m: { id: string }) => m.id);
    expect(ids).toEqual([A]);
  });

  it('will not read another merchant onboarding status or report', async () => {
    for (const url of [`/api/onboard/${B}/status`, `/api/onboard/${B}/report`,
                       `/api/onboard/${B}/consent`]) {
      const r = await app.inject({ method: 'GET', url, headers: as(tokenA) });
      expect(r.statusCode, `${url} must be refused`).toBe(403);
    }
  });

  it('will not grant write access on another merchant account', async () => {
    const r = await app.inject({
      method: 'POST', url: `/api/onboard/${B}/consent`, headers: as(tokenA),
      payload: { granted: true, acknowledged: 'I authorise Helm to charge my customers' },
    });
    expect(r.statusCode).toBe(403);

    const { rows } = await query<{ write_enabled: boolean }>(
      `SELECT write_enabled FROM merchant WHERE id = $1`, [B],
    );
    expect(rows[0]!.write_enabled).toBe(false);
  });
});

describe('the public page carries no merchant data', () => {
  it('answers without a session', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/public' });
    expect(r.statusCode).toBe(200);
  });

  it('names no merchant and no customer', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/public' });
    const body = r.payload;
    expect(body).not.toContain('alice@example.com');
    expect(body).not.toContain('bob@example.com');
    expect(body).not.toContain(A);
    expect(body).not.toContain(B);
  });

  it('reports totals as numbers a stranger may see', async () => {
    const totals = (await app.inject({ method: 'GET', url: '/api/public' })).json();
    expect(totals.mandates_watched).toBeGreaterThanOrEqual(2);
    expect(totals.recovered_paise).toBeGreaterThanOrEqual(0);
    expect(Object.keys(totals)).not.toContain('merchants');
  });
});
