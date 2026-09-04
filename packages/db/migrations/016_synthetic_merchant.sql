ALTER TABLE merchant
  ADD COLUMN synthetic BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN merchant.synthetic IS
  'True when Helm generated this account and its customers itself, for measurement. Only synthetic mandates may be shown to a stranger. A merchant who onboarded by CSV has no Razorpay key and very real customers, so the absence of a key is not a safe test.';

UPDATE merchant SET synthetic = TRUE
 WHERE id LIKE 'helm_demo_batch%' OR id LIKE 'helm_test_account%';
