import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { LoggingProvider, UnconfiguredProvider } from './provider.ts';
import { sendOutreach } from './send.ts';

const M = 'merchant_outreach_test';
const S = `${M}:sub_out`;
const CYCLE = new Date('2026-08-20T00:00:00.000Z');
const NOON_IST = new Date('2026-08-27T06:30:00.000Z');
const MIDNIGHT_IST = new Date('2026-08-27T19:00:00.000Z');

async function reset(opts: { email?: string | null; writeEnabled?: boolean } = {}) {
  await query(`DELETE FROM outreach o USING subscription s
                WHERE o.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM subscription WHERE merchant_id = $1`, [M]);
  await query(`DELETE FROM merchant WHERE id = $1`, [M]);
  await query(`UPDATE control_flags SET kill_switch = FALSE WHERE id = 1`);
  await query(
    `INSERT INTO merchant (id, name, mode, write_enabled) VALUES ($1,$1,'test',$2)`,
    [M, opts.writeEnabled ?? true],
  );
  await query(
    `INSERT INTO subscription (id, merchant_id, rzp_subscription_id, customer_ref, method,
       amount_paise, status, current_start, current_end, contact_email)
     VALUES ($1,$2,$1,'Priya','card',149900,'active',$3,$4,$5)`,
    [S, M, CYCLE, new Date(CYCLE.getTime() + 30 * 86_400_000),
     opts.email === undefined ? 'priya@example.com' : opts.email],
  );
}

const req = (decisionId: number | null, now: Date) =>
  ({ decision_id: decisionId, subscription_id: S, cycle: CYCLE, now });

beforeEach(() => reset());
afterAll(async () => {
  await query(`DELETE FROM outreach o USING subscription s
                WHERE o.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM subscription WHERE merchant_id = $1`, [M]);
  await query(`DELETE FROM merchant WHERE id = $1`, [M]);
  await close();
});

describe('outreach reaches a customer at most once', () => {
  it('refuses to contact the same customer twice for the same decision', async () => {
    const p = new LoggingProvider();
    const first = await sendOutreach(req(null, NOON_IST), p);
    const second = await sendOutreach(req(null, NOON_IST), p);
    expect(first.status).not.toBe('duplicate');
    expect(second.status).toBe('duplicate');
  });

  it('writes exactly one outreach row for a repeated send', async () => {
    const p = new LoggingProvider();
    await sendOutreach(req(null, NOON_IST), p);
    await sendOutreach(req(null, NOON_IST), p);
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outreach WHERE subscription_id = $1`, [S]);
    expect(rows[0]!.n).toBe(1);
  });
});

describe('outreach obeys the rules that make contacting people lawful', () => {
  it('will not message during quiet hours', async () => {
    const r = await sendOutreach(req(null, MIDNIGHT_IST), new LoggingProvider());
    expect(r.status).toBe('deferred');
  });

  it('defers to the start of the next permitted window, not an arbitrary delay', async () => {
    const r = await sendOutreach(req(null, MIDNIGHT_IST), new LoggingProvider());
    if (r.status !== 'deferred') throw new Error('expected deferral');
    expect(r.until.toISOString()).toBe('2026-08-28T03:30:00.000Z');
  });

  it('writes nothing at all when it defers', async () => {
    await sendOutreach(req(null, MIDNIGHT_IST), new LoggingProvider());
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outreach WHERE subscription_id = $1`, [S]);
    expect(rows[0]!.n).toBe(0);
  });

  it('never contacts a customer who opted out', async () => {
    await query(`UPDATE subscription SET outreach_opted_out = TRUE WHERE id = $1`, [S]);
    const r = await sendOutreach(req(null, NOON_IST), new LoggingProvider());
    expect(r.status).toBe('blocked');
    expect(r.status === 'blocked' && r.reason).toContain('opted out');
  });

  it('never contacts anyone while the kill switch is engaged', async () => {
    await query(`UPDATE control_flags SET kill_switch = TRUE WHERE id = 1`);
    const r = await sendOutreach(req(null, NOON_IST), new LoggingProvider());
    expect(r.status).toBe('blocked');
    await query(`UPDATE control_flags SET kill_switch = FALSE WHERE id = 1`);
  });

  it('never contacts anyone before the merchant grants write access', async () => {
    await reset({ writeEnabled: false });
    const r = await sendOutreach(req(null, NOON_IST), new LoggingProvider());
    expect(r.status).toBe('blocked');
    expect(r.status === 'blocked' && r.reason).toContain('write access');
  });

  it('stores the recipient masked, never in the clear', async () => {
    await sendOutreach(req(null, NOON_IST), new LoggingProvider());
    const { rows } = await query<{ recipient_masked: string }>(
      `SELECT recipient_masked FROM outreach WHERE subscription_id = $1`, [S]);
    expect(rows[0]!.recipient_masked).not.toContain('priya@example.com');
    expect(rows[0]!.recipient_masked).toContain('@example.com');
  });
});

describe('outreach is honest about whether it actually went out', () => {
  it('does not claim delivery when no provider is configured', async () => {
    const r = await sendOutreach(req(null, NOON_IST), new UnconfiguredProvider());
    expect(r.status).not.toBe('sent');
  });

  it('does not claim delivery when the customer has no contact details', async () => {
    await reset({ email: null });
    const r = await sendOutreach(req(null, NOON_IST), new LoggingProvider());
    expect(r.status).toBe('queued');
    expect(r.status === 'queued' && r.reason).toContain('contact details');
  });

  it('records why an undelivered message was not delivered', async () => {
    await reset({ email: null });
    await sendOutreach(req(null, NOON_IST), new LoggingProvider());
    const { rows } = await query<{ status: string; error: string | null }>(
      `SELECT status, error FROM outreach WHERE subscription_id = $1`, [S]);
    expect(rows[0]!.status).toBe('queued');
    expect(rows[0]!.error).toBeTruthy();
  });

  it('gives every outreach a link that expires', async () => {
    await sendOutreach(req(null, NOON_IST), new LoggingProvider());
    const { rows } = await query<{ expires_at: Date; token: string }>(
      `SELECT expires_at, token FROM outreach WHERE subscription_id = $1`, [S]);
    expect(rows[0]!.token.length).toBeGreaterThan(20);
    expect(new Date(rows[0]!.expires_at).getTime()).toBeGreaterThan(NOON_IST.getTime());
  });

  it('never lets a link outlive the cycle it belongs to', async () => {
    await sendOutreach(req(null, NOON_IST), new LoggingProvider());
    const { rows } = await query<{ expires_at: Date; current_end: Date }>(
      `SELECT o.expires_at, s.current_end FROM outreach o
         JOIN subscription s ON s.id = o.subscription_id WHERE o.subscription_id = $1`, [S]);
    expect(new Date(rows[0]!.expires_at).getTime())
      .toBeLessThanOrEqual(new Date(rows[0]!.current_end).getTime());
  });
});
