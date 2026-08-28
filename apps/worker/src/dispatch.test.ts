import { afterAll, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { dispatchDue } from './dispatch.ts';
import { StubGateway } from './gateway.stub.ts';

const CYCLE = new Date('2026-09-01T00:00:00.000Z');
const MERCHANT = 'merchant_dispatch_test';
const SUB = `${MERCHANT}:sub_dispatch`;

async function seed(opts: {
  status?: string;
  killSwitch?: boolean;
  writeEnabled?: boolean;
  expiry?: Date | null;
  lastBucket?: string | null;
  attemptsInCycle?: number;
} = {}): Promise<number> {
  await query(`DELETE FROM mandate_health WHERE subscription_id = $1`, [SUB]);
  await query(`DELETE FROM execution_intent WHERE subscription_id = $1`, [SUB]);
  await query(`DELETE FROM decision WHERE subscription_id = $1`, [SUB]);
  await query(`DELETE FROM payment_attempt WHERE subscription_id = $1`, [SUB]);
  await query(`DELETE FROM subscription WHERE id = $1`, [SUB]);
  await query(`DELETE FROM merchant WHERE id = $1`, [MERCHANT]);

  await query(`INSERT INTO merchant (id, name, mode, write_enabled) VALUES ($1,$1,'test',$2)`,
    [MERCHANT, opts.writeEnabled ?? true]);
  await query(
    `INSERT INTO subscription (id, merchant_id, rzp_subscription_id, customer_ref, method,
       amount_paise, status, current_start, mandate_expiry_at)
     VALUES ($1,$2,'sub_dispatch','cust_d','upi_autopay',49900,$3,$4,$5)`,
    [SUB, MERCHANT, opts.status ?? 'pending', CYCLE, opts.expiry ?? new Date('2027-01-01T00:00:00Z')],
  );

  for (let i = 0; i < (opts.attemptsInCycle ?? 1); i += 1) {
    await query(
      `INSERT INTO payment_attempt (subscription_id, cycle, attempted_at, status, amount_paise,
         bucket, initiated_by) VALUES ($1,$2,$3,'failed',49900,$4,'razorpay_default')`,
      [SUB, CYCLE, new Date(CYCLE.getTime() + i * 86400000), opts.lastBucket ?? 'SOFT_LIQUIDITY'],
    );
  }

  await query(`UPDATE control_flags SET kill_switch = $1 WHERE id = 1`, [opts.killSwitch ?? false]);

  const { rows } = await query<{ id: number }>(
    `INSERT INTO decision (subscription_id, cycle, proposed_action, proposed_by, verdict,
       rule_id, scheduled_for, rationale, confidence)
     VALUES ($1,$2,'RETRY_SCHEDULED','test','ALLOW','R-OK', now() - interval '1 minute',
             'Prior successes cluster early in the month.', 0.7)
     RETURNING id`,
    [SUB, CYCLE],
  );
  return rows[0]!.id;
}

async function revocation(): Promise<{ rule_id: string; verdict: string; explanation: string } | null> {
  const { rows } = await query<{ rule_id: string; verdict: string; explanation: string }>(
    `SELECT rule_id, verdict, explanation FROM decision
      WHERE subscription_id = $1 AND proposed_by = 'recheck'
      ORDER BY id DESC LIMIT 1`,
    [SUB],
  );
  return rows[0] ?? null;
}

async function originalOutcome(id: number): Promise<string | null> {
  const { rows } = await query<{ outcome: string | null }>(
    `SELECT outcome FROM decision WHERE id = $1`, [id],
  );
  return rows[0]?.outcome ?? null;
}

afterAll(async () => {
  await query(`UPDATE control_flags SET kill_switch = FALSE WHERE id = 1`);
  await close();
});

describe('the policy engine runs again immediately before the charge', () => {
  it('executes when nothing has changed since the decision', async () => {
    await seed();
    const gateway = new StubGateway();
    await dispatchDue(gateway, new Date());
    const { rows } = await query(`SELECT state FROM execution_intent WHERE subscription_id = $1`, [SUB]);
    expect(rows).toHaveLength(1);
  });

  it('refuses when the subscription halted after the decision was made', async () => {
    const id = await seed({ status: 'halted' });
    const gateway = new StubGateway();

    await dispatchDue(gateway, new Date());

    expect(gateway.createCalls).toHaveLength(0);
    expect((await revocation())?.rule_id).toBe('R-HALT');
    expect(await originalOutcome(id)).toBe('revoked');
  });

  it('refuses when the mandate expired after the decision was made', async () => {
    await seed({ expiry: new Date('2026-08-01T00:00:00Z') });
    const gateway = new StubGateway();

    await dispatchDue(gateway, new Date());

    expect(gateway.createCalls).toHaveLength(0);
    expect((await revocation())?.rule_id).toBe('R-EXPIRY');
  });

  it('refuses when the last decline turned hard after the decision was made', async () => {
    await seed({ lastBucket: 'HARD_INSTRUMENT' });
    const gateway = new StubGateway();

    await dispatchDue(gateway, new Date());

    expect(gateway.createCalls).toHaveLength(0);
    expect((await revocation())?.rule_id).toBe('R-HARD');
  });

  it('refuses when write access was revoked after the decision was made', async () => {
    await seed({ writeEnabled: false });
    const gateway = new StubGateway();

    await dispatchDue(gateway, new Date());

    expect(gateway.createCalls).toHaveLength(0);
    expect((await revocation())?.rule_id).toBe('R-CONSENT');
  });

  it('refuses when the kill switch was tripped after the decision was made', async () => {
    await seed({ killSwitch: true });
    const gateway = new StubGateway();

    await dispatchDue(gateway, new Date());

    expect(gateway.createCalls).toHaveLength(0);
    expect((await revocation())?.rule_id).toBe('R-KILL');
  });

  it('refuses when the budget was consumed after the decision was made', async () => {
    await seed({ attemptsInCycle: 4 });
    const gateway = new StubGateway();

    await dispatchDue(gateway, new Date());

    expect(gateway.createCalls).toHaveLength(0);
    expect((await revocation())?.rule_id).toBe('R-BUDGET');
  });

  it('records the revocation as its own decision row, so the trail shows why it stopped', async () => {
    await seed({ status: 'halted' });
    await dispatchDue(new StubGateway(), new Date());

    const rev = await revocation();
    expect(rev?.verdict).toBe('DENY');
    expect(rev?.explanation).toContain('Re-checked before execution');
  });

  it('does not pick up a revoked decision again on the next pass', async () => {
    await seed({ status: 'halted' });
    const gateway = new StubGateway();

    await dispatchDue(gateway, new Date());
    const second = await dispatchDue(gateway, new Date());

    expect(second).toBe(0);
  });
});

describe('bugs the adversarial suite exposed', () => {
  it('refuses to charge a cycle the customer already paid manually', async () => {
    await seed();
    await query(
      `INSERT INTO payment_attempt (subscription_id, cycle, attempted_at, status, amount_paise, initiated_by)
       VALUES ($1,$2, now(), 'captured', 49900, 'razorpay_default')`,
      [SUB, CYCLE],
    );
    const gateway = new StubGateway();

    await dispatchDue(gateway, new Date());

    expect(gateway.createCalls).toHaveLength(0);
    expect((await revocation())?.rule_id).toBe('R-PAID');
  });

  it('does not count our own malformed request against the attempt budget', async () => {
    await seed({ attemptsInCycle: 0 });
    for (let i = 0; i < 4; i += 1) {
      await query(
        `INSERT INTO payment_attempt (subscription_id, cycle, attempted_at, status, amount_paise,
           error_source, initiated_by, counts_against_budget)
         VALUES ($1,$2, now() - ($3::int * interval '1 hour'), 'failed', 49900,
                 'business', 'mandate_rescue', FALSE)`,
        [SUB, CYCLE, i],
      );
    }
    const gateway = new StubGateway();

    await dispatchDue(gateway, new Date());

    expect(await revocation()).toBeNull();
    const { rows } = await query(`SELECT state FROM execution_intent WHERE subscription_id = $1`, [SUB]);
    expect(rows).toHaveLength(1);
  });

  it('does not count backfilled history against a live budget', async () => {
    await seed({ attemptsInCycle: 0 });
    for (let i = 0; i < 4; i += 1) {
      await query(
        `INSERT INTO payment_attempt (subscription_id, cycle, attempted_at, status, amount_paise,
           source, initiated_by, counts_against_budget)
         VALUES ($1,$2, now() - ($3::int * interval '1 hour'), 'failed', 49900,
                 'backfill', 'razorpay_default', FALSE)`,
        [SUB, CYCLE, i],
      );
    }
    await dispatchDue(new StubGateway(), new Date());
    expect(await revocation()).toBeNull();
  });
});

describe('chronic soft declines are counted consecutively, not cumulatively', () => {
  async function softCycle(cycleStart: Date, captured: boolean) {
    await query(
      `INSERT INTO payment_attempt (subscription_id, cycle, attempted_at, status, amount_paise,
         bucket, initiated_by)
       VALUES ($1,$2,$2,$3,49900,'SOFT_LIQUIDITY','razorpay_default')`,
      [SUB, cycleStart, captured ? 'captured' : 'failed'],
    );
  }

  it('does not block a customer whose old failures were followed by successes', async () => {
    await seed({ attemptsInCycle: 0 });
    await softCycle(new Date('2026-01-01T00:00:00Z'), false);
    await softCycle(new Date('2026-02-01T00:00:00Z'), false);
    await softCycle(new Date('2026-03-01T00:00:00Z'), false);
    await softCycle(new Date('2026-04-01T00:00:00Z'), true);
    await softCycle(CYCLE, false);

    await dispatchDue(new StubGateway(), new Date());

    expect(await revocation()).toBeNull();
  });

  it('blocks a customer whose recent cycles are all soft failures', async () => {
    await seed({ attemptsInCycle: 0 });
    await softCycle(new Date('2026-05-01T00:00:00Z'), false);
    await softCycle(new Date('2026-06-01T00:00:00Z'), false);
    await softCycle(new Date('2026-07-01T00:00:00Z'), false);
    await softCycle(CYCLE, false);

    await dispatchDue(new StubGateway(), new Date());

    expect((await revocation())?.rule_id).toBe('R-CHRONIC');
  });
})
