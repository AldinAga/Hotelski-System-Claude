import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/db/migrate';
import { createScratchPool } from './db';

// Upgrade checks (Ruling 3): staging holds real phase 1a data, so every
// migration of phase 1b must apply on top of it. These helpers build such a
// database: migrated up to a given file, then filled with rows shaped like the
// ones phase 1a writes.

/** A query function: a Pool (`(t, p) => pool.query(t, p).then(r => r.rows)`) or the front desk's `fd.sql`. */
export type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

export function queryOf(pool: Pool): Query {
  return async <T>(text: string, params?: unknown[]) => (await pool.query(text, params)).rows as T[];
}

/**
 * A scratch database migrated with 0001..`upTo` only. Copies those files (same
 * names, so a later migrate(pool) skips them) to a temp dir and calls
 * migrate(pool, dir).
 */
export async function databaseAt(upTo: string, name: string): Promise<Pool> {
  const files = readdirSync(DEFAULT_MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => f.slice(0, upTo.length) <= upTo);
  if (!files.some((f) => f.startsWith(upTo))) throw new Error(`upgrade: no migration ${upTo}`);
  const dir = mkdtempSync(join(tmpdir(), 'hotel-upgrade-'));
  try {
    for (const f of files) copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
    const pool = await createScratchPool(name);
    const applied = await migrate(pool, dir);
    if (applied.length !== files.length) throw new Error(`upgrade: applied ${applied.length} of ${files.length}`);
    return pool;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Sells the nights [from, to) of an existing stay the way book leaves them:
 * a stay_night row per night (priceMinor, the stay's plan) and sold + 1 in the
 * stay's inventory scope (its unit type when set, else its unit), creating the
 * inventory_day row with the total InventoryService would compute.
 *
 * Used by seedPhase1a and by later specs that move a booked stay's arrival
 * into the past (preflight F4): moving only `arrival` would leave nights that
 * were never sold, and giving them back (take -1) then fails.
 */
export async function occupyNights(q: Query, stayId: string, from: string, to: string, priceMinor = 1_000_000): Promise<void> {
  const nights = `generate_series($2::date, $3::date - 1, interval '1 day') AS d`;
  const inserted = await q<{ day: string }>(
    `INSERT INTO stay_night (stay_id, property_id, day, price_minor, rate_plan_id)
     SELECT s.id, s.property_id, d::date, $4, s.rate_plan_id FROM stay s, ${nights} WHERE s.id = $1
     RETURNING day::text AS day`,
    [stayId, from, to, priceMinor],
  );
  if (inserted.length === 0) throw new Error(`upgrade: no nights for stay ${stayId} in [${from}, ${to})`);
  await q(
    `INSERT INTO inventory_day (property_id, scope_kind, scope_id, day, total, sold)
     SELECT s.property_id,
            CASE WHEN s.unit_type_id IS NOT NULL THEN 'unit_type' ELSE 'unit' END,
            coalesce(s.unit_type_id, s.unit_id),
            d::date,
            CASE WHEN s.unit_type_id IS NOT NULL
                 THEN (SELECT count(*)::int FROM unit u
                        WHERE u.property_id = s.property_id AND u.unit_type_id = s.unit_type_id AND u.active)
                 ELSE (SELECT count(*)::int FROM unit u
                        WHERE u.property_id = s.property_id AND u.id = s.unit_id AND u.unit_type_id IS NULL AND u.active)
            END,
            1
       FROM stay s, ${nights}
      WHERE s.id = $1
     ON CONFLICT (property_id, scope_kind, scope_id, day) DO UPDATE SET sold = inventory_day.sold + 1`,
    [stayId, from, to],
  );
}

export interface Phase1aSeed {
  propertyId: string;
  ownerId: string;
  unitTypeId: string;
  unitIds: [string, string];
  ratePlanId: string;
  /** Confirmed, one expected stay on unit 1, arriving 2026-10-30 (in the past), leaving 2026-11-03. */
  pastReservationId: string;
  pastStayId: string;
  pastHolderId: string;
  /** Confirmed, one expected stay on the type, 2026-11-05..2026-11-07. */
  futureReservationId: string;
  futureStayId: string;
  futureHolderId: string;
  /** Cancelled, its stay cancelled (nights given back), 2026-11-10..2026-11-12. */
  cancelledReservationId: string;
  cancelledStayId: string;
  cancelledHolderId: string;
}

/**
 * Rows shaped like phase 1a data: property, legal_profile (legal_entity, only
 * the 1a fields), an owner, a unit type with 2 units, a plan, a confirmed
 * reservation with an expected stay arriving 2026-10-30 (past) on unit 1, a
 * confirmed one arriving 2026-11-05, a cancelled one; inventory_day sold rows
 * as book and cancel would leave them, reservation_counter and audit rows.
 */
export async function seedPhase1a(pool: Pool): Promise<Phase1aSeed> {
  const q = queryOf(pool);
  const one = async (text: string, params: unknown[] = []): Promise<string> => (await q<{ id: string }>(text, params))[0].id;

  const propertyId = await one(`INSERT INTO property (name) VALUES ('Demo Hotel 1a') RETURNING id`);
  await q(`INSERT INTO legal_profile (property_id, kind, tax_id, registry_id, vat_payer) VALUES ($1, 'legal_entity', '100000024', '12345678', true)`, [
    propertyId,
  ]);
  const ownerId = await one(
    `INSERT INTO app_user (property_id, email, name, role, password_hash, totp_state, active)
     VALUES ($1, 'vlasnik@hotel.test', 'Vlasnik', 'owner', 'x', 'none', true) RETURNING id`,
    [propertyId],
  );
  const unitTypeId = await one(
    `INSERT INTO unit_type (property_id, code, name, capacity) VALUES ($1, 'DBL', '{"sr":"Dvokrevetna"}', 2) RETURNING id`,
    [propertyId],
  );
  const unit1 = await one(`INSERT INTO unit (property_id, name, unit_type_id) VALUES ($1, '101', $2) RETURNING id`, [propertyId, unitTypeId]);
  const unit2 = await one(`INSERT INTO unit (property_id, name, unit_type_id) VALUES ($1, '102', $2) RETURNING id`, [propertyId, unitTypeId]);
  const ratePlanId = await one(`INSERT INTO rate_plan (property_id, code, name) VALUES ($1, 'BAR', '{"sr":"Osnovna"}') RETURNING id`, [propertyId]);

  let counter = 0;
  async function reservation(
    holder: [string, string, string],
    status: 'confirmed' | 'cancelled',
    stay: { unitId: string | null; arrival: string; departure: string; status: 'expected' | 'cancelled' },
  ) {
    const holderId = await one(
      `INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, $2, $3, $4) RETURNING id`,
      [propertyId, ...holder],
    );
    counter += 1;
    const reservationId = await one(
      `INSERT INTO reservation (property_id, number, source, holder_guest_id, status, version, created_by)
       VALUES ($1, $2, 'front_desk', $3, $4, $5, $6) RETURNING id`,
      [propertyId, `R-2026-${String(counter).padStart(6, '0')}`, holderId, status, status === 'cancelled' ? 2 : 1, ownerId],
    );
    const stayId = await one(
      `INSERT INTO stay (property_id, reservation_id, unit_type_id, unit_id, arrival, departure, adults, rate_plan_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 2, $7, 'expected') RETURNING id`,
      [propertyId, reservationId, unitTypeId, stay.unitId, stay.arrival, stay.departure, ratePlanId],
    );
    // book: nights priced and sold; cancel gives the nights back and keeps stay_night.
    await occupyNights(q, stayId, stay.arrival, stay.departure);
    if (stay.status === 'cancelled') {
      await q(`UPDATE stay SET status = 'cancelled' WHERE id = $1`, [stayId]);
      await q(
        `UPDATE inventory_day SET sold = sold - 1
          WHERE property_id = $1 AND scope_kind = 'unit_type' AND scope_id = $2 AND day >= $3::date AND day < $4::date`,
        [propertyId, unitTypeId, stay.arrival, stay.departure],
      );
    }
    await q(
      `INSERT INTO audit_log (property_id, actor_user_id, action, entity, entity_id, after)
       VALUES ($1, $2, 'reservation.create', 'reservation', $3, '{}')`,
      [propertyId, ownerId, reservationId],
    );
    return { reservationId, stayId, holderId };
  }

  const past = await reservation(['Ana', 'Anić', 'ana@example.com'], 'confirmed', {
    unitId: unit1,
    arrival: '2026-10-30',
    departure: '2026-11-03',
    status: 'expected',
  });
  const future = await reservation(['Marko', 'Marković', 'marko@example.com'], 'confirmed', {
    unitId: null,
    arrival: '2026-11-05',
    departure: '2026-11-07',
    status: 'expected',
  });
  const cancelled = await reservation(['Jovana', 'Jović', 'jovana@example.com'], 'cancelled', {
    unitId: null,
    arrival: '2026-11-10',
    departure: '2026-11-12',
    status: 'cancelled',
  });
  await q(`INSERT INTO reservation_counter (property_id, year, last) VALUES ($1, 2026, $2)`, [propertyId, counter]);

  return {
    propertyId,
    ownerId,
    unitTypeId,
    unitIds: [unit1, unit2],
    ratePlanId,
    pastReservationId: past.reservationId,
    pastStayId: past.stayId,
    pastHolderId: past.holderId,
    futureReservationId: future.reservationId,
    futureStayId: future.stayId,
    futureHolderId: future.holderId,
    cancelledReservationId: cancelled.reservationId,
    cancelledStayId: cancelled.stayId,
    cancelledHolderId: cancelled.holderId,
  };
}
