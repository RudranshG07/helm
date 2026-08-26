ALTER TABLE merchant
  ADD COLUMN cross_merchant_signals BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE execution_intent
  ADD COLUMN amount_mismatch BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE payment_attempt
  ADD COLUMN counts_against_budget BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE payment_attempt SET counts_against_budget = FALSE
 WHERE error_source = 'business' OR source = 'backfill';

CREATE TABLE bank_holiday (
  holiday_date DATE PRIMARY KEY,
  name         TEXT NOT NULL,
  region       TEXT NOT NULL DEFAULT 'IN',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON payment_attempt (subscription_id, cycle) WHERE counts_against_budget;
