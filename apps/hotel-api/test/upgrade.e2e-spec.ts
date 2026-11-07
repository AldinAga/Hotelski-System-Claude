import type { Pool } from 'pg';
import { migrate } from '../src/db/migrate';
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
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const after = await pool.query(`SELECT status, checked_in_at, checked_out_business_date FROM stay WHERE id = $1`, [seed.pastStayId]);
    expect(after.rows).toEqual([{ status: 'expected', checked_in_at: null, checked_out_business_date: null }]);
  });
});
