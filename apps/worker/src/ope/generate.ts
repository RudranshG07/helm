import { writeFileSync } from 'node:fs';
import { close } from '@mandate/db';
import { analyzeOffPolicy, renderOpe } from './analyze.ts';

const out = process.argv[2] ?? 'docs/off-policy.md';
const analysis = await analyzeOffPolicy();
writeFileSync(out, renderOpe(analysis));
console.log(`${out}: ${analysis.estimate.n} usable, support ${analysis.estimate.support}`);
await close();
