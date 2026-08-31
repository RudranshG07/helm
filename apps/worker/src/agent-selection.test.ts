import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeProposalClient } from './decide.ts';

const KEYS = [
  'AGENT_PROVIDER', 'AGENT_BASE_URL', 'AGENT_MODEL', 'AGENT_API_KEY',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY',
  'CEREBRAS_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_NO_KEY',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const nameOf = (c: unknown) => c!.constructor.name;

describe('a misplaced key must never silently break every decision', () => {
  it('ignores an ANTHROPIC_API_KEY that is not an Anthropic key', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-proj-thisIsAnOpenAIKey';
    expect(nameOf(makeProposalClient())).toBe('MockProposalClient');
  });

  it('falls through to a working provider instead of failing on the misplaced key', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-proj-thisIsAnOpenAIKey';
    process.env['GROQ_API_KEY'] = 'gsk_realgroqkey';
    expect(nameOf(makeProposalClient())).toBe('OpenAICompatProposalClient');
  });

  it('accepts a correctly shaped Anthropic key', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-api03-real';
    expect(nameOf(makeProposalClient())).toBe('AnthropicProposalClient');
  });

  it('ignores a GROQ key that is not a groq key', () => {
    process.env['GROQ_API_KEY'] = 'sk-proj-wrong';
    expect(nameOf(makeProposalClient())).toBe('MockProposalClient');
  });

  it('accepts a Gemini key, which has no fixed prefix', () => {
    process.env['GEMINI_API_KEY'] = 'AIzaSyExampleKeyValue';
    expect(nameOf(makeProposalClient())).toBe('OpenAICompatProposalClient');
  });

  it('ignores an empty key rather than selecting a dead provider', () => {
    process.env['GEMINI_API_KEY'] = '   ';
    expect(nameOf(makeProposalClient())).toBe('MockProposalClient');
  });
});

describe('the provider can be chosen explicitly', () => {
  it('honours AGENT_PROVIDER=mock even when keys exist', () => {
    process.env['AGENT_PROVIDER'] = 'mock';
    process.env['GROQ_API_KEY'] = 'gsk_real';
    expect(nameOf(makeProposalClient())).toBe('MockProposalClient');
  });

  it('runs locally with no key at all when asked', () => {
    process.env['AGENT_PROVIDER'] = 'ollama';
    expect(nameOf(makeProposalClient())).toBe('OpenAICompatProposalClient');
  });

  it('falls back to the deterministic mock when nothing is configured', () => {
    expect(nameOf(makeProposalClient())).toBe('MockProposalClient');
  });

  it('accepts a bare custom endpoint', () => {
    process.env['AGENT_BASE_URL'] = 'http://127.0.0.1:9999/v1';
    expect(nameOf(makeProposalClient())).toBe('OpenAICompatProposalClient');
  });
});
