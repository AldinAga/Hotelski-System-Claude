-- The installation's identity towards the Central Admin Panel: one row, written
-- at activation. private_seed_enc is the Ed25519 seed sealed with
-- HOTEL_SECRET_KEY (AES-256-GCM, v1.<iv>.<ciphertext>.<tag>), never plaintext.
CREATE TABLE installation_licence (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  installation_id text NOT NULL,
  private_seed_enc text NOT NULL,
  envelope jsonb NOT NULL,
  key_set jsonb NOT NULL,
  memory jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
