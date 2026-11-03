-- The guests of each stay (spec 5.4): the holder is the primary guest, the
-- front desk adds the others. Applies on top of phase 1a data (Ruling 3):
-- only additions, and the backfill below gives every live 1a stay its holder.
-- Fields for e-Turista (sex, birth date, citizenship, document, address,
-- eturista_status) arrive in phase 1c.

ALTER TABLE guest ADD COLUMN note text;

CREATE TABLE stay_guest (
  property_id uuid NOT NULL REFERENCES property (id),
  stay_id uuid NOT NULL,
  guest_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  -- Ordering only (who was added first); never compared with "now".
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stay_id, guest_id),
  FOREIGN KEY (property_id, stay_id) REFERENCES stay (property_id, id),
  FOREIGN KEY (property_id, guest_id) REFERENCES guest (property_id, id)
);

-- At most one primary guest per stay.
CREATE UNIQUE INDEX stay_guest_one_primary ON stay_guest (stay_id) WHERE is_primary;
CREATE INDEX stay_guest_guest_idx ON stay_guest (guest_id);

-- Backfill: the holder is the primary guest of every stay that is not cancelled.
INSERT INTO stay_guest (property_id, stay_id, guest_id, is_primary)
SELECT s.property_id, s.id, r.holder_guest_id, true
  FROM stay s JOIN reservation r ON r.id = s.reservation_id AND r.property_id = s.property_id
 WHERE s.status <> 'cancelled'
ON CONFLICT DO NOTHING;
