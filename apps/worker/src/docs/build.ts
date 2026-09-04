import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_RULE_IDS, NPCI_ATTEMPT_BUDGET, PEAK_WINDOWS, TAXONOMY_VERSION } from '@mandate/core';
import { SCENARIOS } from '../adversarial/catalog.ts';

const here = dirname(fileURLToPath(import.meta.url));
const coreSrc = join(here, '../../../../packages/core/src');

export interface RuleDoc {
  id: string;
  refusals: string[];
  phase: 'both' | 'proposal';
}

export interface TaxonomyDoc {
  reason: string;
  bucket: string;
  confidence: string;
  verified: boolean;
}

export interface ScenarioGroup {
  category: string;
  total: number;
  handled: number;
  detected: number;
  unhandled: number;
}

export interface Docs {
  generated_at: string;
  taxonomy_version: string;
  attempt_budget: number;
  peak_windows: string[];
  actions: string[];
  rules: RuleDoc[];
  taxonomy: TaxonomyDoc[];
  scenarios: { total: number; handled: number; detected: number; unhandled: number; groups: ScenarioGroup[] };
  open_gaps: { id: string; title: string; note: string | null }[];
}

function read(file: string): string {
  return readFileSync(join(coreSrc, file), 'utf8');
}

function minutesToClock(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function buildDocs(): Docs {
  const policy = read('policy.ts');
  const taxonomySrc = read('taxonomy.ts');
  const types = read('types.ts');

  const refusals = new Map<string, string[]>();
  for (const m of policy.matchAll(/deny\(\s*'(R-[A-Z]+)',\s*(?:`([^`]*)`|'([^']*)')/g)) {
    const id = m[1]!;
    const text = (m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, 'that value').trim();
    if (!text) continue;
    const list = refusals.get(id) ?? [];
    if (!list.includes(text)) list.push(text);
    refusals.set(id, list);
  }

  const timingRules = new Set(['R-PDN', 'R-WINDOW', 'R-DEGRADED']);
  const rules: RuleDoc[] = ALL_RULE_IDS
    .filter((id) => id !== 'R-OK')
    .map((id) => ({
      id,
      refusals: refusals.get(id) ?? [],
      phase: timingRules.has(id) ? 'proposal' : 'both',
    }));

  const taxonomy: TaxonomyDoc[] = [];
  const mapBlock = /const REASON_MAP[^{]*\{([\s\S]*?)\n\};/.exec(taxonomySrc);
  if (mapBlock) {
    for (const line of mapBlock[1]!.split('\n')) {
      const m = /^\s*([a-z_]+):\s*\{\s*bucket:\s*'([A-Z_]+)',\s*confidence:\s*'([a-z]+)',\s*verified:\s*(true|false)/.exec(line);
      if (m) {
        taxonomy.push({ reason: m[1]!, bucket: m[2]!, confidence: m[3]!, verified: m[4] === 'true' });
      }
    }
  }

  const actionsMatch = /export type Action =([^;]+);/.exec(types);
  const actions = actionsMatch
    ? Array.from(actionsMatch[1]!.matchAll(/'([A-Z_]+)'/g)).map((m) => m[1]!)
    : [];

  const byCategory = new Map<string, ScenarioGroup>();
  for (const s of SCENARIOS) {
    const g = byCategory.get(s.category) ?? {
      category: s.category, total: 0, handled: 0, detected: 0, unhandled: 0,
    };
    g.total += 1;
    if (s.outcome === 'HANDLED') g.handled += 1;
    else if (s.outcome === 'DETECTED') g.detected += 1;
    else g.unhandled += 1;
    byCategory.set(s.category, g);
  }

  return {
    generated_at: new Date().toISOString(),
    taxonomy_version: TAXONOMY_VERSION,
    attempt_budget: NPCI_ATTEMPT_BUDGET,
    peak_windows: PEAK_WINDOWS.map(([a, b]) => `${minutesToClock(a)}–${minutesToClock(b)} IST`),
    actions,
    rules,
    taxonomy,
    scenarios: {
      total: SCENARIOS.length,
      handled: SCENARIOS.filter((s) => s.outcome === 'HANDLED').length,
      detected: SCENARIOS.filter((s) => s.outcome === 'DETECTED').length,
      unhandled: SCENARIOS.filter((s) => s.outcome === 'UNHANDLED').length,
      groups: [...byCategory.values()].sort((a, b) => b.total - a.total),
    },
    open_gaps: SCENARIOS
      .filter((s) => s.outcome === 'UNHANDLED')
      .map((s) => ({ id: s.id, title: s.title, note: s.note ?? null })),
  };
}
