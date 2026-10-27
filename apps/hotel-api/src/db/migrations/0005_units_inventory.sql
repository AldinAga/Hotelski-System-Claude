-- Units, unit types, unit blocks and the inventory ledger (spec 5.2, 5.7).

CREATE TABLE unit_type (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property (id),
  code text NOT NULL,
  -- {sr, en}; sr is required (checked by the API).
  name jsonb NOT NULL,
  capacity int NOT NULL CHECK (capacity > 0),
  beds text,
  description jsonb,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (property_id, code),
  -- Target of unit's composite key: a unit's type belongs to the unit's property.
  UNIQUE (property_id, id)
);

CREATE TABLE unit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property (id),
  name text NOT NULL,
  unit_type_id uuid,
  address text,
  municipality text,
  eturista_object_id text,
  active boolean NOT NULL DEFAULT true,
  cleanliness text NOT NULL DEFAULT 'clean' CHECK (cleanliness IN ('clean', 'dirty', 'inspected')),
  UNIQUE (property_id, name),
  UNIQUE (property_id, id),
  -- MATCH SIMPLE: a unit without a type (unit_type_id null) passes.
  FOREIGN KEY (property_id, unit_type_id) REFERENCES unit_type (property_id, id)
);

CREATE INDEX unit_unit_type_idx ON unit (unit_type_id);

-- A unit taken out of sale for [lower, upper). Every block holds blocked = 1 in
-- the unit's inventory scope for each of its days (InventoryService.take).
CREATE TABLE unit_block (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property (id),
  unit_id uuid NOT NULL,
  period daterange NOT NULL CHECK (NOT isempty(period) AND NOT lower_inf(period) AND NOT upper_inf(period)),
  reason text NOT NULL CHECK (reason IN ('maintenance', 'owner_use', 'other')),
  note text,
  created_by uuid NOT NULL REFERENCES app_user (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (property_id, unit_id) REFERENCES unit (property_id, id),
  CONSTRAINT unit_block_no_overlap EXCLUDE USING gist (unit_id WITH =, period WITH &&)
);

-- The only source of availability (spec 5.7). One row per scope and night:
-- scope ('unit_type', type id) for units with a type, ('unit', unit id) for a
-- unit without one. Written only by InventoryService (lockDays, take,
-- recomputeTotal). scope_id has no foreign key: it points at either table.
CREATE TABLE inventory_day (
  property_id uuid NOT NULL REFERENCES property (id),
  scope_kind text NOT NULL CHECK (scope_kind IN ('unit_type', 'unit')),
  scope_id uuid NOT NULL,
  day date NOT NULL,
  total int NOT NULL,
  sold int NOT NULL DEFAULT 0,
  blocked int NOT NULL DEFAULT 0,
  PRIMARY KEY (property_id, scope_kind, scope_id, day),
  CONSTRAINT inventory_day_capacity CHECK (sold >= 0 AND blocked >= 0 AND sold + blocked <= total)
);
