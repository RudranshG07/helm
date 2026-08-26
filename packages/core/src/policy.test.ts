import { afterAll, describe, expect, it } from 'vitest';
import { ALL_RULE_IDS, AFA_THRESHOLD_PAISE, evaluate } from './policy.ts';
import { fromIst, isPeak, snapOutOfPeak, toIstParts, PEAK_WINDOWS } from './time.ts';
import type { PolicyContext, Proposal } from './types.ts';

/** 2026-09-01 08:00 IST — a non-peak morning, used as the fixed "now" everywhere. */
const NOW = fromIst(2026, 8, 1, 8 * 60);
/** 48h later at 08:00 IST: clears the PDN floor and sits outside every peak window. */
const LEGAL_TARGET = fromIst(2026, 8, 3, 8 * 60);

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    now: NOW,
    kill_switch: false,
    write_enabled: true,
    subscription_status: 'pending',
    method: 'upi_autopay',
    amount_paise: 49900,
    cycle: fromIst(2026, 8, 1, 0),
    mandate_expiry_at: fromIst(2027, 0, 1, 0),
    cycle_already_paid: false,
    consecutive_soft_cycles: 0,
    max_soft_cycles: 3,
    attempts_remaining: 2,
    attempt_number: 2,
    last_bucket: 'SOFT_LIQUIDITY',
    attempt_exists: false,
    attempt_in_flight: false,
    issuer_degraded: false,
    contacts_this_cycle: 0,
    max_contacts_per_cycle: 1,
    blast_attempts_used: 0,
    blast_attempts_max: 50,
    ...over,
  };
}

function retry(at: Date = LEGAL_TARGET): Proposal {
  return {
    subscription_id: 'sub_1',
    action: 'RETRY_SCHEDULED',
    scheduled_for: at.toISOString(),
    reason: 'Insufficient funds; prior successes cluster on the 1st-3rd.',
    confidence: 0.72,
  };
}

const fired = new Set<string>();
function ev(p: Proposal, c: PolicyContext) {
  const v = evaluate(p, c);
  fired.add(v.rule_id);
  return v;
}

describe('the happy path', () => {
  it('allows a legal, well-timed retry', () => {
    const v = ev(retry(), ctx());
    expect(v.verdict).toBe('ALLOW');
    expect(v.rule_id).toBe('R-OK');
    expect(v.scheduled_for).toBe(LEGAL_TARGET.toISOString());
  });
});

describe('R-KILL', () => {
  it('denies when the kill switch is engaged', () => {
    expect(ev(retry(), ctx({ kill_switch: true })).rule_id).toBe('R-KILL');
  });
  it('allows the identical proposal when it is not', () => {
    expect(ev(retry(), ctx({ kill_switch: false })).verdict).toBe('ALLOW');
  });
  it('outranks every other rule', () => {
    const v = ev(retry(), ctx({
      kill_switch: true, write_enabled: false,
      subscription_status: 'halted', attempts_remaining: 0, last_bucket: 'HARD_CUSTOMER',
    }));
    expect(v.rule_id).toBe('R-KILL');
  });
});

describe('R-CONSENT', () => {
  it('denies a retry without write access', () => {
    expect(ev(retry(), ctx({ write_enabled: false })).rule_id).toBe('R-CONSENT');
  });
  it('denies outreach without write access', () => {
    const p: Proposal = { subscription_id: 's', action: 'REAUTH_OUTREACH', reason: 'r', confidence: 0.5 };
    expect(ev(p, ctx({ write_enabled: false })).rule_id).toBe('R-CONSENT');
  });
  it('still allows HOLD, which touches nothing external', () => {
    const p: Proposal = { subscription_id: 's', action: 'HOLD', reason: 'r', confidence: 0.5 };
    expect(ev(p, ctx({ write_enabled: false })).verdict).toBe('ALLOW');
  });
});

describe('R-HALT', () => {
  it.each(['halted', 'cancelled', 'completed', 'expired'])('denies when status is %s', (status) => {
    expect(ev(retry(), ctx({ subscription_status: status })).rule_id).toBe('R-HALT');
  });
  it('allows when pending', () => {
    expect(ev(retry(), ctx({ subscription_status: 'pending' })).verdict).toBe('ALLOW');
  });
});

describe('R-EXPIRY', () => {
  it('denies an already-expired mandate', () => {
    expect(ev(retry(), ctx({ mandate_expiry_at: fromIst(2026, 7, 1, 0) })).rule_id).toBe('R-EXPIRY');
  });
  it('denies when the mandate expires before the proposed attempt', () => {
    const expiry = new Date(LEGAL_TARGET.getTime() - 60_000);
    expect(ev(retry(), ctx({ mandate_expiry_at: expiry })).rule_id).toBe('R-EXPIRY');
  });
  it('boundary: expiry exactly at the attempt time is a deny', () => {
    expect(ev(retry(), ctx({ mandate_expiry_at: LEGAL_TARGET })).rule_id).toBe('R-EXPIRY');
  });
  it('boundary: expiry one second after the attempt time is allowed', () => {
    const expiry = new Date(LEGAL_TARGET.getTime() + 1000);
    expect(ev(retry(), ctx({ mandate_expiry_at: expiry })).verdict).toBe('ALLOW');
  });
});

describe('R-HARD', () => {
  it.each(['HARD_INSTRUMENT', 'HARD_CUSTOMER'] as const)('denies a retry after %s', (b) => {
    expect(ev(retry(), ctx({ last_bucket: b })).rule_id).toBe('R-HARD');
  });
  it('allows re-auth outreach after HARD_INSTRUMENT: a fresh mandate is the only thing that works', () => {
    const p: Proposal = { subscription_id: 's', action: 'REAUTH_OUTREACH', reason: 'r', confidence: 0.6 };
    expect(ev(p, ctx({ last_bucket: 'HARD_INSTRUMENT' })).verdict).toBe('ALLOW');
  });
  it('denies outreach after HARD_CUSTOMER: they already said no', () => {
    const p: Proposal = { subscription_id: 's', action: 'REAUTH_OUTREACH', reason: 'r', confidence: 0.6 };
    expect(ev(p, ctx({ last_bucket: 'HARD_CUSTOMER' })).rule_id).toBe('R-HARD');
  });
  it('allows a retry on UNKNOWN, which earns one conservative attempt', () => {
    expect(ev(retry(), ctx({ last_bucket: 'UNKNOWN' })).verdict).toBe('ALLOW');
  });
});

describe('R-METHOD', () => {
  it('denies a retry on a domestic card, which cannot be manually charged', () => {
    expect(ev(retry(), ctx({ method: 'card' })).rule_id).toBe('R-METHOD');
  });
  it('allows emandate', () => {
    expect(ev(retry(), ctx({ method: 'emandate' })).verdict).toBe('ALLOW');
  });
  it('denies above the AFA threshold, where no silent retry exists', () => {
    expect(ev(retry(), ctx({ amount_paise: AFA_THRESHOLD_PAISE + 1 })).rule_id).toBe('R-METHOD');
  });
  it('boundary: exactly at the AFA threshold is allowed', () => {
    expect(ev(retry(), ctx({ amount_paise: AFA_THRESHOLD_PAISE })).verdict).toBe('ALLOW');
  });
});

describe('R-BUDGET', () => {
  it('denies with no attempts remaining', () => {
    expect(ev(retry(), ctx({ attempts_remaining: 0 })).rule_id).toBe('R-BUDGET');
  });
  it('boundary: exactly one attempt remaining is allowed', () => {
    expect(ev(retry(), ctx({ attempts_remaining: 1 })).verdict).toBe('ALLOW');
  });
  it('denies on a negative budget, which should be impossible but must not allow', () => {
    expect(ev(retry(), ctx({ attempts_remaining: -1 })).rule_id).toBe('R-BUDGET');
  });
});

describe('R-IDEMPOTENT', () => {
  it('denies when this attempt already exists', () => {
    expect(ev(retry(), ctx({ attempt_exists: true })).rule_id).toBe('R-IDEMPOTENT');
  });
  it('denies while a previous attempt is unsettled', () => {
    expect(ev(retry(), ctx({ attempt_in_flight: true })).rule_id).toBe('R-IDEMPOTENT');
  });
});

describe('R-CONTACT', () => {
  const outreach: Proposal = { subscription_id: 's', action: 'REAUTH_OUTREACH', reason: 'r', confidence: 0.6 };
  it('denies past the contact cap', () => {
    expect(ev(outreach, ctx({ contacts_this_cycle: 1, max_contacts_per_cycle: 1 })).rule_id).toBe('R-CONTACT');
  });
  it('boundary: one below the cap is allowed', () => {
    expect(ev(outreach, ctx({ contacts_this_cycle: 0, max_contacts_per_cycle: 1 })).verdict).toBe('ALLOW');
  });
});

describe('R-PDN — the 24h pre-debit notification floor', () => {
  it('defers a retry proposed sooner than 24h out, and returns an adjusted time', () => {
    const soon = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    const v = ev(retry(soon), ctx());
    expect(v.verdict).toBe('DEFER');
    expect(v.rule_id).toBe('R-PDN');
    expect(new Date(v.scheduled_for!).getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 24 * 3600 * 1000);
    expect(v.proposed_for).toBe(soon.toISOString());
  });

  it('boundary: exactly 24h out is legal', () => {
    const exactly = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    expect(ev(retry(exactly), ctx()).verdict).toBe('ALLOW');
  });

  it('boundary: one second under 24h defers', () => {
    const justUnder = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 - 1000);
    expect(ev(retry(justUnder), ctx()).rule_id).toBe('R-PDN');
  });

  it('pushes to T+2 when enqueued inside the 23:50 IST cutoff for a T+1 debit', () => {
    const lateNow = fromIst(2026, 8, 1, 23 * 60 + 55);      // 23:55 IST
    const nextDay = fromIst(2026, 8, 2, 23 * 60 + 59);      // T+1, and >24h out
    const v = ev(retry(nextDay), ctx({ now: lateNow }));
    expect(v.rule_id).toBe('R-PDN');
    expect(toIstParts(new Date(v.scheduled_for!)).epochDay)
      .toBeGreaterThanOrEqual(toIstParts(lateNow).epochDay + 2);
  });

  it('boundary: 23:49 IST is outside the cutoff', () => {
    const almost = fromIst(2026, 8, 1, 23 * 60 + 49);
    const nextDay = fromIst(2026, 8, 2, 23 * 60 + 59);
    expect(ev(retry(nextDay), ctx({ now: almost })).verdict).toBe('ALLOW');
  });

  it('the adjusted time is never left inside a peak window', () => {
    const n = fromIst(2026, 8, 1, 10 * 60 + 30);
    const v = ev(retry(new Date(n.getTime() + 1000)), ctx({ now: n }));
    expect(v.rule_id).toBe('R-PDN');
    expect(isPeak(new Date(v.scheduled_for!))).toBe(false);
  });
});

describe('R-WINDOW — NPCI peak hours', () => {
  it('defers a retry landing in the morning peak and snaps it forward', () => {
    const peak = fromIst(2026, 8, 3, 11 * 60);
    const v = ev(retry(peak), ctx());
    expect(v.rule_id).toBe('R-WINDOW');
    expect(toIstParts(new Date(v.scheduled_for!)).minuteOfDay).toBe(13 * 60);
    expect(v.proposed_for).toBe(peak.toISOString());
  });

  it('defers a retry landing in the evening peak', () => {
    const peak = fromIst(2026, 8, 3, 19 * 60);
    const v = ev(retry(peak), ctx());
    expect(v.rule_id).toBe('R-WINDOW');
    expect(toIstParts(new Date(v.scheduled_for!)).minuteOfDay).toBe(21 * 60 + 30);
  });

  it.each([
    ['09:59', 9 * 60 + 59, 'ALLOW'],
    ['10:00', 10 * 60, 'DEFER'],
    ['12:59', 12 * 60 + 59, 'DEFER'],
    ['13:00', 13 * 60, 'ALLOW'],
    ['16:59', 16 * 60 + 59, 'ALLOW'],
    ['17:00', 17 * 60, 'DEFER'],
    ['21:29', 21 * 60 + 29, 'DEFER'],
    ['21:30', 21 * 60 + 30, 'ALLOW'],
  ])('boundary %s IST -> %s', (_label, minuteOfDay, expected) => {
    expect(ev(retry(fromIst(2026, 8, 3, minuteOfDay)), ctx()).verdict).toBe(expected);
  });

  it('snapping moves forward, never backward: the credit has already landed', () => {
    const peak = fromIst(2026, 8, 3, 11 * 60);
    const snapped = new Date(ev(retry(peak), ctx()).scheduled_for!);
    expect(snapped.getTime()).toBeGreaterThan(peak.getTime());
  });
});

describe('R-DEGRADED', () => {
  it('defers rather than spending an attempt into a degraded issuer', () => {
    const v = ev(retry(), ctx({ issuer_degraded: true }));
    expect(v.verdict).toBe('DEFER');
    expect(v.rule_id).toBe('R-DEGRADED');
  });
});

describe('R-BLAST', () => {
  it('denies at the blast-radius cap', () => {
    expect(ev(retry(), ctx({ blast_attempts_used: 50, blast_attempts_max: 50 })).rule_id).toBe('R-BLAST');
  });
  it('boundary: one below the cap is allowed', () => {
    expect(ev(retry(), ctx({ blast_attempts_used: 49, blast_attempts_max: 50 })).verdict).toBe('ALLOW');
  });
});

describe('malformed input never allows', () => {
  it('defers a RETRY_SCHEDULED with no scheduled_for', () => {
    const p = { subscription_id: 's', action: 'RETRY_SCHEDULED', reason: 'r', confidence: 0.5 } as Proposal;
    expect(ev(p, ctx()).verdict).toBe('DEFER');
  });
  it('defers an unparseable scheduled_for', () => {
    const p = { ...retry(), scheduled_for: 'not a date' };
    expect(ev(p, ctx()).verdict).toBe('DEFER');
  });
  it('defers a null proposal without throwing', () => {
    expect(evaluate(null as unknown as Proposal, ctx()).verdict).toBe('DEFER');
  });
});

describe('engine-wide invariants', () => {
  it('never ALLOWs a write when consent is off or the kill switch is on', () => {
    const actions: Proposal['action'][] = ['RETRY_SCHEDULED', 'REAUTH_OUTREACH'];
    for (let i = 0; i < 400; i++) {
      const c = ctx({
        kill_switch: i % 2 === 0,
        write_enabled: i % 2 !== 0 ? false : Math.random() > 0.5,
        subscription_status: ['active', 'pending', 'halted'][i % 3]!,
        attempts_remaining: (i % 5) - 1,
        issuer_degraded: i % 7 === 0,
        amount_paise: [1000, 49900, 2_000_000][i % 3]!,
        last_bucket: (['SOFT_LIQUIDITY', 'HARD_INSTRUMENT', 'UNKNOWN', null] as const)[i % 4]!,
      });
      if (!c.kill_switch && c.write_enabled) continue;
      const p: Proposal = { ...retry(), action: actions[i % 2]! };
      expect(evaluate(p, c).verdict).not.toBe('ALLOW');
    }
  });

  it('is total: no context shape throws, and nothing returns undefined', () => {
    const weird: Partial<PolicyContext>[] = [
      { mandate_expiry_at: null },
      { attempts_remaining: Number.NaN },
      { amount_paise: 0 },
      { last_bucket: null },
      { subscription_status: '' },
      { max_contacts_per_cycle: 0 },
    ];
    for (const w of weird) {
      const v = evaluate(retry(), ctx(w));
      expect(v).toBeDefined();
      expect(['ALLOW', 'DENY', 'DEFER']).toContain(v.verdict);
      expect(v.rule_id).toBeTruthy();
      expect(v.explanation).toBeTruthy();
    }
  });

});

describe('time helpers', () => {
  it('PEAK_WINDOWS is the single source of truth and isPeak agrees with it', () => {
    for (const [start, end] of PEAK_WINDOWS) {
      expect(isPeak(fromIst(2026, 8, 3, start))).toBe(true);
      expect(isPeak(fromIst(2026, 8, 3, end - 1))).toBe(true);
      expect(isPeak(fromIst(2026, 8, 3, end))).toBe(false);
      expect(isPeak(fromIst(2026, 8, 3, start - 1))).toBe(false);
    }
  });
  it('snapOutOfPeak leaves an already-legal time alone', () => {
    const legal = fromIst(2026, 8, 3, 14 * 60);
    expect(snapOutOfPeak(legal).getTime()).toBe(legal.getTime());
  });
  it('IST conversion is correct across the UTC midnight boundary', () => {
    const d = fromIst(2026, 8, 3, 2 * 60);
    expect(d.toISOString()).toBe('2026-09-02T20:30:00.000Z');
    expect(toIstParts(d).day).toBe(3);
  });
});

describe('execution phase re-checks what can change, not what is already settled', () => {
  const past = fromIst(2026, 7, 30, 8 * 60);

  it('allows a time already in the past, because the notification lead time was satisfied when it was scheduled', () => {
    const v = ev(retry(past), ctx());
    expect(v.rule_id).toBe('R-PDN');
    const atExecution = evaluate(retry(past), ctx(), { phase: 'execution' });
    expect(atExecution.verdict).toBe('ALLOW');
  });

  it('allows a time inside a peak window at execution, because placement was decided at scheduling', () => {
    const peak = fromIst(2026, 8, 3, 11 * 60);
    expect(ev(retry(peak), ctx()).rule_id).toBe('R-WINDOW');
    expect(evaluate(retry(peak), ctx(), { phase: 'execution' }).verdict).toBe('ALLOW');
  });

  it.each([
    ['R-KILL', { kill_switch: true }],
    ['R-CONSENT', { write_enabled: false }],
    ['R-HALT', { subscription_status: 'halted' }],
    ['R-HARD', { last_bucket: 'HARD_INSTRUMENT' as const }],
    ['R-BUDGET', { attempts_remaining: 0 }],
    ['R-IDEMPOTENT', { attempt_exists: true }],
    ['R-METHOD', { method: 'card' as const }],
  ])('still refuses on %s at execution time', (rule, over) => {
    const v = evaluate(retry(past), ctx(over), { phase: 'execution' });
    expect(v.verdict).not.toBe('ALLOW');
    expect(v.rule_id).toBe(rule);
  });

  it('still refuses an expiry that passed while the attempt was waiting', () => {
    const v = evaluate(retry(past), ctx({ mandate_expiry_at: fromIst(2026, 7, 1, 0) }), { phase: 'execution' });
    expect(v.rule_id).toBe('R-EXPIRY');
  });

  it('still defers on a degraded issuer at execution time', () => {
    const v = evaluate(retry(past), ctx({ issuer_degraded: true }), { phase: 'execution' });
    expect(v.rule_id).toBe('R-DEGRADED');
  });

  it('still refuses past the blast radius cap at execution time', () => {
    const v = evaluate(retry(past), ctx({ blast_attempts_used: 50, blast_attempts_max: 50 }), { phase: 'execution' });
    expect(v.rule_id).toBe('R-BLAST');
  });

  it('defaults to the proposal phase when no option is passed', () => {
    expect(evaluate(retry(past), ctx()).rule_id).toBe('R-PDN');
  });

  it('explains that the check happened at execution time', () => {
    const v = evaluate(retry(past), ctx(), { phase: 'execution' });
    expect(v.explanation).toContain('execution time');
  });
});

describe('R-PAID', () => {
  it('refuses to charge a cycle the customer has already paid', () => {
    expect(ev(retry(), ctx({ cycle_already_paid: true })).rule_id).toBe('R-PAID');
  });

  it('outranks the budget, so a paid cycle is never described as out of attempts', () => {
    const v = ev(retry(), ctx({ cycle_already_paid: true, attempts_remaining: 0 }));
    expect(v.rule_id).toBe('R-PAID');
  });

  it('still refuses at execution time, which is when a manual payment usually lands', () => {
    const past = fromIst(2026, 7, 30, 8 * 60);
    expect(evaluate(retry(past), ctx({ cycle_already_paid: true }), { phase: 'execution' }).rule_id)
      .toBe('R-PAID');
  });

  it('does not block outreach on a paid cycle from being denied for the right reason', () => {
    const p: Proposal = { subscription_id: 's', action: 'REAUTH_OUTREACH', reason: 'r', confidence: 0.5 };
    expect(ev(p, ctx({ cycle_already_paid: true })).rule_id).toBe('R-PAID');
  });
});

describe('R-CHRONIC', () => {
  it('stops retrying a customer whose soft declines repeat across cycles', () => {
    expect(ev(retry(), ctx({ consecutive_soft_cycles: 3, max_soft_cycles: 3 })).rule_id).toBe('R-CHRONIC');
  });

  it('boundary: one cycle below the limit still retries', () => {
    expect(ev(retry(), ctx({ consecutive_soft_cycles: 2, max_soft_cycles: 3 })).verdict).toBe('ALLOW');
  });

  it('still allows re-authorization outreach, which is the remaining path', () => {
    const p: Proposal = { subscription_id: 's', action: 'REAUTH_OUTREACH', reason: 'r', confidence: 0.6 };
    expect(ev(p, ctx({ consecutive_soft_cycles: 5, max_soft_cycles: 3 })).verdict).toBe('ALLOW');
  });

  it('can be switched off by setting the limit to zero', () => {
    expect(ev(retry(), ctx({ consecutive_soft_cycles: 99, max_soft_cycles: 0 })).verdict).toBe('ALLOW');
  });

  it('still refuses at execution time', () => {
    const past = fromIst(2026, 7, 30, 8 * 60);
    expect(evaluate(retry(past), ctx({ consecutive_soft_cycles: 3, max_soft_cycles: 3 }), { phase: 'execution' }).rule_id)
      .toBe('R-CHRONIC');
  });
});

afterAll(() => {
  const missing = ALL_RULE_IDS.filter((r) => !fired.has(r));
  if (missing.length > 0) {
    throw new Error(`rules never exercised by any test: ${missing.join(', ')}`);
  }
});
