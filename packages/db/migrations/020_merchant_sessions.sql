CREATE TABLE merchant_session (
  token_hash   TEXT PRIMARY KEY,
  merchant_id  TEXT NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_seen_at TIMESTAMPTZ
);

CREATE INDEX merchant_session_merchant_idx ON merchant_session (merchant_id, created_at DESC);

COMMENT ON TABLE merchant_session IS
  'One row per signed-in browser. A single column on merchant held one hash, so signing in anywhere silently signed you out everywhere else, including on the phone you were reading from. Signing out now ends the session that asked, not every session the merchant has.';

INSERT INTO merchant_session (token_hash, merchant_id, created_at)
SELECT session_token_hash, id, COALESCE(session_issued_at, clock_timestamp())
  FROM merchant
 WHERE session_token_hash IS NOT NULL
ON CONFLICT (token_hash) DO NOTHING;
