-- The business day (spec 5.6), the property's operating settings and the
-- check-in/out columns of a stay. Applies on top of phase 1a data (Ruling 3):
-- only additions and a wider CHECK; the backfill opens today for an existing
-- property. A fresh installation has no property yet: its first writing
-- transaction opens the day (BusinessDayService.lockOpen).

-- One open business day per property; 'closing' is reserved by spec 5.6 but never committed:
-- the close runs in one transaction.
CREATE TABLE business_day (
  property_id uuid NOT NULL REFERENCES property (id),
  day date NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'closing', 'closed')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by uuid REFERENCES app_user (id),
  close_mode text CHECK (close_mode IN ('manual', 'auto')),
  report jsonb,
  last_auto_error jsonb,
  PRIMARY KEY (property_id, day),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL AND report IS NOT NULL AND close_mode IS NOT NULL))
);
CREATE UNIQUE INDEX business_day_one_open ON business_day (property_id) WHERE status <> 'closed';
INSERT INTO business_day (property_id, day, status)
SELECT id, (now() AT TIME ZONE timezone)::date, 'open' FROM property
ON CONFLICT DO NOTHING;

CREATE TABLE property_settings (
  property_id uuid PRIMARY KEY REFERENCES property (id),
  auto_close_time time,                 -- null: no automatic night audit
  no_show_charge text NOT NULL DEFAULT 'none' CHECK (no_show_charge IN ('none', 'first_night')),
  accommodation_vat_bp int CHECK (accommodation_vat_bp BETWEEN 0 AND 10000), -- null: not shown
  vat_rates_bp int[] NOT NULL DEFAULT '{}',  -- rates a manual charge may carry
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO property_settings (property_id) SELECT id FROM property ON CONFLICT DO NOTHING;

-- no_show: a stay whose guest never came (preflight F23a). The exclusion
-- constraint of 0007 covers only 'expected' and 'in_house', so a no-show
-- frees its unit by itself.
ALTER TABLE stay DROP CONSTRAINT stay_status_check;
ALTER TABLE stay ADD CONSTRAINT stay_status_check
  CHECK (status IN ('expected', 'in_house', 'checked_out', 'cancelled', 'no_show'));
-- checked_*_business_date is written under the shared business-day lock and is
-- the night audit's only source for arrival and departure counts.
ALTER TABLE stay
  ADD COLUMN checked_in_at timestamptz,
  ADD COLUMN checked_in_by uuid REFERENCES app_user (id),
  ADD COLUMN checked_in_business_date date,
  ADD COLUMN checked_out_at timestamptz,
  ADD COLUMN checked_out_by uuid REFERENCES app_user (id),
  ADD COLUMN checked_out_business_date date;
