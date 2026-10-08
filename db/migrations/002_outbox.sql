-- Transactional outbox: written in the SAME transaction as the payment change, published later
-- by the relay. If SQS is down the payment still commits; the event just waits here.
CREATE TABLE outbox (
  id            BIGSERIAL   PRIMARY KEY,
  topic         TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ
);
-- Partial index: the relay only reads pending rows, a tiny fraction of the table once it grows.
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
