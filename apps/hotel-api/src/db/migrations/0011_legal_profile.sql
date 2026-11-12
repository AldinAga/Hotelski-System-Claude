-- The property's full legal profile (spec 5, Task 7). Applies on top of phase 1a
-- data (Ruling 3): every new column is nullable or has a default, so the
-- existing row stays valid and the screen shows the missing fields as "nije
-- popunjeno". fiscal_mode is stored only; phase 1b uses it for the notice that
-- fiscalisation is not switched on yet.
ALTER TABLE legal_profile
  ADD COLUMN legal_name text,
  ADD COLUMN address text,
  ADD COLUMN postal_code text,
  ADD COLUMN city text,
  ADD COLUMN activity_code text,
  ADD COLUMN bank_account text,
  ADD COLUMN email text,
  ADD COLUMN phone text,
  ADD COLUMN accommodation_category text CHECK (accommodation_category IN
    ('hotel','motel','hostel','guest_house','apartment','room','house','rural_household','other')),
  ADD COLUMN categorization_number text,
  ADD COLUMN fiscal_mode text NOT NULL DEFAULT 'disabled' CHECK (fiscal_mode IN ('required','invoice_only','disabled')),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE legal_profile SET fiscal_mode = CASE kind WHEN 'natural_person' THEN 'disabled' ELSE 'required' END;
