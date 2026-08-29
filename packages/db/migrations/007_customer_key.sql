ALTER TABLE subscription
  ADD COLUMN customer_key TEXT;

COMMENT ON COLUMN subscription.customer_key IS
  'Stable identifier for the same person across merchants. Derived from a hashed VPA or contact supplied by the merchant. Null when the merchant supplies nothing matchable, in which case that mandate cannot participate in cross-merchant de-confliction.';

CREATE INDEX ON subscription (customer_key) WHERE customer_key IS NOT NULL;
