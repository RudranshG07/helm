ALTER TABLE payment_attempt DROP CONSTRAINT IF EXISTS payment_attempt_source_check;
ALTER TABLE payment_attempt
  ADD CONSTRAINT payment_attempt_source_check
  CHECK (source IN ('webhook','backfill','csv_import','executor'));

CREATE INDEX IF NOT EXISTS payment_attempt_initiated_by_idx
  ON payment_attempt (initiated_by, attempted_at DESC);

ALTER TABLE arm_assignment
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN IF NOT EXISTS assigned_by TEXT NOT NULL DEFAULT 'hash';
