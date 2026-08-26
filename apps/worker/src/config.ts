export const config = {
  workerId: process.env['WORKER_ID'] ?? `worker-${process.pid}`,
  pollIntervalMs: Number(process.env['POLL_INTERVAL_MS'] ?? 2000),
  ingestBatchSize: Number(process.env['INGEST_BATCH_SIZE'] ?? 50),
  dryRun: process.env['DRY_RUN'] !== 'false',
};
