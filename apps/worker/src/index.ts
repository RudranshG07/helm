import { close } from '@mandate/db';
import { config } from './config.ts';
import { decideBatch, makeProposalClient } from './decide.ts';
import { rollupDegradation } from './degradation.ts';
import { isSweepDue, nightlySweep } from './nightly.ts';
import { runOnboardingJobs } from './onboarding.ts';
import { dispatchDue, dispatchOutreach } from './dispatch.ts';
import { makeOutreachProvider } from './outreach/provider.ts';
import { reconcileStuck } from './executor.ts';
import { makeGateway } from './gateway-factory.ts';
import { ingestBatch } from './ingest.ts';
import { log } from './log.ts';

let running = true;

const agent = makeProposalClient();
const gateway = makeGateway();
const outreachProvider = makeOutreachProvider();
const SWEEP_INTERVAL_MS = Number(process.env['SWEEP_INTERVAL_MS'] ?? 6 * 3600 * 1000);
let lastSweep: Date | null = null;

async function tick(): Promise<void> {
  const onboarded = await runOnboardingJobs();
  if (onboarded > 0) {
    log.info('onboarding.processed', { jobs: onboarded });
  }

  const processed = await ingestBatch();
  await rollupDegradation();
  if (processed > 0) {
    log.info('ingest.batch', { processed });
  }
  const decided = await decideBatch(agent);
  if (decided > 0) {
    log.info('decide.batch', { decided });
  }

  const dispatched = await dispatchDue(gateway);
  if (dispatched > 0) {
    log.info('dispatch.batch', { dispatched });
  }

  const contacted = await dispatchOutreach(outreachProvider);
  if (contacted > 0) {
    log.info('outreach.batch', { contacted });
  }

  const reconciled = await reconcileStuck(gateway);
  if (reconciled > 0) {
    log.info('reconcile.batch', { reconciled });
  }

  const now = new Date();
  if (isSweepDue(lastSweep, now, SWEEP_INTERVAL_MS)) {
    lastSweep = now;
    const sweep = await nightlySweep(now);
    if (sweep.scored > 0) {
      log.info('nightly.sweep', sweep as unknown as Record<string, unknown>);
    }
  }
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
