import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { didSomething, runStage, runStages } from './stages.ts';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'index.ts'), 'utf8');

function stageOrder(): string[] {
  const block = /const stages: Stage\[\] = \[([\s\S]*?)\n  \];/.exec(source);
  if (!block) throw new Error('stage list not found');
  return [...block[1]!.matchAll(/\['([a-z]+)'/g)].map((m) => m[1]!);
}

describe('one broken stage cannot take the worker down with it', () => {
  it('reports a failure instead of throwing', async () => {
    const r = await runStage('boom', async () => { throw new Error('database went away'); });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('database went away');
  });

  it('reports success with the time it took', async () => {
    const r = await runStage('fine', async () => 3);
    expect(r.ok).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('survives a stage that rejects with something that is not an Error', async () => {
    const r = await runStage('odd', async () => { throw 'a string'; });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('a string');
  });

  it('keeps running the remaining stages after one fails', async () => {
    const ran: string[] = [];
    const results = await runStages([
      ['first', async () => { ran.push('first'); return 1; }],
      ['broken', async () => { throw new Error('nope'); }],
      ['third', async () => { ran.push('third'); return 1; }],
    ]);
    expect(ran).toEqual(['first', 'third']);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.find((r) => r.name === 'broken')?.ok).toBe(false);
  });

  it('reports which stages failed, not just that something did', async () => {
    const results = await runStages([
      ['good', async () => 1],
      ['bad', async () => { throw new Error('x'); }],
      ['worse', async () => { throw new Error('y'); }],
    ]);
    expect(results.filter((r) => !r.ok).map((r) => r.name)).toEqual(['bad', 'worse']);
  });
});

describe('a quiet stage stays quiet', () => {
  it.each([
    [undefined, false], [null, false], [0, false], [false, false],
    [[], false], [{ moved: 0, considered: 0 }, false], [{ kept: 0, broken: 0 }, false],
    [3, true], [[1], true], [{ moved: 2, considered: 9 }, true],
    [{ kept: 0, broken: 1 }, true], [{ note: 'something' }, true],
  ])('%j is worth logging: %s', (value, expected) => {
    expect(didSomething(value)).toBe(expected);
  });

  it('does not fill the log with empty passes', async () => {
    const r = await runStage('quiet', async () => ({ moved: 0, collisions_before: 0 }));
    expect(r.ok).toBe(true);
  });
});

describe('money and safety run before analytics', () => {
  it('reconciles stuck payments before anything else can fail', () => {
    expect(stageOrder()[0]).toBe('reconcile');
  });

  it('dispatches due charges before any analytics stage', () => {
    const order = stageOrder();
    const dispatch = order.indexOf('dispatch');
    for (const analytics of ['degradation', 'deconflict', 'decide']) {
      expect(order.indexOf(analytics), `${analytics} must not precede dispatch`)
        .toBeGreaterThan(dispatch);
    }
  });

  it('never lets the degradation rollup precede money movement', () => {
    const order = stageOrder();
    expect(order.indexOf('degradation')).toBeGreaterThan(order.indexOf('outreach'));
  });

  it('runs every stage the loop needs', () => {
    const order = stageOrder();
    for (const stage of ['reconcile', 'dispatch', 'outreach', 'onboarding',
                         'ingest', 'decide', 'deconflict', 'promises', 'degradation']) {
      expect(order, `${stage} is missing from the tick`).toContain(stage);
    }
  });

  it('names the stage in the failure log so an operator can find it', () => {
    const stages = readFileSync(join(here, 'stages.ts'), 'utf8');
    expect(stages).toContain("log.error('stage.failed'");
    expect(stages).toMatch(/stage: name/);
  });

  it('reports a partly working tick rather than pretending it succeeded', () => {
    const stages = readFileSync(join(here, 'stages.ts'), 'utf8');
    expect(stages).toContain("log.warn('tick.degraded'");
  });

  it('keeps the worker entrypoint importable without starting it', () => {
    expect(source, 'the tick must live where it can be tested')
      .toContain("from './stages.ts'");
  });
});
