-- Non-fiscal receipts and pro-forma invoices of a folio (Task 8). A document
-- is a snapshot: its content is written once and never recomputed, changed or
-- deleted (trigger below). Numbers run per property, kind and year of the
-- business date without gaps: the counter row is updated in the issuing
-- transaction, so a failed issue rolls the number back with it.
--
-- Applies on top of phase 1a data (Ruling 3): new tables only, no backfill.
-- The request key constraint is named (folio_document_key) so the service can
-- tell it apart, like folio_line_key and payment_key.

CREATE TABLE document_counter (
  property_id uuid NOT NULL REFERENCES property (id),
  kind text NOT NULL CHECK (kind IN ('receipt', 'proforma')),
  year int NOT NULL,
  last int NOT NULL,
  PRIMARY KEY (property_id, kind, year)
);

CREATE TABLE folio_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property (id),
  folio_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('receipt', 'proforma')),
  number text NOT NULL,
  business_date date NOT NULL,
  content jsonb NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  issued_by uuid REFERENCES app_user (id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, number),
  CONSTRAINT folio_document_key UNIQUE (property_id, idempotency_key),
  FOREIGN KEY (property_id, folio_id) REFERENCES folio (property_id, id)
);
CREATE INDEX folio_document_folio_idx ON folio_document (folio_id);

CREATE TRIGGER folio_document_append_only BEFORE UPDATE OR DELETE ON folio_document
  FOR EACH ROW EXECUTE FUNCTION folio_append_only();
