import { writeFileSync } from 'node:fs';
import { close } from '@mandate/db';
import { analyzeContention, renderContention } from './analyze.ts';

const out = process.argv[2] ?? 'docs/contention.md';
const provenance = process.argv[3] ?? 'Razorpay test mode (not real merchant data)';

const analysis = await analyzeContention(process.argv[4]);
writeFileSync(out, renderContention(analysis, provenance));

console.log(`${out}: ${analysis.total_observations} observations, verdict ${analysis.test.verdict}`);
await close();
