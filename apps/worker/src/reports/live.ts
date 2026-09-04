import { analyzeContention, renderContention } from '../contention/analyze.ts';
import { analyzeDeconfliction, renderDeconfliction } from '../deconflict/analyze.ts';
import { analyzeOffPolicy, renderOpe } from '../ope/analyze.ts';
import { runBacktest } from '../backtest/run.ts';
import { renderBacktest } from '../backtest/report.ts';
import { render as renderAdversarial } from '../adversarial/report.ts';

export interface ReportDefinition {
  slug: string;
  title: string;
  description: string;
  build: () => Promise<string>;
}

export const LIVE_REPORTS: ReportDefinition[] = [
  {
    slug: 'adversarial',
    title: 'Adversarial coverage',
    description: 'Every hard scenario, and an honest verdict on each.',
    build: async () => renderAdversarial(),
  },
  {
    slug: 'backtest',
    title: 'Backtest',
    description: 'The policy replayed over history that already has its outcome.',
    build: async () => renderBacktest(await runBacktest(), 'generated live from this instance'),
  },
  {
    slug: 'contention',
    title: 'Contention',
    description: 'The falsifiable test behind the payday-queueing claim.',
    build: async () => {
      const analysis = await analyzeContention();
      return renderContention(analysis, 'generated live from this instance');
    },
  },
  {
    slug: 'deconfliction',
    title: 'De-confliction',
    description: 'Debits spread so merchants stop colliding on one account.',
    build: async () => renderDeconfliction(await analyzeDeconfliction()),
  },
  {
    slug: 'off-policy',
    title: 'Off-policy evaluation',
    description: 'What a different policy would have been worth, and whether the data supports saying.',
    build: async () => renderOpe(await analyzeOffPolicy()),
  },
];

export function reportIndex(): { slug: string; title: string; description: string }[] {
  return LIVE_REPORTS.map(({ slug, title, description }) => ({ slug, title, description }));
}

export async function buildReport(slug: string): Promise<string | null> {
  const report = LIVE_REPORTS.find((r) => r.slug === slug);
  if (!report) return null;
  return report.build();
}
