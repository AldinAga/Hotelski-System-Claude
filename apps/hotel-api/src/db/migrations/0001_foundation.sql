CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE property (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/Belgrade',
  currency char(3) NOT NULL DEFAULT 'RSD',
  languages text[] NOT NULL DEFAULT '{sr,en}',
  municipality text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legal_profile (
  property_id uuid PRIMARY KEY REFERENCES property (id),
  kind text NOT NULL CHECK (kind IN ('legal_entity', 'entrepreneur', 'natural_person')),
  tax_id text,
  registry_id text,
  vat_payer boolean NOT NULL DEFAULT false
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  property_id uuid,
  actor_user_id uuid,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text NOT NULL,
  before jsonb,
  after jsonb,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);
