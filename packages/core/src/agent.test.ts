import { describe, expect, it } from 'vitest';
import { PROMPT_VERSION, SYSTEM_PROMPT, buildPrompt, validateProposal } from './agent.ts';
import type { MandateContext } from './agent.ts';
import { MockProposalClient, RecordedProposalClient, hashContext } from './agent-clients.ts';

function ctx(over: Partial<MandateContext> = {}): MandateContext {
  return {
    subscription_id: 'sub_1',
    method: 'upi_autopay',
    amount_paise: 49900,
    cycle_start: '2026-09-01T00:00:00.000Z',
    cycle_end: '2026-10-01T00:00:00.000Z',
    mandate_expiry_at: '2027-09-01T00:00:00.000Z',
    days_to_expiry: 365,
    error_code: 'BAD_REQUEST_ERROR',
    error_reason: 'insufficient_funds',
    error_source: 'customer',
    error_step: 'payment_authentication',
    bucket: 'SOFT_LIQUIDITY',
    bucket_confidence: 'high',
    taxonomy_version: '0.1.0-seed',
    risk_band: 'at_risk',
    risk_score: 0.45,
    consecutive_failures: 1,
    attempts_remaining: 3,
    contributions: { consecutive_failures: 0.35 },
    liquidity_window: { preferred_day: 3, window_days: [1, 5], confidence: 0.7, tier: 'own_history' },
    issuer: 'HDFC',
    issuer_degraded: false,
    degradation_source: null,
    successful_payment_days: [1, 2, 3, 2],
    now: '2026-09-05T08:00:00.000Z',
    earliest_legal_slot: '2026-09-06T08:00:00.000Z',
    ...over,
  };
}

const validRetry = {
  action: 'RETRY_SCHEDULED',
  scheduled_for: '2026-10-03T09:00:00+05:30',
  reason: 'The account was short at the time of the charge; the next attempt targets the days this customer has paid successfully before.',
  confidence: 0.72,
};

describe('validateProposal accepts well-formed proposals', () => {
  it('accepts a scheduled retry and carries the subscription id through', () => {
    const result = validateProposal(validRetry, 'sub_9');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.action).toBe('RETRY_SCHEDULED');
      expect(result.proposal.subscription_id).toBe('sub_9');
      expect(result.proposal.scheduled_for).toBe('2026-10-03T09:00:00+05:30');
    }
  });

  it.each(['HOLD', 'REAUTH_OUTREACH', 'STOP'])('accepts %s without scheduled_for', (action) => {
    const result = validateProposal({ action, reason: 'because', confidence: 0.4 }, 'sub_1');
    expect(result.ok).toBe(true);
  });

  it('trims whitespace from the merchant-facing reason', () => {
    const result = validateProposal({ ...validRetry, reason: '  spaced out  ' }, 'sub_1');
    expect(result.ok && result.proposal.reason).toBe('spaced out');
  });
});

describe('validateProposal rejects anything that could become a wrong action', () => {
  const bad: [string, unknown][] = [
    ['null', null],
    ['a string', 'RETRY_SCHEDULED'],
    ['an array', []],
    ['an action outside the enum', { action: 'RETRY_NOW', reason: 'x', confidence: 0.5 }],
    ['a lowercase action', { action: 'hold', reason: 'x', confidence: 0.5 }],
    ['a missing action', { reason: 'x', confidence: 0.5 }],
    ['an empty reason', { action: 'HOLD', reason: '', confidence: 0.5 }],
    ['a whitespace-only reason', { action: 'HOLD', reason: '   ', confidence: 0.5 }],
    ['a missing reason', { action: 'HOLD', confidence: 0.5 }],
    ['a non-numeric confidence', { action: 'HOLD', reason: 'x', confidence: 'high' }],
    ['a confidence above 1', { action: 'HOLD', reason: 'x', confidence: 1.4 }],
    ['a negative confidence', { action: 'HOLD', reason: 'x', confidence: -0.1 }],
    ['a NaN confidence', { action: 'HOLD', reason: 'x', confidence: Number.NaN }],
    ['a retry with no scheduled_for', { action: 'RETRY_SCHEDULED', reason: 'x', confidence: 0.5 }],
    ['a retry with an unparseable time', { ...validRetry, scheduled_for: 'next tuesday' }],
    ['a HOLD carrying scheduled_for', { action: 'HOLD', reason: 'x', confidence: 0.5, scheduled_for: '2026-10-03T09:00:00Z' }],
  ];

  it.each(bad)('rejects %s', (_label, raw) => {
    const result = validateProposal(raw, 'sub_1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it('never throws on hostile input', () => {
    const hostile: unknown[] = [undefined, Symbol('x'), 0, false, () => {}, new Date(), { action: { nested: true } }];
    for (const raw of hostile) {
      expect(() => validateProposal(raw, 'sub_1')).not.toThrow();
      expect(validateProposal(raw, 'sub_1').ok).toBe(false);
    }
  });
});

describe('the prompt', () => {
  it('carries every fact the decision depends on', () => {
    const text = buildPrompt(ctx());
    for (const fragment of [
      'insufficient_funds', 'SOFT_LIQUIDITY', 'attempts_remaining: 3',
      'earliest_legal_slot', 'HDFC', 'own_history',
    ]) {
      expect(text).toContain(fragment);
    }
  });

  it('states when no liquidity window could be inferred rather than omitting it', () => {
    expect(buildPrompt(ctx({ liquidity_window: null }))).toContain('not inferred');
  });

  it('passes the inference tier through so the model can weigh a weak window', () => {
    const text = buildPrompt(ctx({
      liquidity_window: { preferred_day: 1, window_days: [1, 5], confidence: 0.2, tier: 'population_default' },
    }));
    expect(text).toContain('population_default');
  });

  it('does not ask the model to classify the failure itself', () => {
    expect(buildPrompt(ctx())).toContain('classified_as: SOFT_LIQUIDITY');
  });

  it('tells the model the reason is merchant-facing and carries no rupee figure', () => {
    expect(SYSTEM_PROMPT).toContain('shown to the merchant');
    expect(SYSTEM_PROMPT).toContain('never state a rupee figure');
  });

  it('tells the model its confidence authorises nothing', () => {
    expect(SYSTEM_PROMPT).toContain('never to authorise');
  });
});

describe('MockProposalClient', () => {
  it('returns a per-subscription fixture and records the call', async () => {
    const client = new MockProposalClient({ responses: { sub_1: validRetry } });
    const out = await client.propose(ctx());
    expect(out.ok).toBe(true);
    expect(client.calls).toHaveLength(1);
  });

  it('surfaces a fixture that would not validate as a failure, not a throw', async () => {
    const client = new MockProposalClient({ fallback: { action: 'RETRY_NOW' } });
    const out = await client.propose(ctx());
    expect(out.ok).toBe(false);
  });
});

describe('RecordedProposalClient makes a backtest reproducible', () => {
  it('replays a stored proposal for an identical context', async () => {
    const context = ctx();
    const client = new RecordedProposalClient([
      { context_hash: hashContext(context), raw: validRetry, model: 'claude-opus-5', prompt_version: PROMPT_VERSION },
    ]);
    const out = await client.propose(context);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.model).toBe('claude-opus-5');
  });

  it('fails loudly when the context has drifted rather than replaying the wrong answer', async () => {
    const client = new RecordedProposalClient([
      { context_hash: hashContext(ctx()), raw: validRetry, model: 'm', prompt_version: PROMPT_VERSION },
    ]);
    const out = await client.propose(ctx({ attempts_remaining: 1 }));
    expect(out.ok).toBe(false);
  });

  it('hashes identical contexts identically and different ones differently', () => {
    expect(hashContext(ctx())).toBe(hashContext(ctx()));
    expect(hashContext(ctx())).not.toBe(hashContext(ctx({ risk_score: 0.9 })));
  });
});
