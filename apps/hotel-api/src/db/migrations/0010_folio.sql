-- The folio of a stay, its lines and its payments (spec 5.5). Append-only:
-- a line or a payment is never changed or deleted (trigger below); a
-- correction is a new line that reverses one, a void a new payment that
-- reverses one. The balance (lines minus payments) is computed in SQL under
-- the locked folio row and never stored.
--
-- Applies on top of phase 1a data (Ruling 3): new tables only, no backfill.
-- A folio is created lazily, by the first check-in, charge or payment of its
-- stay (FolioService.ensureFolio); stays from 1a have none until then.
--
-- Deviations from the plan (Ruling 7): the reverses_* keys are composite
-- (property_id, id) foreign keys like every other one (preflight F19);
-- folio_line.source_id names the source of a posting: the business day for
-- night_audit, the stay for check_out and no_show, the POS bill in phase 2
-- (preflight F23c).

CREATE TABLE folio (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property (id),
  stay_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (property_id, stay_id),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, stay_id) REFERENCES stay (property_id, id),
  FOREIGN KEY (property_id, reservation_id) REFERENCES reservation (property_id, id),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE TABLE folio_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property (id),
  folio_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('accommodation', 'tourist_tax', 'fee', 'pos', 'service', 'deposit', 'correction')),
  description text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  vat_rate_bp int CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  business_date date NOT NULL,
  night date,
  source_type text NOT NULL CHECK (source_type IN ('night_audit', 'check_out', 'no_show', 'manual', 'reversal')),
  source_id text,
  reverses_line_id uuid CONSTRAINT folio_line_reverses_once UNIQUE,
  reason text,
  idempotency_key text,
  request_hash text,
  created_by uuid REFERENCES app_user (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, folio_id) REFERENCES folio (property_id, id),
  FOREIGN KEY (property_id, reverses_line_id) REFERENCES folio_line (property_id, id),
  CHECK ((kind = 'correction') = (reverses_line_id IS NOT NULL)),
  CHECK ((kind = 'accommodation') = (night IS NOT NULL)),
  CHECK ((idempotency_key IS NULL) = (request_hash IS NULL))
);
CREATE UNIQUE INDEX folio_line_night ON folio_line (folio_id, night) WHERE kind = 'accommodation';
CREATE UNIQUE INDEX folio_line_key ON folio_line (property_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX folio_line_folio_idx ON folio_line (folio_id);
CREATE INDEX folio_line_business_date_idx ON folio_line (property_id, business_date);

CREATE TABLE payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property (id),
  folio_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('cash', 'card', 'card_link', 'ips_qr', 'transfer', 'advance')),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),  -- negative: refund or void
  business_date date NOT NULL,
  reference text,
  fiscal_document_id text,  -- phase 1c; always null in 1b
  reverses_payment_id uuid CONSTRAINT payment_reverses_once UNIQUE,
  reason text,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_by uuid REFERENCES app_user (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_key UNIQUE (property_id, idempotency_key),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, folio_id) REFERENCES folio (property_id, id),
  FOREIGN KEY (property_id, reverses_payment_id) REFERENCES payment (property_id, id)
);
CREATE INDEX payment_folio_idx ON payment (folio_id);
CREATE INDEX payment_business_date_idx ON payment (property_id, business_date);

CREATE FUNCTION folio_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only: % rows are never changed or deleted', TG_TABLE_NAME;
END $$;
CREATE TRIGGER folio_line_append_only BEFORE UPDATE OR DELETE ON folio_line
  FOR EACH ROW EXECUTE FUNCTION folio_append_only();
CREATE TRIGGER payment_append_only BEFORE UPDATE OR DELETE ON payment
  FOR EACH ROW EXECUTE FUNCTION folio_append_only();
