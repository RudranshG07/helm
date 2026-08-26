export const config = {
  workerId: process.env['WORKER_ID'] ?? `worker-${process.pid}`,
  pollIntervalMs: Number(process.env['POLL_INTERVAL_MS'] ?? 2000),
  ingestBatchSize: Number(process.env['INGEST_BATCH_SIZE'] ?? 50),
  decideBatchSize: Number(process.env['DECIDE_BATCH_SIZE'] ?? 25),
  blastRadiusMax: Number(process.env['BLAST_RADIUS_MAX_ATTEMPTS'] ?? 50),
  dryRun: process.env['DRY_RUN'] !== 'false',
};
