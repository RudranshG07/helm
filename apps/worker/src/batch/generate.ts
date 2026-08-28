import { writeFileSync } from 'node:fs';
import { renderBatch } from './report.ts';
import { runBatch } from './run.ts';

const out = process.argv[2] ?? 'docs/results.md';
const count = Number(process.argv[3] ?? 120);

const result = runBatch({ count });
writeFileSync(out, renderBatch(result));

const per = (a: { amount_recovered_paise: number; attempts_spent: number }) =>
  a.attempts_spent > 0 ? Math.round(a.amount_recovered_paise / a.attempts_spent / 100) : 0;

console.log(
  `${out}: ${count} mandates, control ₹${per(result.control)}/attempt, treatment ₹${per(result.treatment)}/attempt`,
);
