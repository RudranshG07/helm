import { log } from './log.ts';

export interface StageResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export type Stage = [name: string, run: () => Promise<unknown>];

export function didSomething(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') {
    const numbers = Object.values(value as Record<string, unknown>)
      .filter((v): v is number => typeof v === 'number');
    if (numbers.length === 0) return true;
    return numbers.some((n) => n !== 0);
  }
  return true;
}

export async function runStage(name: string, fn: () => Promise<unknown>): Promise<StageResult> {
  const started = Date.now();
  try {
    const value = await fn();
    const ms = Date.now() - started;
    if (didSomething(value)) {
      const detail = typeof value === 'object' ? { ...(value as object) } : { value };
      log.info(`stage.${name}`, { ...detail, ms });
    }
    return { name, ok: true, ms };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('stage.failed', { stage: name, ms: Date.now() - started, message });
    return { name, ok: false, ms: Date.now() - started, error: message };
  }
}

export async function runStages(stages: Stage[]): Promise<StageResult[]> {
  const results: StageResult[] = [];
  for (const [name, fn] of stages) {
    results.push(await runStage(name, fn));
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    log.warn('tick.degraded', {
      failed: failed.map((f) => f.name).join(','),
      healthy: results.length - failed.length,
    });
  }

  return results;
}
