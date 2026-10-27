-- The base price list (spec 5.3): rate plans and per-day prices per scope.
-- min_stay, cta, ctd and derived_from_id arrive with hotel.rates_advanced.

CREATE TABLE rate_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property (id),
  code text NOT NULL,
  -- {sr, en}; sr is required (checked by the API).
  name jsonb NOT NULL,
  board text NOT NULL DEFAULT 'RO' CHECK (board IN ('RO', 'BB', 'HB', 'FB')),
  cancellation_policy jsonb,
  -- Percent off each night of a stay of at least 7 / 30 nights.
  discount_7_pct int NOT NULL DEFAULT 0 CHECK (discount_7_pct BETWEEN 0 AND 100),
  discount_30_pct int NOT NULL DEFAULT 0 CHECK (discount_30_pct BETWEEN 0 AND 100),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (property_id, code),
  -- Target of rate_day's composite key: a day's plan belongs to the day's property.
  UNIQUE (property_id, id)
);

-- One row per plan, scope and night. A night without a row has no price. A
-- row may carry only closed (price_minor null) so that closing a night does
-- not need a price. scope_id has no foreign key: it points at unit_type or unit.
CREATE TABLE rate_day (
  property_id uuid NOT NULL REFERENCES property (id),
  rate_plan_id uuid NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('unit_type', 'unit')),
  scope_id uuid NOT NULL,
  day date NOT NULL,
  price_minor bigint CHECK (price_minor >= 0),
  closed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (property_id, rate_plan_id, scope_kind, scope_id, day),
  FOREIGN KEY (property_id, rate_plan_id) REFERENCES rate_plan (property_id, id)
);
