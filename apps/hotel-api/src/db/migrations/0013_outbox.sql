-- E-mail confirmations through an outbox (Task 9). A message is written in the
-- same transaction as the reservation change it reports and sent later by the
-- dispatcher, so a failed or slow SMTP server never fails a booking.
--
-- Applies on top of phase 1a data (Ruling 3): new tables only, no backfill, so
-- reservations made before this migration get no belated e-mails.
-- Every moment in these tables (next_attempt_at, lease_until, sent_at,
-- outbox_attempt.at) is written by the application from CLOCK, never by now().
-- Composite keys (property_id, id) follow 0007 (preflight F19).

CREATE TABLE outbox_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property (id),
  channel text NOT NULL CHECK (channel IN ('email')),
  template text NOT NULL CHECK (template IN ('reservation_confirmed', 'reservation_cancelled')),
  idempotency_key text NOT NULL,
  reservation_id uuid,
  recipient text,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (property_id, id),
  UNIQUE (property_id, idempotency_key),
  FOREIGN KEY (property_id, reservation_id) REFERENCES reservation (property_id, id)
);
CREATE INDEX outbox_due_idx ON outbox_message (next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX outbox_message_reservation_idx ON outbox_message (reservation_id);

CREATE TABLE outbox_attempt (
  id bigserial PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES property (id),
  message_id uuid NOT NULL,
  at timestamptz NOT NULL,
  ok boolean NOT NULL,
  error text,
  FOREIGN KEY (property_id, message_id) REFERENCES outbox_message (property_id, id)
);
CREATE INDEX outbox_attempt_message_idx ON outbox_attempt (message_id);
