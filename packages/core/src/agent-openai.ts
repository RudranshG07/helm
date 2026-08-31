import { PROMPT_VERSION, SYSTEM_PROMPT, buildPrompt, validateProposal } from './agent.ts';
import type { MandateContext, ProposalClient, ProposalOutcome } from './agent.ts';

export interface OpenAICompatOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
}

const SCHEMA_HINT = [
  'Reply with a single JSON object and nothing else. No prose, no code fence.',
  'Shape:',
  '{',
  '  "action": "RETRY_SCHEDULED" | "HOLD" | "REAUTH_OUTREACH" | "STOP",',
  '  "scheduled_for": "ISO 8601 with offset, required for RETRY_SCHEDULED, otherwise null",',
  '  "reason": "one plain sentence for the merchant",',
  '  "confidence": 0.0 to 1.0',
  '}',
].join('\n');

interface ChatResponse {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string } | string;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export class OpenAICompatProposalClient implements ProposalClient {
  private readonly options: OpenAICompatOptions;

  constructor(options: OpenAICompatOptions) {
    this.options = options;
  }

  async propose(ctx: MandateContext): Promise<ProposalOutcome> {
    const meta = { model: this.options.model, prompt_version: PROMPT_VERSION };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);

    let body: ChatResponse;
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.options.model,
          temperature: 0,
          max_tokens: this.options.maxTokens ?? 2048,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: `${SYSTEM_PROMPT}\n\n${SCHEMA_HINT}` },
            { role: 'user', content: buildPrompt(ctx) },
          ],
        }),
      });

      const text = await response.text();
      if (!response.ok) {
        return { ok: false, error: `api error ${response.status}: ${text.slice(0, 200)}`, raw: null, ...meta };
      }
      body = JSON.parse(text) as ChatResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message, raw: null, ...meta };
    } finally {
      clearTimeout(timer);
    }

    if (body.error) {
      const message = typeof body.error === 'string' ? body.error : body.error.message ?? 'provider error';
      return { ok: false, error: message, raw: body.error, ...meta };
    }

    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      return { ok: false, error: 'provider returned no content', raw: body, ...meta };
    }

    const parsed = extractJson(content);
    if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>)['scheduled_for'] === null) {
      delete (parsed as Record<string, unknown>)['scheduled_for'];
    }

    const validated = validateProposal(parsed, ctx.subscription_id);
    return validated.ok
      ? { ok: true, proposal: validated.proposal, raw: parsed, ...meta }
      : { ok: false, error: validated.error, raw: parsed, ...meta };
  }
}

export interface ProviderPreset {
  name: string;
  baseUrl: string;
  model: string;
  keyEnv: string;
  free: boolean;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai: {
    name: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyEnv: 'OPENAI_API_KEY',
    free: false,
  },
  groq: {
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    keyEnv: 'GROQ_API_KEY',
    free: true,
  },
  gemini: {
    name: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.5-flash',
    keyEnv: 'GEMINI_API_KEY',
    free: true,
  },
  cerebras: {
    name: 'cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    model: 'llama-3.3-70b',
    keyEnv: 'CEREBRAS_API_KEY',
    free: true,
  },
  openrouter: {
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    keyEnv: 'OPENROUTER_API_KEY',
    free: true,
  },
  ollama: {
    name: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.1:8b',
    keyEnv: 'OLLAMA_NO_KEY',
    free: true,
  },
};

export const KEY_SHAPES: Record<string, RegExp> = {
  ANTHROPIC_API_KEY: /^sk-ant-/,
  OPENAI_API_KEY: /^sk-/,
  GROQ_API_KEY: /^gsk_/,
  OPENROUTER_API_KEY: /^sk-or-/,
};

export function keyLooksValid(env: string, value: string | undefined): boolean {
  if (!value || value.trim() === '') return false;
  const shape = KEY_SHAPES[env];
  return shape ? shape.test(value.trim()) : true;
}
