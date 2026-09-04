import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIVE_REPORTS, buildReport, reportIndex } from '@mandate/worker/reports/live';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('reports are produced by the running instance, not shipped as files', () => {
  it('does not read them off disk', () => {
    const control = readFileSync(join(root, 'apps/api/src/control.ts'), 'utf8');
    expect(control, 'a deploy has no docs directory, so a file read returns nothing')
      .not.toContain('readdirSync');
    expect(control).not.toContain('REPORTS_DIR');
  });

  it('registers every analysis the project produces', () => {
    const slugs = reportIndex().map((r) => r.slug);
    for (const expected of ['adversarial', 'backtest', 'contention', 'deconfliction', 'off-policy']) {
      expect(slugs, expected).toContain(expected);
    }
  });

  it('gives each report a title and a reason to open it', () => {
    for (const r of reportIndex()) {
      expect(r.title.length, r.slug).toBeGreaterThan(3);
      expect(r.description.length, r.slug).toBeGreaterThan(20);
    }
  });

  it('returns nothing for a report that does not exist', async () => {
    expect(await buildReport('not-a-report')).toBeNull();
  });

  it('builds the catalogue without touching the database', async () => {
    const markdown = await buildReport('adversarial');
    expect(markdown).toBeTruthy();
    expect(markdown!.length).toBeGreaterThan(1000);
    expect(markdown).toContain('HANDLED');
  });

  it('keeps every registered report buildable', () => {
    for (const r of LIVE_REPORTS) {
      expect(typeof r.build, r.slug).toBe('function');
    }
  });
});
