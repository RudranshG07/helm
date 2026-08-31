import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatProposalClient, PROVIDER_PRESETS } from './agent-openai.ts';
import type { MandateContext } from './agent.ts';

const REAL_FETCH = globalThis.fetch;
afterEach(() => { globalThis.fetch = REAL_FETCH; });

const ctx: MandateContext = {
  subscription_id: 'sub_1',
  bucket: 'SOFT_LIQUIDITY',
  method: 'upi_autopay',
  issuer: 'HDFC',
  amount_paise: 49900,
  attempts_remaining: 2,
  days_to_halt: 3,
  consecutive_failures: 1,
  last_failure_at: '2026-08-27T06:00:00.000Z',
  now: '2026-08-27T09:00:00.000Z',
  liquidity_tier: 'population',
  liquidity_confidence: 0.2,
  reauth_available: false,
} as unknown as MandateContext;

function reply(content: string, status = 200) {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ choices: [{ message: { content } }] }), { status },
  )) as typeof fetch;
}

const client = () => new OpenAICompatProposalClient({
  baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'test-model',
});

const GOOD = JSON.stringify({
  action: 'RETRY_SCHEDULED',
  scheduled_for: '2026-08-28T14:30:00+05:30',
  reason: 'Retry outside the contested window.',
  confidence: 0.7,
});

describe('any OpenAI-compatible provider can drive the agent', () => {
  it('accepts a well-formed proposal', async () => {
    reply(GOOD);
    const out = await client().propose(ctx);
    expect(out.ok).toBe(true);
    expect(out.ok && out.proposal.action).toBe('RETRY_SCHEDULED');
  });

  it('recovers a proposal wrapped in a markdown fence', async () => {
    reply('```json\n' + GOOD + '\n```');
    const out = await client().propose(ctx);
    expect(out.ok).toBe(true);
  });

  it('recovers a proposal with chatter around it', async () => {
    reply(`Sure! Here is my answer:\n${GOOD}\nHope that helps.`);
    const out = await client().propose(ctx);
    expect(out.ok).toBe(true);
  });

  it('rejects an action outside the allowed set rather than passing it through', async () => {
    reply(JSON.stringify({ action: 'CHARGE_EVERYTHING', reason: 'x', confidence: 1 }));
    const out = await client().propose(ctx);
    expect(out.ok).toBe(false);
  });

  it('rejects a response that is not JSON at all', async () => {
    reply('I cannot help with that.');
    const out = await client().propose(ctx);
    expect(out.ok).toBe(false);
  });

  it('reports an http failure instead of throwing', async () => {
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    const out = await client().propose(ctx);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain('429');
  });

  it('reports a network failure instead of throwing', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const out = await client().propose(ctx);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain('ECONNREFUSED');
  });

  it('reports a provider error body instead of pretending it succeeded', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 200 },
    )) as typeof fetch;
    const out = await client().propose(ctx);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain('quota');
  });

  it('names the model it used so a decision can be traced to it', async () => {
    reply(GOOD);
    const out = await client().propose(ctx);
    expect(out.model).toBe('test-model');
  });
});

describe('the free provider presets are usable as shipped', () => {
  it('offers at least one zero-cost option', () => {
    expect(Object.values(PROVIDER_PRESETS).some((p) => p.free)).toBe(true);
  });

  it('gives every preset a base url, a model and a key variable', () => {
    for (const [name, p] of Object.entries(PROVIDER_PRESETS)) {
      expect(p.baseUrl, name).toMatch(/^https?:\/\//);
      expect(p.model, name).toBeTruthy();
      expect(p.keyEnv, name).toMatch(/^[A-Z_]+$/);
    }
  });

  it('keeps a local option that needs no account at all', () => {
    expect(PROVIDER_PRESETS['ollama']!.baseUrl).toContain('127.0.0.1');
  });
});
