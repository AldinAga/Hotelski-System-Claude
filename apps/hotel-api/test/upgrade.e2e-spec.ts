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
});
