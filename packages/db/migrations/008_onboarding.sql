ALTER TABLE merchant
  ADD COLUMN onboarding_state TEXT NOT NULL DEFAULT 'new'
    CHECK (onboarding_state IN ('new','connecting','backfilling','ready','failed')),
  ADD COLUMN onboarding_error TEXT,
  ADD COLUMN connected_at TIMESTAMPTZ,
  ADD COLUMN backfilled_at TIMESTAMPTZ,
  ADD COLUMN key_fingerprint TEXT;

CREATE TABLE onboarding_job (
  id            BIGSERIAL PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('backfill','csv_import')),
  state         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','running','done','failed')),
  progress      JSONB NOT NULL DEFAULT '{}'::jsonb,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX ON onboarding_job (state, created_at);
CREATE INDEX ON onboarding_job (merchant_id, created_at DESC);
