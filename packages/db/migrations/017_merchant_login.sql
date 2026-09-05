ALTER TABLE merchant
  ADD COLUMN email           TEXT,
  ADD COLUMN password_hash   TEXT,
  ADD COLUMN password_set_at TIMESTAMPTZ;

CREATE UNIQUE INDEX merchant_email_key ON merchant (lower(email)) WHERE email IS NOT NULL;

COMMENT ON COLUMN merchant.password_hash IS
  'scrypt hash with a per-merchant salt. A merchant who forgets it proves ownership the same way they did when connecting, by supplying a working Razorpay key, which sets a new one.';
