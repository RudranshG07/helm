ALTER TABLE subscription
  ADD COLUMN rzp_token_id    TEXT,
  ADD COLUMN rzp_customer_id TEXT;

CREATE INDEX ON subscription (rzp_token_id) WHERE rzp_token_id IS NOT NULL;
