ALTER TABLE mandate_health   ALTER COLUMN scored_at  SET DEFAULT clock_timestamp();
ALTER TABLE payment_attempt  ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE decision         ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE execution_intent ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE raw_event        ALTER COLUMN received_at SET DEFAULT clock_timestamp();
