import { SCENARIOS, scorecard } from './catalog.ts';
import type { Outcome, Scenario } from './catalog.ts';

function group(scenarios: Scenario[]): Map<string, Scenario[]> {
  const byCategory = new Map<string, Scenario[]>();
  for (const s of scenarios) {
    const list = byCategory.get(s.category) ?? [];
    list.push(s);
    byCategory.set(s.category, list);
  }
  return byCategory;
}

function section(outcome: Outcome, heading: string, body: string): string {
  const rows = SCENARIOS.filter((s) => s.outcome === outcome);
  if (rows.length === 0) return '';
  const lines = [`## ${heading}`, '', body, ''];
  for (const s of rows) {
    lines.push(`**${s.id} — ${s.title}**`);
    lines.push('');
    lines.push(s.note ?? s.expectation);
    lines.push('');
  }
  return lines.join('\n');
}

export function render(): string {
  const score = scorecard();
  const lines = [
    '# Adversarial scenario coverage',
    '',
    `${score.total} scenarios. Generated from the catalog, not written by hand.`,
    '',
    '| Outcome | Count | Meaning |',
    '|---|---|---|',
    `| HANDLED | ${score.HANDLED} | Behaves correctly, with a test proving it |`,
    `| DETECTED | ${score.DETECTED} | Does not handle it, but notices and refuses to act wrongly |`,
    `| UNHANDLED | ${score.UNHANDLED} | Would do the wrong thing |`,
    '',
  ];

  for (const [category, scenarios] of group(SCENARIOS)) {
    lines.push(`### ${category}`, '');
    lines.push('| id | scenario | outcome |');
    lines.push('|---|---|---|');
    for (const s of scenarios) {
      lines.push(`| ${s.id} | ${s.title} | ${s.outcome} |`);
    }
    lines.push('');
  }

  lines.push(
    section(
      'UNHANDLED',
      'What this does not handle',
      'These would do the wrong thing today. Each is described specifically enough to act on.',
    ),
  );
  lines.push(
    section(
      'DETECTED',
      'What it notices but does not fully handle',
      'The system sees these and refuses to act wrongly, but does not resolve them.',
    ),
  );

  return lines.join('\n');
}
