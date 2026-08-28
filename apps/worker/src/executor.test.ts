import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { idempotencyKey } from '@mandate/core';
import { close, query } from '@mandate/db';
import { execute, reconcileStuck } from './executor.ts';
import type { CrashPoint, ExecutionRequest } from './executor.ts';
import { StubGateway } from './gateway.stub.ts';

const CYCLE = new Date('2026-09-01T00:00:00.000Z');
const MERCHANT = 'merchant_exec_test';
const SUB = `${MERCHANT}:sub_exec`;

function request(over: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    decision_id: null,
    subscription_id: SUB,
    rzp_subscription_id: 'sub_exec',
    cycle: CYCLE,
    attempt_number: 2,
    amount_paise: 49900,
    scheduled_for: new Date('2026-09-03T08:00:00.000Z'),
    ...over,
  };
}

async function seed(opts: { killSwitch?: boolean; writeEnabled?: boolean } = {}) {
  await query(`DELETE FROM mandate_health WHERE subscription_id = $1`, [SUB]);
  await query(`DELETE FROM execution_intent WHERE subscription_id = $1`, [SUB]);
  await query(`DELETE FROM decision WHERE subscription_id = $1`, [SUB]);
  await query(`DELETE FROM payment_attempt WHERE subscription_id = $1`, [SUB]);
  await query(`DELETE FROM subscription WHERE id = $1`, [SUB]);
  await query(`DELETE FROM merchant WHERE id = $1`, [MERCHANT]);

  await query(
    `INSERT INTO merchant (id, name, mode, write_enabled) VALUES ($1,$1,'test',$2)`,
    [MERCHANT, opts.writeEnabled ?? true],
  );
  await query(
    `INSERT INTO subscription (
       id, merchant_id, rzp_subscription_id, customer_ref, method, amount_paise,
       status, current_start
     ) VALUES ($1,$2,'sub_exec','cust_exec','upi_autopay',49900,'pending',$3)`,
    [SUB, MERCHANT, CYCLE],
  );
  await query(`UPDATE control_flags SET kill_switch = $1 WHERE id = 1`, [opts.killSwitch ?? false]);
}

async function intentState(): Promise<string | null> {
  const { rows } = await query<{ state: string }>(
    `SELECT state FROM execution_intent WHERE idempotency_key = $1`,
    [idempotencyKey(request())],
  );
  return rows[0]?.state ?? null;
}

async function intentCount(): Promise<number> {
  const { rows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM execution_intent WHERE subscription_id = $1`,
    [SUB],
  );
  return rows[0]!.n;
}

afterAll(async () => {
  await query(`UPDATE control_flags SET kill_switch = FALSE WHERE id = 1`);
  await close();
});

describe('a crash at every seam produces at most one charge', () => {
  const seams: CrashPoint[] = ['after_intent', 'before_gateway', 'after_gateway', 'before_settle'];

  it.each(seams)('crash %s, then restart and run again', async (crashAt) => {
    await seed();
    const gateway = new StubGateway();

    await expect(
      execute(request(), { gateway, dryRun: false, crashAt }),
    ).rejects.toThrow('simulated crash');

    const second = await execute(request(), { gateway, dryRun: false });
    const third = await execute(request(), { gateway, dryRun: false });

    expect(gateway.ordersCreated).toBeLessThanOrEqual(1);
    expect(await intentCount()).toBe(1);
    expect(second.status).toBe('duplicate');
    expect(third.status).toBe('duplicate');
  });

  it.each(seams)('crash %s leaves the key permanently claimed, even after reconciliation', async (crashAt) => {
    await seed();
    const gateway = new StubGateway();

    await expect(
      execute(request(), { gateway, dryRun: false, crashAt }),
    ).rejects.toThrow('simulated crash');

    await reconcileStuck(gateway, 0);
    const after = await execute(request(), { gateway, dryRun: false });

    expect(after.status).toBe('duplicate');
    expect(gateway.ordersCreated).toBeLessThanOrEqual(1);
  });

  it('a crash before the gateway leaves nothing charged, and the reconciler frees the attempt', async () => {
    await seed();
    const gateway = new StubGateway();

    await expect(
      execute(request(), { gateway, dryRun: false, crashAt: 'before_gateway' }),
    ).rejects.toThrow();

    expect(gateway.ordersCreated).toBe(0);
    await reconcileStuck(gateway, 0);
    expect(await intentState()).toBe('ABANDONED');
  });

  it('a crash after the gateway did charge is reconciled to the real outcome, not re-charged', async () => {
    await seed();
    const gateway = new StubGateway({ paymentStatus: 'captured' });

    await expect(
      execute(request(), { gateway, dryRun: false, crashAt: 'after_gateway' }),
    ).rejects.toThrow();

    expect(gateway.ordersCreated).toBe(1);
    await reconcileStuck(gateway, 0);

    expect(await intentState()).toBe('SETTLED_SUCCESS');
    expect(gateway.ordersCreated).toBe(1);
  });
});

describe('duplicate protection', () => {
  it('a second execute for the same subscription, cycle and attempt never reaches the gateway', async () => {
    await seed();
    const gateway = new StubGateway();

    const first = await execute(request(), { gateway, dryRun: false });
    const second = await execute(request(), { gateway, dryRun: false });

    expect(first.status).toBe('executed');
    expect(second.status).toBe('duplicate');
    expect(gateway.createCalls).toHaveLength(1);
  });

  it('two concurrent workers produce exactly one order', async () => {
    await seed();
    const gateway = new StubGateway();

    const results = await Promise.all([
      execute(request(), { gateway, dryRun: false }),
      execute(request(), { gateway, dryRun: false }),
    ]);

    expect(gateway.ordersCreated).toBe(1);
    expect(results.filter((r) => r.status === 'executed')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(1);
  });

  it('a gateway that rejects the receipt is reconciled, never retried with a new receipt', async () => {
    await seed();
    const gateway = new StubGateway();
    await execute(request(), { gateway, dryRun: false });

    await query(`DELETE FROM execution_intent WHERE subscription_id = $1`, [SUB]);

    const result = await execute(request(), { gateway, dryRun: false });

    expect(result.status).toBe('reconciled');
    expect(gateway.ordersCreated).toBe(1);
    const receipts = new Set(gateway.createCalls.map((c) => c.receipt));
    expect(receipts.size).toBe(1);
  });

  it('a different attempt number is a different charge and is allowed', async () => {
    await seed();
    const gateway = new StubGateway();

    await execute(request({ attempt_number: 2 }), { gateway, dryRun: false });
    await execute(request({ attempt_number: 3 }), { gateway, dryRun: false });

    expect(gateway.ordersCreated).toBe(2);
  });
});

describe('guards are checked immediately before the call, not only at proposal time', () => {
  it('the kill switch blocks execution and writes no intent', async () => {
    await seed({ killSwitch: true });
    const gateway = new StubGateway();

    const result = await execute(request(), { gateway, dryRun: false });

    expect(result.status).toBe('blocked');
    expect(gateway.createCalls).toHaveLength(0);
    expect(await intentCount()).toBe(0);
  });

  it('a merchant without write access is blocked', async () => {
    await seed({ writeEnabled: false });
    const gateway = new StubGateway();

    const result = await execute(request(), { gateway, dryRun: false });

    expect(result.status).toBe('blocked');
    expect(gateway.createCalls).toHaveLength(0);
  });

  it('dry run writes the intent but never reaches the gateway', async () => {
    await seed();
    const gateway = new StubGateway();

    const result = await execute(request(), { gateway, dryRun: true });

    expect(result.status).toBe('dry_run');
    expect(gateway.createCalls).toHaveLength(0);
    expect(await intentState()).toBe('DRY_RUN');
  });

  it('a dry run still consumes the idempotency key, so a later live run cannot double it', async () => {
    await seed();
    const gateway = new StubGateway();

    await execute(request(), { gateway, dryRun: true });
    const live = await execute(request(), { gateway, dryRun: false });

    expect(live.status).toBe('duplicate');
    expect(gateway.createCalls).toHaveLength(0);
  });
});

describe('settlement', () => {
  it('records a captured payment as a recovery on the decision', async () => {
    await seed();
    const { rows } = await query<{ id: number }>(
      `INSERT INTO decision (subscription_id, cycle, proposed_action, proposed_by, verdict, rule_id)
       VALUES ($1,$2,'RETRY_SCHEDULED','test','ALLOW','R-OK') RETURNING id`,
      [SUB, CYCLE],
    );
    const gateway = new StubGateway({ paymentStatus: 'captured' });

    await execute(request({ decision_id: rows[0]!.id }), { gateway, dryRun: false });

    expect(await intentState()).toBe('SETTLED_SUCCESS');
    const outcome = await query<{ outcome: string }>(
      `SELECT outcome FROM decision WHERE id = $1`, [rows[0]!.id],
    );
    expect(outcome.rows[0]!.outcome).toBe('recovered');
  });

  it('records a failed payment without freeing the attempt', async () => {
    await seed();
    const gateway = new StubGateway({ paymentStatus: 'failed' });

    await execute(request(), { gateway, dryRun: false });

    expect(await intentState()).toBe('SETTLED_FAILED');
  });

  it('an order with no payment yet stays SUBMITTED rather than being declared failed', async () => {
    await seed();
    const gateway = new StubGateway({ paymentStatus: 'created' });

    await execute(request(), { gateway, dryRun: false });

    expect(await intentState()).toBe('SUBMITTED');
  });
});

describe('an amount change is refused loudly, not silently deduplicated', () => {
  it('reports a mismatch rather than a benign duplicate', async () => {
    await seed();
    const gateway = new StubGateway();

    await execute(request({ amount_paise: 49900 }), { gateway, dryRun: false });
    const second = await execute(request({ amount_paise: 79900 }), { gateway, dryRun: false });

    expect(second.status).toBe('amount_mismatch');
    if (second.status === 'amount_mismatch') {
      expect(second.intended_paise).toBe(49900);
      expect(second.requested_paise).toBe(79900);
    }
  });

  it('does not charge the new amount', async () => {
    await seed();
    const gateway = new StubGateway();

    await execute(request({ amount_paise: 49900 }), { gateway, dryRun: false });
    await execute(request({ amount_paise: 79900 }), { gateway, dryRun: false });

    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.createCalls[0]!.amount_paise).toBe(49900);
  });

  it('flags the intent row so the mismatch is visible after the fact', async () => {
    await seed();
    const gateway = new StubGateway();

    await execute(request({ amount_paise: 49900 }), { gateway, dryRun: false });
    await execute(request({ amount_paise: 79900 }), { gateway, dryRun: false });

    const { rows } = await query<{ amount_mismatch: boolean; last_error: string }>(
      `SELECT amount_mismatch, last_error FROM execution_intent WHERE subscription_id = $1`,
      [SUB],
    );
    expect(rows[0]!.amount_mismatch).toBe(true);
    expect(rows[0]!.last_error).toContain('79900');
  });

  it('still treats an identical amount as an ordinary duplicate', async () => {
    await seed();
    const gateway = new StubGateway();

    await execute(request(), { gateway, dryRun: false });
    expect((await execute(request(), { gateway, dryRun: false })).status).toBe('duplicate');
  });
});
