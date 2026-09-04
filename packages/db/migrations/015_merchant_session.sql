ALTER TABLE merchant
  ADD COLUMN session_token_hash TEXT,
  ADD COLUMN session_issued_at  TIMESTAMPTZ;

CREATE UNIQUE INDEX merchant_session_token_hash_key
  ON merchant (session_token_hash) WHERE session_token_hash IS NOT NULL;

COMMENT ON COLUMN merchant.session_token_hash IS
  'SHA-256 of the dashboard token. The token is shown once, when a merchant proves control of the Razorpay account by connecting a working key, and is never stored. A database leak therefore does not hand any dashboard to the reader.';
