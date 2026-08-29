import { writeFileSync } from 'node:fs';
import { close } from '@mandate/db';
import { analyzeDeconfliction, renderDeconfliction } from './analyze.ts';

const out = process.argv[2] ?? 'docs/deconfliction.md';
const analysis = await analyzeDeconfliction();
writeFileSync(out, renderDeconfliction(analysis));
console.log(
  `${out}: ${analysis.coverage.with_customer_key} keyed of ${analysis.coverage.scheduled} scheduled, ` +
    `${analysis.result ? `${analysis.result.collisions_before} → ${analysis.result.collisions_after} collisions` : 'nothing to de-conflict'}`,
);
await close();
