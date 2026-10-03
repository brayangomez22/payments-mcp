CREATE TABLE payments (
  id              UUID        PRIMARY KEY,
  merchant_id     TEXT        NOT NULL,
  amount_minor    BIGINT      NOT NULL CHECK (amount_minor > 0),
  currency        CHAR(3)     NOT NULL,
  status          TEXT        NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'partially_refunded', 'refunded')),
  refunded_minor  BIGINT      NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor),
  description     TEXT,
  provider_ref    TEXT,
  failure_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);

-- Keyset pagination per merchant. A btree can be scanned backwards, so ASC also serves
-- ORDER BY created_at DESC, id DESC.
CREATE INDEX payments_merchant_created_idx ON payments (merchant_id, created_at, id);
CREATE INDEX payments_merchant_status_created_idx ON payments (merchant_id, status, created_at, id);

CREATE TABLE refunds (
  id            UUID        PRIMARY KEY,
  payment_id    UUID        NOT NULL REFERENCES payments (id),
  amount_minor  BIGINT      NOT NULL CHECK (amount_minor > 0),
  provider_ref  TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX refunds_payment_idx ON refunds (payment_id);

CREATE TABLE idempotency_keys (
  merchant_id    TEXT        NOT NULL,
  key            TEXT        NOT NULL,
  fingerprint    TEXT        NOT NULL,
  response_body  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, key)
);
