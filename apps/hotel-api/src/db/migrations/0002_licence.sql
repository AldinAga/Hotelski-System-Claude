-- The installation's identity towards the Central Admin Panel: one row, written
-- at activation. private_seed_enc is the Ed25519 seed sealed with
-- HOTEL_SECRET_KEY (AES-256-GCM, v1.<iv>.<ciphertext>.<tag>), never plaintext.
-- key_chain holds every signed key set accepted after the pinned root, oldest
-- first; key_set is the trusted set it leads to. The database is not a trust
-- anchor: at startup the chain is replayed from HOTEL_ROOT_KEYSET.
CREATE TABLE installation_licence (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  installation_id text NOT NULL,
  private_seed_enc text NOT NULL,
  envelope jsonb NOT NULL,
  key_set jsonb NOT NULL,
  key_chain jsonb NOT NULL DEFAULT '[]',
  memory jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
