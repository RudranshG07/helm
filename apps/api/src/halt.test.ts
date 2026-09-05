import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPolicyContext } from '@mandate/worker/context';
import { close, query } from '@mandate/db';
import { registerControlRoutes } from './control.ts';
import { issueSession } from './session.ts';

const A = 'merchant_halt_a';
const B = 'merchant_halt_b';
const SUB_A = `${A}:sub`;
const SUB_B = `${B}:sub`;

let app: FastifyInstance;
let tokenA = '';
let tokenB = '';

async function seed(merchant: string, subscription: string) {
  await query(
    `INSERT INTO merchant (id, name, mode, write_enabled) VALUES ($1, $1, 'test', TRUE)
     ON CONFLICT (id) DO UPDATE SET write_enabled = TRUE, halted_at = NULL, halt_reason = NULL`,
    [merchant],
  );
  await query(
    `INSERT INTO subscription (id, merchant_id, rzp_subscription_id, customer_ref, method,
                               amount_paise, status, current_start, current_end)
     VALUES ($1, $2, $1, 'someone', 'upi_autopay', 50000, 'active',
             now() - interval '3 days', now() + interval '20 days')
     ON CONFLICT (id) DO NOTHING`,
    [subscription, merchant],
  );
}

const cycleOf = async (subscription: string) => {
  const { rows } = await query<{ cycle: Date }>(
    `SELECT current_start AS cycle FROM subscription WHERE id = $1`, [subscription],
  );
  return rows[0]!.cycle;
};

beforeAll(async () => {
  await query(`UPDATE control_flags SET kill_switch = FALSE WHERE id = 1`);
  for (const [m, s] of [[A, SUB_A], [B, SUB_B]] as const) {
    await query(`DELETE FROM subscription WHERE merchant_id = $1`, [m]);
    await seed(m, s);
  }
  tokenA = await issueSession(A);
  tokenB = await issueSession(B);

  app = Fastify();
  registerControlRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await close();
});

const as = (token: string) => ({ 'x-helm-session': token });

const halt = (token: string, engaged: boolean) =>
  app.inject({
    method: 'POST', url: '/api/control/kill-switch',
    headers: as(token), payload: { engaged },
  });

describe('halting stops one account, never everybody', () => {
  it('refuses to halt anything for a stranger', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/control/kill-switch', payload: { engaged: true },
    });
    expect(res.statusCode).toBe(401);
  });

  it('halts only the account that pressed it', async () => {
    expect((await halt(tokenA, true)).statusCode).toBe(200);

    const mine = await app.inject({ method: 'GET', url: '/api/control', headers: as(tokenA) });
    const theirs = await app.inject({ method: 'GET', url: '/api/control', headers: as(tokenB) });

    expect(mine.json().halted, 'the account that halted must read as halted').toBe(true);
    expect(theirs.json().halted, 'another merchant must be unaffected').toBe(false);
  });

  it('stops the policy for the halted merchant', async () => {
    const context = await loadPolicyContext(SUB_A, await cycleOf(SUB_A), 1, new Date());
    expect(context?.kill_switch).toBe(true);
  });

  it('leaves the policy running for everyone else', async () => {
    const context = await loadPolicyContext(SUB_B, await cycleOf(SUB_B), 1, new Date());
    expect(context?.kill_switch).toBe(false);
  });

  it('resumes without needing a token nobody has', async () => {
    const res = await halt(tokenA, false);
    expect(res.statusCode).toBe(200);
    expect(res.json().halted).toBe(false);

    const context = await loadPolicyContext(SUB_A, await cycleOf(SUB_A), 1, new Date());
    expect(context?.kill_switch).toBe(false);
  });

  it('records why an account was halted', async () => {
    await app.inject({
      method: 'POST', url: '/api/control/kill-switch',
      headers: as(tokenA), payload: { engaged: true, reason: 'refund run in progress' },
    });
    const state = await app.inject({ method: 'GET', url: '/api/control', headers: as(tokenA) });
    expect(state.json().halt_reason).toBe('refund run in progress');
    await halt(tokenA, false);
  });
});

describe('the operator-wide stop still exists above the merchants', () => {
  it('stops every merchant while it is set', async () => {
    await query(`UPDATE control_flags SET kill_switch = TRUE WHERE id = 1`);
    try {
      const a = await loadPolicyContext(SUB_A, await cycleOf(SUB_A), 1, new Date());
      const b = await loadPolicyContext(SUB_B, await cycleOf(SUB_B), 1, new Date());
      expect(a?.kill_switch).toBe(true);
      expect(b?.kill_switch).toBe(true);
    } finally {
      await query(`UPDATE control_flags SET kill_switch = FALSE WHERE id = 1`);
    }
  });

  it('is no longer reachable from a merchant dashboard', async () => {
    await halt(tokenA, true);
    const { rows } = await query<{ kill_switch: boolean }>(
      `SELECT kill_switch FROM control_flags WHERE id = 1`,
    );
    expect(rows[0]!.kill_switch, 'a merchant halt must not touch the global flag').toBe(false);
    await halt(tokenA, false);
  });
});
