import { config } from './config.ts';
import { decideBatch, makeProposalClient } from './decide.ts';
import { rollupDegradation } from './degradation.ts';
import { isSweepDue, nightlySweep } from './nightly.ts';
import { runOnboardingJobs } from './onboarding.ts';
import { dispatchDue, dispatchOutreach } from './dispatch.ts';
import { reconcileStuck } from './executor.ts';
import { makeGateway } from './gateway-factory.ts';
import { ingestBatch } from './ingest.ts';
import { log } from './log.ts';
import { runStages } from './stages.ts';
import type { Stage, StageResult } from './stages.ts';
import { makeOutreachProvider } from './outreach/provider.ts';
import { resolvePromises } from './promise.ts';
import { deconflictScheduled } from './deconflict/live.ts';

const SWEEP_INTERVAL_MS = Number(process.env['SWEEP_INTERVAL_MS'] ?? 6 * 3600 * 1000);

export interface EmbeddedWorker {
  stop: () => void;
  running: () => boolean;
}

export function buildStages(deps: {
  agent: ReturnType<typeof makeProposalClient>;
  gateway: ReturnType<typeof makeGateway>;
  outreachProvider: ReturnType<typeof makeOutreachProvider>;
  now: Date;
  sweepDue: boolean;
}): Stage[] {
  const { agent, gateway, outreachProvider, now, sweepDue } = deps;
  return [
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
}

export function startEmbeddedWorker(): EmbeddedWorker {
  const agent = makeProposalClient();
  const gateway = makeGateway();
  const outreachProvider = makeOutreachProvider();

  let alive = true;
  let lastSweep: Date | null = null;

  log.info('worker.embedded_start', {
    poll_interval_ms: config.pollIntervalMs,
    dry_run: config.dryRun,
  });

  const loop = async (): Promise<void> => {
    while (alive) {
      const now = new Date();
      const sweepDue = isSweepDue(lastSweep, now, SWEEP_INTERVAL_MS);
      if (sweepDue) lastSweep = now;

      try {
        const results: StageResult[] = await runStages(
          buildStages({ agent, gateway, outreachProvider, now, sweepDue }),
        );
        if (results.length === 0) log.warn('worker.embedded_idle', {});
      } catch (err) {
        log.error('worker.embedded_tick_failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }

      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
    log.info('worker.embedded_stopped', {});
  };

  void loop();

  return {
    stop: () => { alive = false; },
    running: () => alive,
  };
}
