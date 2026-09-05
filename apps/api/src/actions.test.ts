import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { registerActionRoutes } from './actions.ts';
import { issueSession } from './session.ts';

const M = 'merchant_action_test';
const OTHER = 'merchant_action_other';
const SUB = `${M}:sub`;
const THEIRS = `${OTHER}:sub`;

let app: FastifyInstance;
let mine = '';
let theirs = '';

async function seed(merchant: string, subscription: string) {
  await query(
    `INSERT INTO merchant (id, name, mode, write_enabled) VALUES ($1, $1, 'test', TRUE)
     ON CONFLICT (id) DO UPDATE SET write_enabled = TRUE`,
    [merchant],
  );
  await query(
    `INSERT INTO subscription (id, merchant_id, rzp_subscription_id, customer_ref, method,
                               amount_paise, status, current_start, current_end,
                               mandate_expiry_at)
     VALUES ($1, $2, $1, 'someone', 'upi_autopay', 50000, 'active',
             now() - interval '3 days', now() + interval '20 days', now() + interval '300 days')
     ON CONFLICT (id) DO NOTHING`,
    [subscription, merchant],
  );
  await query(
    `INSERT INTO payment_attempt (subscription_id, rzp_payment_id, attempted_at, status,
                                  amount_paise, error_reason, bucket, initiated_by, cycle)
     VALUES ($1, $2, now() - interval '1 day', 'failed', 50000, 'insufficient_funds',
             'SOFT_LIQUIDITY', 'razorpay_default', now() - interval '3 days')
     ON CONFLICT DO NOTHING`,
    [subscription, `pay_${subscription}`],
  );
}

beforeAll(async () => {
  for (const [m, s] of [[M, SUB], [OTHER, THEIRS]] as const) {
    await query(`DELETE FROM decision WHERE subscription_id = $1`, [s]);
    await query(`DELETE FROM payment_attempt WHERE subscription_id = $1`, [s]);
    await query(`DELETE FROM subscription WHERE merchant_id = $1`, [m]);
  }
  await seed(M, SUB);
  await seed(OTHER, THEIRS);
  mine = await issueSession(M);
  theirs = await issueSession(OTHER);

  app = Fastify();
  registerActionRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await close();
});

const act = (subscription: string, token: string, body: Record<string, unknown>) =>
  app.inject({
    method: 'POST', url: `/api/mandates/${subscription}/action`,
    headers: { 'x-helm-session': token }, payload: body,
  });

describe('a merchant can act, and is judged by the same rules as the agent', () => {
  it('refuses a stranger', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/mandates/${SUB}/action`, payload: { action: 'STOP' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('will not act on another merchant mandate', async () => {
    const res = await act(SUB, theirs, { action: 'STOP' });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an action the policy has never heard of', async () => {
    const res = await act(SUB, mine, { action: 'REFUND_EVERYTHING' });
    expect(res.statusCode).toBe(400);
  });

  it('records what the merchant asked for, and who asked', async () => {
    const res = await act(SUB, mine, { action: 'RETRY_SCHEDULED' });
    expect(res.statusCode).toBe(200);

    const { rows } = await query<{ proposed_by: string; proposed_action: string }>(
      `SELECT proposed_by, proposed_action FROM decision
        WHERE id = $1::bigint`, [res.json().decision_id],
    );
    expect(rows[0]).toMatchObject({ proposed_by: 'merchant', proposed_action: 'RETRY_SCHEDULED' });
  });

  it('names the rule when it refuses, rather than failing quietly', async () => {
    await query(`UPDATE merchant SET write_enabled = FALSE WHERE id = $1`, [M]);
    const res = await act(SUB, mine, { action: 'RETRY_SCHEDULED' });
    await query(`UPDATE merchant SET write_enabled = TRUE WHERE id = $1`, [M]);

    expect(res.statusCode).toBe(200);
    expect(res.json().verdict).toBe('DENY');
    expect(res.json().rule_id).toMatch(/^R-/);
    expect(res.json().explanation).toBeTruthy();
  });

  it('writes a refusal into the audit trail, not just the response', async () => {
    await query(`UPDATE merchant SET write_enabled = FALSE WHERE id = $1`, [M]);
    const res = await act(SUB, mine, { action: 'RETRY_SCHEDULED' });
    await query(`UPDATE merchant SET write_enabled = TRUE WHERE id = $1`, [M]);

    const { rows } = await query<{ verdict: string; rule_id: string }>(
      `SELECT verdict, rule_id FROM decision WHERE id = $1::bigint`, [res.json().decision_id],
    );
    expect(rows[0]!.verdict).toBe('DENY');
    expect(rows[0]!.rule_id).toBe(res.json().rule_id);
  });

  it('keeps the merchant note as the rationale', async () => {
    const res = await act(SUB, mine, { action: 'STOP', note: 'Customer rang and cancelled.' });
    const { rows } = await query<{ rationale: string }>(
      `SELECT rationale FROM decision WHERE id = $1::bigint`, [res.json().decision_id],
    );
    expect(rows[0]!.rationale).toBe('Customer rang and cancelled.');
  });
});
