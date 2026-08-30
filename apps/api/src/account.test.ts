import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeAccount } from './account.ts';

const REAL_FETCH = globalThis.fetch;

function stub(methods: unknown, prefs: unknown) {
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    const body = href.includes('/preferences') ? prefs : methods;
    if (body === null) return new Response('nope', { status: 500 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

afterEach(() => { globalThis.fetch = REAL_FETCH; vi.restoreAllMocks(); });

const ACTIVE_UPI = {
  card: true, upi: true, nach: true,
  recurring: { card: true, upi: true, emandate: { HDFC: {}, ICIC: {} }, nach: true },
};

describe('the account probe reports what the account can do, not what it advertises', () => {
  it('refuses to claim readiness without a key', async () => {
    const result = await probeAccount(undefined);
    expect(result.probed).toBe(false);
    expect(result.verdict).toBe('blocked');
  });

  it('reports blocked, not ready, when Razorpay cannot be reached', async () => {
    stub(null, null);
    const result = await probeAccount('rzp_test_x');
    expect(result.probed).toBe(false);
    expect(result.verdict).toBe('blocked');
  });

  it('calls an unactivated account blocked even when every rail is provisioned', async () => {
    stub(ACTIVE_UPI, { activated: false });
    const result = await probeAccount('rzp_test_x');
    expect(result.verdict).toBe('blocked');
    expect(result.usable).toEqual([]);
    expect(result.summary).toContain('activation');
  });

  it('marks UPI disabled rather than merely unprovisioned when UPI itself is off', async () => {
    stub({ card: true, upi: false, recurring: { card: true } }, { activated: true });
    const result = await probeAccount('rzp_test_x');
    const upi = result.rails.find((r) => r.rail === 'upi_autopay');
    expect(upi?.status).toBe('disabled');
  });

  it('separates UPI being on from Autopay being provisioned', async () => {
    stub({ card: true, upi: true, recurring: { card: true } }, { activated: true });
    const result = await probeAccount('rzp_test_x');
    const upi = result.rails.find((r) => r.rail === 'upi_autopay');
    expect(upi?.status).toBe('not_provisioned');
  });

  it('counts the eMandate banks it found', async () => {
    stub(ACTIVE_UPI, { activated: true });
    const result = await probeAccount('rzp_test_x');
    const em = result.rails.find((r) => r.rail === 'emandate');
    expect(em?.status).toBe('usable');
    expect(em?.detail).toContain('2 banks');
  });

  it('reports live_ready only when a rail can actually take a mandate', async () => {
    stub(ACTIVE_UPI, { activated: true });
    const result = await probeAccount('rzp_test_x');
    expect(result.verdict).toBe('live_ready');
    expect(result.usable.length).toBeGreaterThan(0);
  });

  it('never reports a rail as usable on an unactivated account', async () => {
    stub(ACTIVE_UPI, { activated: false });
    const result = await probeAccount('rzp_test_x');
    expect(result.rails.every((r) => r.status !== 'usable')).toBe(true);
  });
});
