import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/db/migrate';
import { databaseAt, seedPhase1a, type Phase1aSeed } from './upgrade';

// Staging holds real phase 1a data (Ruling 3). One database at 0007 with rows
// shaped like 1a, migrated once to the end; every migration of phase 1b adds
// its own it('00NN: ...') here (preflight F35).
describe('migrations 0008+ on a database holding phase 1a data', () => {
  let pool: Pool;
  let seed: Phase1aSeed;

  beforeAll(async () => {
    pool = await databaseAt('0007', `hotel_upgrade_${process.env.JEST_WORKER_ID ?? '1'}`);
    seed = await seedPhase1a(pool);
    const applied = await migrate(pool);
    expect(applied[0]).toBe('0008_guests.sql');
  });
  afterAll(() => pool.end());

  it('0008: every stay that is not cancelled has its holder as the one primary guest', async () => {
    const { rows } = await pool.query<{ stay_id: string; guest_id: string; is_primary: boolean; property_id: string }>(
      'SELECT stay_id, guest_id, is_primary, property_id FROM stay_guest ORDER BY stay_id',
    );
    expect(rows).toEqual(
      [
        { stay_id: seed.pastStayId, guest_id: seed.pastHolderId, is_primary: true, property_id: seed.propertyId },
        { stay_id: seed.futureStayId, guest_id: seed.futureHolderId, is_primary: true, property_id: seed.propertyId },
      ].sort((a, b) => a.stay_id.localeCompare(b.stay_id)),
    );
    // The cancelled stay exists in the seed and is the one left out.
    const cancelled = await pool.query(`SELECT status FROM stay WHERE id = $1`, [seed.cancelledStayId]);
    expect(cancelled.rows).toEqual([{ status: 'cancelled' }]);
    // guest.note is new and empty for 1a guests.
    const notes = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM guest WHERE note IS NOT NULL`);
    expect(notes.rows[0].n).toBe(0);
  });

  it('0009: one open business day (the property\'s date at migration), a settings row, and stay status no_show', async () => {
    const days = await pool.query<{ property_id: string; day: string; status: string }>(
      'SELECT property_id, day::text AS day, status FROM business_day',
    );
    // Oracle: the database's own Belgrade date, not the service's.
    const { rows: oracle } = await pool.query<{ day: string }>(`SELECT (now() AT TIME ZONE 'Europe/Belgrade')::date::text AS day`);
    expect(days.rows).toEqual([{ property_id: seed.propertyId, day: oracle[0].day, status: 'open' }]);

    const settings = await pool.query(
      'SELECT property_id, auto_close_time, no_show_charge, accommodation_vat_bp, array_to_json(vat_rates_bp) AS vat_rates_bp FROM property_settings',
    );
    expect(settings.rows).toEqual([
      { property_id: seed.propertyId, auto_close_time: null, no_show_charge: 'none', accommodation_vat_bp: null, vat_rates_bp: [] },
    ]);

    // Rolled back: later cases (and tasks) still see the seeded past stay as expected.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ok = await client.query(`UPDATE stay SET status = 'no_show' WHERE id = $1 RETURNING status`, [seed.pastStayId]);
      expect(ok.rows).toEqual([{ status: 'no_show' }]);
      await client.query('SAVEPOINT bad');
      await expect(client.query(`UPDATE stay SET status = 'gone' WHERE id = $1`, [seed.pastStayId])).rejects.toMatchObject({
        constraint: 'stay_status_check',
      });
      await client.query('ROLLBACK TO SAVEPOINT bad');
      // A second open day for the property is refused by the partial unique index.
      await expect(
        client.query(`INSERT INTO business_day (property_id, day, status) VALUES ($1, '2000-01-01', 'open')`, [seed.propertyId]),
      ).rejects.toMatchObject({ constraint: 'business_day_one_open' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const after = await pool.query(`SELECT status, checked_in_at, checked_out_business_date FROM stay WHERE id = $1`, [seed.pastStayId]);
    expect(after.rows).toEqual([{ status: 'expected', checked_in_at: null, checked_out_business_date: null }]);
  });

  it('0010: the folio tables exist and are empty (folios are created lazily); lines and payments are append-only', async () => {
    for (const table of ['folio', 'folio_line', 'payment']) {
      const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      expect({ table, n: rows[0].n }).toEqual({ table, n: 0 });
    }
    // A 1a stay takes a folio, a line and a payment; rolled back so later cases see empty tables.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const folio = await client.query<{ id: string }>(
        `INSERT INTO folio (property_id, stay_id, reservation_id) VALUES ($1, $2, $3) RETURNING id`,
        [seed.propertyId, seed.pastStayId, seed.pastReservationId],
      );
      await client.query(
        `INSERT INTO folio_line (property_id, folio_id, kind, description, amount_minor, business_date, source_type)
         VALUES ($1, $2, 'service', 'Mini bar', 1000, '2026-11-02', 'manual')`,
        [seed.propertyId, folio.rows[0].id],
      );
      await client.query(
        `INSERT INTO payment (property_id, folio_id, method, amount_minor, business_date, idempotency_key, request_hash)
         VALUES ($1, $2, 'cash', 1000, '2026-11-02', 'upgrade-key-1', 'h')`,
        [seed.propertyId, folio.rows[0].id],
      );
      await client.query('SAVEPOINT change');
      await expect(client.query(`UPDATE payment SET amount_minor = 1`)).rejects.toThrow(/append_only/);
      await client.query('ROLLBACK TO SAVEPOINT change');
      await expect(client.query(`DELETE FROM folio_line`)).rejects.toThrow(/append_only/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM folio`);
    expect(rows[0].n).toBe(0);
  });

  it('0011: the 1a legal profile row keeps its ids, gets fiscal_mode required and empty new fields', async () => {
    const { rows } = await pool.query<Record<string, unknown>>(`SELECT * FROM legal_profile WHERE property_id = $1`, [seed.propertyId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'legal_entity',
      tax_id: '100000024',
      registry_id: '12345678',
      vat_payer: true,
      fiscal_mode: 'required',
    });
    for (const column of [
      'legal_name',
      'address',
      'postal_code',
      'city',
      'activity_code',
      'bank_account',
      'email',
      'phone',
      'accommodation_category',
      'categorization_number',
    ]) {
      expect({ column, value: rows[0][column] }).toEqual({ column, value: null });
    }
    expect(rows[0].updated_at).toBeInstanceOf(Date);
    await expect(pool.query(`UPDATE legal_profile SET fiscal_mode = 'sometimes'`)).rejects.toThrow(/legal_profile_fiscal_mode_check/);
    await expect(pool.query(`UPDATE legal_profile SET accommodation_category = 'castle'`)).rejects.toThrow(
      /legal_profile_accommodation_category_check/,
    );
  });

  it('0011: the backfill leaves a natural person without required fiscalisation', async () => {
    // The seed holds a legal entity only; run the migration's own UPDATE over the other kinds.
    const file = readFileSync(join(DEFAULT_MIGRATIONS_DIR, '0011_legal_profile.sql'), 'utf8');
    const backfill = file.split(';').map((statement) => statement.trim()).filter((statement) => statement.startsWith('UPDATE legal_profile'));
    expect(backfill).toHaveLength(1);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // One property per installation: turn the seeded row into a natural person, then backfill it.
      await client.query(`UPDATE legal_profile SET kind = 'natural_person', fiscal_mode = 'required'`);
      await client.query(backfill[0]);
      const { rows } = await client.query<{ kind: string; fiscal_mode: string }>(`SELECT kind, fiscal_mode FROM legal_profile`);
      expect(rows).toEqual([{ kind: 'natural_person', fiscal_mode: 'disabled' }]);
      await client.query(`UPDATE legal_profile SET kind = 'entrepreneur'`);
      await client.query(backfill[0]);
      expect((await client.query(`SELECT fiscal_mode FROM legal_profile`)).rows).toEqual([{ fiscal_mode: 'required' }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
