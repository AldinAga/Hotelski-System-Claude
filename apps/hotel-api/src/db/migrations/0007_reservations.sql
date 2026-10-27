-- Guests, reservations, stays and the agreed price of every night (spec 5.4, 5.7).
-- Every booking source goes through ReservationsService.book.

-- Fields for e-Turista (documents, citizenship, ...) arrive in phase 1c.
CREATE TABLE guest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property (id),
  first_name text NOT NULL,
  last_name text NOT NULL,
  email citext,
  phone text,
  language text NOT NULL DEFAULT 'sr',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, id)
);

CREATE TABLE reservation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property (id),
  -- R-{year of the first stay's arrival}-{6 digits}, from reservation_counter.
  number text NOT NULL,
  source text NOT NULL CHECK (source IN ('front_desk', 'phone', 'website', 'widget', 'api', 'ota')),
  channel text,
  external_id text,
  holder_guest_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('requested', 'confirmed', 'cancelled', 'no_show')),
  guarantee text,
  note text,
  -- Optimistic concurrency: every change checks and bumps it.
  version int NOT NULL DEFAULT 1,
  -- Null for a source without a signed-in user (website, OTA; later phases).
  created_by uuid REFERENCES app_user (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, number),
  UNIQUE (property_id, id),
  -- The idempotency key (channel, external_id) needs both halves: a null
  -- channel would never collide in the unique index below.
  CHECK (external_id IS NULL OR channel IS NOT NULL),
  FOREIGN KEY (property_id, holder_guest_id) REFERENCES guest (property_id, id)
);

CREATE UNIQUE INDEX reservation_external_idx ON reservation (property_id, channel, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE reservation_counter (
  property_id uuid NOT NULL REFERENCES property (id),
  year int NOT NULL,
  last int NOT NULL,
  PRIMARY KEY (property_id, year)
);

-- One room-stay of a reservation. Its inventory scope is fixed by what it
-- stores: unit_type_id when set, otherwise the unit (a unit without a type).
-- That scope is where book took sold = 1 for each night, and where cancel
-- gives it back.
CREATE TABLE stay (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property (id),
  reservation_id uuid NOT NULL,
  unit_type_id uuid,
  unit_id uuid,
  arrival date NOT NULL,
  departure date NOT NULL,
  adults int NOT NULL CHECK (adults >= 1),
  children int NOT NULL DEFAULT 0 CHECK (children >= 0),
  rate_plan_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('expected', 'in_house', 'checked_out', 'cancelled')),
  CHECK (departure > arrival),
  CHECK (unit_type_id IS NOT NULL OR unit_id IS NOT NULL),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, reservation_id) REFERENCES reservation (property_id, id),
  FOREIGN KEY (property_id, unit_type_id) REFERENCES unit_type (property_id, id),
  FOREIGN KEY (property_id, unit_id) REFERENCES unit (property_id, id),
  FOREIGN KEY (property_id, rate_plan_id) REFERENCES rate_plan (property_id, id),
  -- A unit holds at most one live stay per night.
  CONSTRAINT stay_unit_no_overlap EXCLUDE USING gist (unit_id WITH =, daterange(arrival, departure) WITH &&)
    WHERE (unit_id IS NOT NULL AND status IN ('expected', 'in_house'))
);

CREATE INDEX stay_reservation_idx ON stay (reservation_id);
CREATE INDEX stay_dates_idx ON stay (property_id, arrival, departure);

-- The price agreed for each night at booking time (after the plan discount).
-- Later changes to the price list never touch it.
CREATE TABLE stay_night (
  stay_id uuid NOT NULL,
  property_id uuid NOT NULL REFERENCES property (id),
  day date NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  rate_plan_id uuid NOT NULL,
  PRIMARY KEY (stay_id, day),
  FOREIGN KEY (property_id, stay_id) REFERENCES stay (property_id, id),
  FOREIGN KEY (property_id, rate_plan_id) REFERENCES rate_plan (property_id, id)
);
