import { close } from '@mandate/db';
import { config } from './config.ts';
import { ingestBatch } from './ingest.ts';
import { log } from './log.ts';

let running = true;

async function tick(): Promise<void> {
  const processed = await ingestBatch();
  if (processed > 0) {
    log.info('ingest.batch', { processed });
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
