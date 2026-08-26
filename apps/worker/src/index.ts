import { close } from '@mandate/db';
import { config } from './config.ts';
import { decideBatch, makeProposalClient } from './decide.ts';
import { dispatchDue } from './dispatch.ts';
import { reconcileStuck } from './executor.ts';
import { RefusingGateway } from './gateway.ts';
import { ingestBatch } from './ingest.ts';
import { log } from './log.ts';

let running = true;

const agent = makeProposalClient();
const gateway = new RefusingGateway();

async function tick(): Promise<void> {
  const processed = await ingestBatch();
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

  const reconciled = await reconcileStuck(gateway);
  if (reconciled > 0) {
    log.info('reconcile.batch', { reconciled });
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
