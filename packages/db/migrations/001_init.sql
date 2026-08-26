CREATE TABLE merchant (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  rzp_account_id      TEXT,
  rzp_key_id          TEXT,
  rzp_key_secret_enc  BYTEA,
  webhook_secret_enc  BYTEA,
  mode                TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
  integration         TEXT CHECK (integration IN ('subscriptions','recurring_tokens')),
  consent_signed_at   TIMESTAMPTZ,
  write_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscription (
  id                  TEXT PRIMARY KEY,
  merchant_id         TEXT NOT NULL REFERENCES merchant(id),
  rzp_subscription_id TEXT NOT NULL,
  customer_ref        TEXT NOT NULL,
  method              TEXT NOT NULL CHECK (method IN ('upi_autopay','card','emandate')),
  amount_paise        BIGINT NOT NULL CHECK (amount_paise > 0),
  cycle_interval      TEXT,
  status              TEXT NOT NULL,
  current_start       TIMESTAMPTZ,
  current_end         TIMESTAMPTZ,
  charge_at           TIMESTAMPTZ,
  mandate_expiry_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, rzp_subscription_id)
);
CREATE INDEX ON subscription (merchant_id, status);
CREATE INDEX ON subscription (customer_ref);

CREATE TABLE raw_event (
  id            BIGSERIAL PRIMARY KEY,
  merchant_id   TEXT REFERENCES merchant(id),
  rzp_event_id  TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  signature_ok  BOOLEAN NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  process_error TEXT
);
CREATE UNIQUE INDEX raw_event_dedup ON raw_event (rzp_event_id, event_type);
CREATE INDEX ON raw_event (processed_at) WHERE processed_at IS NULL;

CREATE TABLE payment_attempt (
  id                BIGSERIAL PRIMARY KEY,
  subscription_id   TEXT NOT NULL REFERENCES subscription(id),
  rzp_payment_id    TEXT,
  rzp_order_id      TEXT,
  cycle             TIMESTAMPTZ NOT NULL,
  attempted_at      TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('created','authorized','captured','failed','unknown')),
  amount_paise      BIGINT NOT NULL,
  error_code        TEXT,
  error_description TEXT,
  error_source      TEXT,
  error_step        TEXT,
  error_reason      TEXT,
  issuer            TEXT,
  bank              TEXT,
  initiated_by      TEXT NOT NULL CHECK (initiated_by IN ('razorpay_default','mandate_rescue')),
  source            TEXT NOT NULL DEFAULT 'webhook' CHECK (source IN ('webhook','backfill','csv_import')),
  bucket            TEXT,
  taxonomy_version  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON payment_attempt (subscription_id, attempted_at DESC);
CREATE INDEX ON payment_attempt (error_reason);
CREATE INDEX ON payment_attempt (subscription_id, cycle);
CREATE UNIQUE INDEX payment_attempt_rzp ON payment_attempt (rzp_payment_id) WHERE rzp_payment_id IS NOT NULL;

CREATE TABLE mandate_health (
  id                   BIGSERIAL PRIMARY KEY,
  subscription_id      TEXT NOT NULL REFERENCES subscription(id),
  scored_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  consecutive_failures INT NOT NULL,
  attempts_remaining   INT NOT NULL,
  days_to_expiry       INT,
  risk_score           NUMERIC(4,3) NOT NULL,
  risk_band            TEXT NOT NULL CHECK (risk_band IN ('healthy','at_risk','critical')),
  contributions        JSONB NOT NULL DEFAULT '{}'::jsonb,
  amount_at_risk_paise BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX ON mandate_health (subscription_id, scored_at DESC);
CREATE INDEX ON mandate_health (risk_band, scored_at DESC);

CREATE TABLE decision (
  id                BIGSERIAL PRIMARY KEY,
  subscription_id   TEXT NOT NULL REFERENCES subscription(id),
  cycle             TIMESTAMPTZ NOT NULL,
  proposed_action   TEXT NOT NULL,
  proposed_by       TEXT NOT NULL,
  prompt_version    TEXT,
  confidence        NUMERIC(4,3),
  verdict           TEXT NOT NULL CHECK (verdict IN ('ALLOW','DENY','DEFER')),
  rule_id           TEXT NOT NULL,
  scheduled_for     TIMESTAMPTZ,
  proposed_for      TIMESTAMPTZ,
  rationale         TEXT,
  explanation       TEXT,
  agent_context     JSONB,
  taxonomy_version  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at       TIMESTAMPTZ,
  outcome           TEXT
);
CREATE INDEX ON decision (subscription_id, created_at DESC);
CREATE INDEX ON decision (verdict, rule_id);

CREATE TABLE execution_intent (
  id              BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  subscription_id TEXT NOT NULL REFERENCES subscription(id),
  cycle           TIMESTAMPTZ NOT NULL,
  attempt_number  INT NOT NULL,
  decision_id     BIGINT REFERENCES decision(id),
  amount_paise    BIGINT NOT NULL,
  scheduled_for   TIMESTAMPTZ NOT NULL,
  state           TEXT NOT NULL CHECK (state IN
                    ('INTENDED','SUBMITTED','SETTLED_SUCCESS','SETTLED_FAILED','ABANDONED','DRY_RUN')),
  rzp_order_id    TEXT,
  rzp_payment_id  TEXT,
  dry_run         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at    TIMESTAMPTZ,
  settled_at      TIMESTAMPTZ,
  last_error      TEXT
);
CREATE INDEX ON execution_intent (state, created_at);
CREATE UNIQUE INDEX execution_intent_cycle_attempt
  ON execution_intent (subscription_id, cycle, attempt_number);

CREATE TABLE job (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  run_after   TIMESTAMPTZ NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','claimed','done','failed','cancelled')),
  attempts    INT NOT NULL DEFAULT 0,
  claimed_at  TIMESTAMPTZ,
  claimed_by  TEXT,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON job (state, run_after);

CREATE TABLE arm_assignment (
  subscription_id TEXT PRIMARY KEY REFERENCES subscription(id),
  arm             TEXT NOT NULL CHECK (arm IN ('control','treatment')),
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE degradation_signal (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL CHECK (source IN ('internal_rollup','razorpay_downtime')),
  issuer        TEXT,
  method        TEXT NOT NULL,
  severity      TEXT,
  baseline_rate NUMERIC(5,4),
  current_rate  NUMERIC(5,4),
  sample_size   INT,
  started_at    TIMESTAMPTZ NOT NULL,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON degradation_signal (issuer, method, started_at DESC);

CREATE TABLE control_flags (
  id                 INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  kill_switch        BOOLEAN NOT NULL DEFAULT FALSE,
  kill_switch_reason TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO control_flags (id, kill_switch) VALUES (1, FALSE);
