CREATE TABLE outreach (
  id               BIGSERIAL PRIMARY KEY,
  decision_id      BIGINT REFERENCES decision(id),
  subscription_id  TEXT NOT NULL REFERENCES subscription(id),
  cycle            TIMESTAMPTZ NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  token            TEXT NOT NULL UNIQUE,
  channel          TEXT NOT NULL CHECK (channel IN ('email','sms','none')),
  status           TEXT NOT NULL CHECK (status IN ('queued','sent','failed','viewed','converted','expired','revoked')),
  recipient_masked TEXT,
  provider_ref     TEXT,
  error            TEXT,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  sent_at          TIMESTAMPTZ,
  viewed_at        TIMESTAMPTZ,
  converted_at     TIMESTAMPTZ
);

CREATE INDEX ON outreach (subscription_id, cycle);
CREATE INDEX ON outreach (status, expires_at);
CREATE INDEX ON outreach (created_at DESC);

ALTER TABLE subscription
  ADD COLUMN contact_email TEXT,
  ADD COLUMN contact_phone TEXT,
  ADD COLUMN outreach_opted_out BOOLEAN NOT NULL DEFAULT FALSE;
