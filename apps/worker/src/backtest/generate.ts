import { writeFileSync } from 'node:fs';
import { close } from '@mandate/db';
import { renderBacktest } from './report.ts';
import { runBacktest } from './run.ts';

const out = process.argv[2] ?? 'docs/backtest.md';
const provenance = process.argv[3] ?? 'Razorpay test mode (not real merchant data)';
const merchantId = process.argv[4];

const result = await runBacktest(merchantId);
writeFileSync(out, renderBacktest(result, provenance));

const t = result.totals;
console.log(
  `${out}: ${t.failures_examined} failures, ${t.default_attempts_on_hard_declines} default attempts on hard declines, ` +
    `${t.unmapped_failures} unmapped`,
);
await close();
