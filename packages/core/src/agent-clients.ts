import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { PROMPT_VERSION, SYSTEM_PROMPT, buildPrompt, validateProposal } from './agent.ts';
import type { MandateContext, ProposalClient, ProposalOutcome } from './agent.ts';
import type { Proposal } from './types.ts';

const ProposalSchema = z.object({
  action: z.enum(['RETRY_SCHEDULED', 'HOLD', 'REAUTH_OUTREACH', 'STOP']),
  scheduled_for: z
    .string()
    .nullable()
    .describe('ISO 8601 with offset. Required for RETRY_SCHEDULED, null otherwise.'),
  reason: z.string().describe('One plain sentence for the merchant.'),
  confidence: z.number().min(0).max(1),
});

export const AGENT_MODEL = 'claude-haiku-4-5-20251001';

export class AnthropicProposalClient implements ProposalClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: { client?: Anthropic; model?: string } = {}) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? AGENT_MODEL;
  }

  async propose(ctx: MandateContext): Promise<ProposalOutcome> {
    const meta = { model: this.model, prompt_version: PROMPT_VERSION };

    let raw: unknown;
    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        output_config: { format: zodOutputFormat(ProposalSchema) },
        messages: [{ role: 'user', content: buildPrompt(ctx) }],
      });

      if (response.stop_reason === 'refusal') {
        return { ok: false, error: 'model refused the request', raw: response.stop_details, ...meta };
      }

      raw = response.parsed_output ?? null;
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        return { ok: false, error: `api error ${err.status}: ${err.message}`, raw: null, ...meta };
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err), raw: null, ...meta };
    }

    if (raw && typeof raw === 'object' && (raw as Record<string, unknown>)['scheduled_for'] === null) {
      delete (raw as Record<string, unknown>)['scheduled_for'];
    }

    const validated = validateProposal(raw, ctx.subscription_id);
    return validated.ok
      ? { ok: true, proposal: validated.proposal, raw, ...meta }
      : { ok: false, error: validated.error, raw, ...meta };
  }
}

export class MockProposalClient implements ProposalClient {
  private readonly responses: Map<string, unknown>;
  private readonly fallback: unknown;
  public readonly calls: MandateContext[] = [];

  constructor(options: { responses?: Record<string, unknown>; fallback?: unknown } = {}) {
    this.responses = new Map(Object.entries(options.responses ?? {}));
    this.fallback = options.fallback ?? {
      action: 'HOLD',
      reason: 'Mock client default.',
      confidence: 0.5,
    };
  }

  async propose(ctx: MandateContext): Promise<ProposalOutcome> {
    this.calls.push(ctx);
    const raw = this.responses.get(ctx.subscription_id) ?? this.fallback;
    const meta = { model: 'mock', prompt_version: PROMPT_VERSION };
    const validated = validateProposal(raw, ctx.subscription_id);
    return validated.ok
      ? { ok: true, proposal: validated.proposal, raw, ...meta }
      : { ok: false, error: validated.error, raw, ...meta };
  }
}

export interface RecordedProposal {
  context_hash: string;
  raw: unknown;
  model: string;
  prompt_version: string;
}

export function hashContext(ctx: MandateContext): string {
  const canonical = JSON.stringify(ctx, Object.keys(ctx).sort());
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i += 1) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

export class RecordedProposalClient implements ProposalClient {
  private readonly byHash: Map<string, RecordedProposal>;

  constructor(records: RecordedProposal[]) {
    this.byHash = new Map(records.map((r) => [r.context_hash, r]));
  }

  async propose(ctx: MandateContext): Promise<ProposalOutcome> {
    const hash = hashContext(ctx);
    const record = this.byHash.get(hash);

    if (!record) {
      return {
        ok: false,
        error: `no recorded proposal for context ${hash}`,
        raw: null,
        model: 'recorded',
        prompt_version: PROMPT_VERSION,
      };
    }

    const meta = { model: record.model, prompt_version: record.prompt_version };
    const validated = validateProposal(record.raw, ctx.subscription_id);
    return validated.ok
      ? { ok: true, proposal: validated.proposal, raw: record.raw, ...meta }
      : { ok: false, error: validated.error, raw: record.raw, ...meta };
  }
}

export function deferredVerdictFor(outcome: Extract<ProposalOutcome, { ok: false }>): {
  proposal: Proposal;
} {
  return {
    proposal: {
      subscription_id: '',
      action: 'HOLD',
      reason: `Proposal could not be validated: ${outcome.error}`,
      confidence: 0,
    },
  };
}
