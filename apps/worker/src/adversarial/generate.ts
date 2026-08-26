import { writeFileSync } from 'node:fs';
import { scorecard } from './catalog.ts';
import { render } from './report.ts';

const out = process.argv[2] ?? 'docs/adversarial.md';
writeFileSync(out, render());

const score = scorecard();
console.log(
  `${out}: ${score.total} scenarios, ${score.HANDLED} handled, ${score.DETECTED} detected, ${score.UNHANDLED} unhandled`,
);
