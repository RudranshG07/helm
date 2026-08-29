CREATE TABLE taxonomy_reclassification (
  id                    BIGSERIAL PRIMARY KEY,
  attempt_id            BIGINT NOT NULL REFERENCES payment_attempt(id) ON DELETE CASCADE,
  from_bucket           TEXT,
  to_bucket             TEXT NOT NULL,
  from_version          TEXT,
  to_version            TEXT NOT NULL,
  from_counts_budget    BOOLEAN NOT NULL,
  to_counts_budget      BOOLEAN NOT NULL,
  cycle_open_at_change  BOOLEAN NOT NULL,
  reclassified_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX ON taxonomy_reclassification (attempt_id);
CREATE INDEX ON taxonomy_reclassification (reclassified_at DESC);
CREATE INDEX ON payment_attempt (taxonomy_version) WHERE status = 'failed';
