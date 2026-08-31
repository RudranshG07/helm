CREATE TABLE promise_to_pay (
  id              BIGSERIAL PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
  outreach_id     BIGINT REFERENCES outreach(id) ON DELETE SET NULL,
  cycle           TIMESTAMPTZ NOT NULL,
  promised_for    DATE NOT NULL,
  promised_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  amount_paise    BIGINT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('open','kept','broken','superseded','expired')),
  resolved_at     TIMESTAMPTZ,
  source          TEXT NOT NULL DEFAULT 'customer' CHECK (source IN ('customer','merchant','inferred'))
);

CREATE UNIQUE INDEX promise_to_pay_open_idx
  ON promise_to_pay (subscription_id, cycle) WHERE status = 'open';
CREATE INDEX ON promise_to_pay (status, promised_for);
CREATE INDEX ON promise_to_pay (subscription_id, promised_at DESC);
