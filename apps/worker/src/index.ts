import { close } from '@mandate/db';
import { config } from './config.ts';
import { decideBatch, makeProposalClient } from './decide.ts';
import { rollupDegradation } from './degradation.ts';
import { isSweepDue, nightlySweep } from './nightly.ts';
import { runOnboardingJobs } from './onboarding.ts';
import { dispatchDue, dispatchOutreach } from './dispatch.ts';
import { makeOutreachProvider } from './outreach/provider.ts';
import { resolvePromises } from './promise.ts';
import { deconflictScheduled } from './deconflict/live.ts';
import { reconcileStuck } from './executor.ts';
import { makeGateway } from './gateway-factory.ts';
import { ingestBatch } from './ingest.ts';
import { log } from './log.ts';
import { runStages } from './stages.ts';
import type { Stage, StageResult } from './stages.ts';

let running = true;

const agent = makeProposalClient();
const gateway = makeGateway();
const outreachProvider = makeOutreachProvider();
const SWEEP_INTERVAL_MS = Number(process.env['SWEEP_INTERVAL_MS'] ?? 6 * 3600 * 1000);
let lastSweep: Date | null = null;

async function tick(): Promise<StageResult[]> {
  const now = new Date();
  const sweepDue = isSweepDue(lastSweep, now, SWEEP_INTERVAL_MS);
  if (sweepDue) lastSweep = now;

  const stages: Stage[] = [
    ['reconcile', () => reconcileStuck(gateway)],
    ['dispatch', () => dispatchDue(gateway)],
    ['outreach', () => dispatchOutreach(outreachProvider)],
    ['onboarding', () => runOnboardingJobs()],
    ['ingest', () => ingestBatch()],
    ['decide', () => decideBatch(agent)],
    ['deconflict', () => deconflictScheduled()],
    ['promises', () => resolvePromises()],
    ['degradation', () => rollupDegradation()],
    ...(sweepDue ? [['sweep', () => nightlySweep(now)] as Stage] : []),
  ];

  return runStages(stages);
}

async function main(): Promise<void> {
  log.info('worker.start', { worker_id: config.workerId, dry_run: config.dryRun });

  while (running) {
    try {
      await tick();
    } catch (err) {
      log.error('worker.tick_failed', { message: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }

  await close();
  log.info('worker.stopped');
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info('worker.shutdown', { signal });
    running = false;
  });
}

await main();
