ALTER TABLE decision
  ADD COLUMN logging_propensity NUMERIC(6,5),
  ADD COLUMN target_propensity  NUMERIC(6,5),
  ADD COLUMN explored           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN expected_paise     BIGINT,
  ADD COLUMN slots_considered   INT;

CREATE INDEX ON decision (explored) WHERE logging_propensity IS NOT NULL;
