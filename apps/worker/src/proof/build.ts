import { TAXONOMY_VERSION } from '@mandate/core';
import { query } from '@mandate/db';
import { armTotals } from '../arms.ts';
import type { ArmTotals } from '../arms.ts';
import { buildDecisionTrace } from '../trace/decision.ts';
import type { DecisionTrace } from '../trace/decision.ts';
import { SCENARIOS } from '../adversarial/catalog.ts';

export interface ProofScale {
  merchants: number;
  mandates: number;
  attempts: number;
  decisions: number;
  executions: number;
  outreach: number;
  promises: number;
}

export interface ProofHonesty {
  taxonomy_version: string;
  unmapped_attempts: number;
  unmapped_share: number;
  scenarios: number;
  handled: number;
  detected: number;
  unhandled: number;
  open_gaps: { id: string; title: string; note: string | null }[];
  money_is_simulated: boolean;
}

export interface ProofOutreach {
  funnel: Record<string, number>;
  languages: Record<string, number>;
  promises_open: number;
  promises_kept: number;
  promises_broken: number;
}

export interface Proof {
  generated_at: string;
  scale: ProofScale;
  arms: ArmTotals[];
  edge_per_attempt_pct: number | null;
  allowed_trace: DecisionTrace | null;
  refused_trace: DecisionTrace | null;
  outreach: ProofOutreach;
  honesty: ProofHonesty;
}

async function one<T extends Record<string, unknown>>(sql: string): Promise<T | undefined> {
  const { rows } = await query<T>(sql);
  return rows[0];
}

async function pickTrace(sql: string): Promise<DecisionTrace | null> {
  const row = await one<{ id: string }>(sql);
  return row ? buildDecisionTrace(row.id) : null;
}

export async function buildProof(): Promise<Proof> {
  const scale = await one<Record<string, string>>(`
    SELECT (SELECT count(*) FROM merchant)::text AS merchants,
           (SELECT count(*) FROM subscription)::text AS mandates,
           (SELECT count(*) FROM payment_attempt)::text AS attempts,
           (SELECT count(*) FROM decision)::text AS decisions,
           (SELECT count(*) FROM execution_intent)::text AS executions,
           (SELECT count(*) FROM outreach)::text AS outreach,
           (SELECT count(*) FROM promise_to_pay)::text AS promises`);

  const arms = await armTotals();
  const perAttempt = (a?: ArmTotals) => {
    if (!a) return null;
    const n = a.attempts_by_us + a.attempts_by_default;
    return n > 0 ? a.amount_recovered_paise / n : null;
  };
  const c = perAttempt(arms.find((a) => a.arm === 'control'));
  const t = perAttempt(arms.find((a) => a.arm === 'treatment'));
  const edge = c !== null && t !== null && c > 0 ? ((t - c) / c) * 100 : null;

  const allowed = await pickTrace(`
    SELECT d.id::text AS id FROM decision d
     WHERE d.verdict = 'ALLOW'
       AND d.proposed_action = 'RETRY_SCHEDULED'
       AND d.scheduled_for IS NOT NULL
       AND d.agent_context IS NOT NULL
       AND EXISTS (SELECT 1 FROM payment_attempt pa
                    WHERE pa.subscription_id = d.subscription_id
                      AND pa.cycle = d.cycle AND pa.status = 'failed')
     ORDER BY (d.outcome = 'recovered') DESC NULLS LAST, d.id DESC
     LIMIT 1`);

  const refused = await pickTrace(`
    SELECT d.id::text AS id FROM decision d
     WHERE d.verdict = 'DENY'
       AND d.agent_context IS NOT NULL
       AND EXISTS (SELECT 1 FROM payment_attempt pa
                    WHERE pa.subscription_id = d.subscription_id
                      AND pa.cycle = d.cycle AND pa.status = 'failed')
     ORDER BY (d.rule_id = 'R-HARD') DESC, d.id DESC
     LIMIT 1`);

  const { rows: funnelRows } = await query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM outreach GROUP BY status`);
  const { rows: langRows } = await query<{ language: string; n: number }>(
    `SELECT language, count(*)::int AS n FROM outreach GROUP BY language`);
  const promises = await one<Record<string, string>>(`
    SELECT count(*) FILTER (WHERE status='open')::text AS open,
           count(*) FILTER (WHERE status='kept')::text AS kept,
           count(*) FILTER (WHERE status='broken')::text AS broken
      FROM promise_to_pay`);

  const unmapped = await one<{ unmapped: string; total: string }>(`
    SELECT count(*) FILTER (WHERE COALESCE(bucket,'UNKNOWN') = 'UNKNOWN')::text AS unmapped,
           count(*)::text AS total
      FROM payment_attempt WHERE status = 'failed'`);

  const gaps = SCENARIOS.filter((s) => s.outcome === 'UNHANDLED');
  const total = Number(unmapped?.total ?? 0);

  return {
    generated_at: new Date().toISOString(),
    scale: {
      merchants: Number(scale?.['merchants'] ?? 0),
      mandates: Number(scale?.['mandates'] ?? 0),
      attempts: Number(scale?.['attempts'] ?? 0),
      decisions: Number(scale?.['decisions'] ?? 0),
      executions: Number(scale?.['executions'] ?? 0),
      outreach: Number(scale?.['outreach'] ?? 0),
      promises: Number(scale?.['promises'] ?? 0),
    },
    arms,
    edge_per_attempt_pct: edge,
    allowed_trace: allowed,
    refused_trace: refused,
    outreach: {
      funnel: Object.fromEntries(funnelRows.map((r) => [r.status, r.n])),
      languages: Object.fromEntries(langRows.map((r) => [r.language, r.n])),
      promises_open: Number(promises?.['open'] ?? 0),
      promises_kept: Number(promises?.['kept'] ?? 0),
      promises_broken: Number(promises?.['broken'] ?? 0),
    },
    honesty: {
      taxonomy_version: TAXONOMY_VERSION,
      unmapped_attempts: Number(unmapped?.unmapped ?? 0),
      unmapped_share: total > 0 ? Number(unmapped?.unmapped ?? 0) / total : 0,
      scenarios: SCENARIOS.length,
      handled: SCENARIOS.filter((s) => s.outcome === 'HANDLED').length,
      detected: SCENARIOS.filter((s) => s.outcome === 'DETECTED').length,
      unhandled: gaps.length,
      open_gaps: gaps.map((g) => ({ id: g.id, title: g.title, note: g.note ?? null })),
      money_is_simulated: true,
    },
  };
}
