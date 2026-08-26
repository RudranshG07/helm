import { describe, expect, it } from 'vitest';
import { SCENARIOS, scorecard } from './catalog.ts';
import { render } from './report.ts';

describe('the catalog is honest', () => {
  it('has unique ids', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every UNHANDLED scenario a specific note, not a vague admission', () => {
    for (const s of SCENARIOS.filter((x) => x.outcome === 'UNHANDLED')) {
      expect(s.note, `${s.id} needs a note`).toBeTruthy();
      expect(s.note!.length, `${s.id} note is too vague`).toBeGreaterThan(60);
    }
  });

  it('gives every DETECTED scenario a note explaining what is missing', () => {
    for (const s of SCENARIOS.filter((x) => x.outcome === 'DETECTED')) {
      expect(s.note, `${s.id} needs a note`).toBeTruthy();
    }
  });

  it('does not claim everything works', () => {
    const score = scorecard();
    expect(score.UNHANDLED).toBeGreaterThan(0);
  });

  it('weights coverage toward the categories where money is lost', () => {
    const exactlyOnce = SCENARIOS.filter((s) => s.category === 'Exactly-once');
    expect(exactlyOnce.every((s) => s.outcome === 'HANDLED')).toBe(true);
  });

  it('counts add up to the total', () => {
    const score = scorecard();
    expect(score.HANDLED + score.DETECTED + score.UNHANDLED).toBe(score.total);
  });
});

describe('the report', () => {
  it('publishes the unhandled list rather than burying it', () => {
    const md = render();
    expect(md).toContain('What this does not handle');
    for (const s of SCENARIOS.filter((x) => x.outcome === 'UNHANDLED')) {
      expect(md).toContain(s.id);
      expect(md).toContain(s.note!);
    }
  });

  it('states the counts up front', () => {
    expect(render()).toContain('| HANDLED |');
  });
});
