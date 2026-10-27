import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createTestDb, type TestDb } from '../../test/db';
import { DomainError } from '../common/domain-error';
import * as schema from '../db/schema';
import type { Tx } from '../db/tokens';
import { InventoryService, type Scope } from './inventory.service';

// Belgrade is UTC+1 in November: 08:00 UTC on 2 Nov is 09:00 local, same date.
const MORNING = new Date('2026-11-02T08:00:00Z');
const TODAY = '2026-11-02';

describe('InventoryService', () => {
  let t: TestDb;
  let now: Date;
  const inv = new InventoryService(() => now);
  let propertyId: string;

  beforeAll(async () => {
    t = await createTestDb();
  });
  beforeEach(async () => {
    await t.truncate();
    now = MORNING;
    propertyId = (await t.pool.query<{ id: string }>(`INSERT INTO property (name) VALUES ('Hotel') RETURNING id`))
      .rows[0].id;
  });
  afterAll(async () => {
    await t.close();
  });

  async function seedType(code: string): Promise<string> {
    const { rows } = await t.pool.query<{ id: string }>(
      `INSERT INTO unit_type (property_id, code, name, capacity) VALUES ($1, $2, '{"sr":"Soba"}', 2) RETURNING id`,
      [propertyId, code],
    );
    return rows[0].id;
  }

  async function seedUnit(name: string, typeId: string | null, active = true): Promise<string> {
    const { rows } = await t.pool.query<{ id: string }>(
      `INSERT INTO unit (property_id, name, unit_type_id, active) VALUES ($1, $2, $3, $4) RETURNING id`,
      [propertyId, name, typeId, active],
    );
    return rows[0].id;
  }

  const tx = <T>(fn: (x: Tx) => Promise<T>): Promise<T> => t.db.transaction(fn);

  async function ledger(scope: Scope): Promise<Array<{ day: string; total: number; sold: number; blocked: number }>> {
    const { rows } = await t.pool.query(
      `SELECT day::text AS day, total, sold, blocked FROM inventory_day
        WHERE scope_kind = $1 AND scope_id = $2 ORDER BY day`,
      [scope.kind, scope.id],
    );
    return rows;
  }

  describe('lockDays', () => {
    it('a type with 3 active units: total = 3 for a new day (inactive and other-type units do not count)', async () => {
      const type = await seedType('DBL');
      const other = await seedType('SGL');
      await seedUnit('101', type);
      await seedUnit('102', type);
      await seedUnit('103', type);
      await seedUnit('104', type, false);
      await seedUnit('201', other);
      await seedUnit('301', null);

      const days = await tx((x) => inv.lockDays(x, propertyId, { kind: 'unit_type', id: type }, '2026-11-10', '2026-11-13'));

      // `to` is exclusive: three nights, in day order.
      expect(days).toEqual([
        { day: '2026-11-10', total: 3, sold: 0, blocked: 0 },
        { day: '2026-11-11', total: 3, sold: 0, blocked: 0 },
        { day: '2026-11-12', total: 3, sold: 0, blocked: 0 },
      ]);
      expect(await ledger({ kind: 'unit_type', id: type })).toHaveLength(3);
    });

    it('a unit without a type: total = 1', async () => {
      const u = await seedUnit('Apartman 1', null);
      const days = await tx((x) => inv.lockDays(x, propertyId, { kind: 'unit', id: u }, '2026-11-10', '2026-11-11'));
      expect(days).toEqual([{ day: '2026-11-10', total: 1, sold: 0, blocked: 0 }]);
    });

    it('keeps existing rows as they are (no overwrite of sold or total)', async () => {
      const type = await seedType('DBL');
      await seedUnit('101', type);
      const scope: Scope = { kind: 'unit_type', id: type };
      await tx((x) => inv.take(x, propertyId, scope, '2026-11-10', '2026-11-11', 'sold', 1));
      await seedUnit('102', type); // no recompute: the stored total stays 1

      const days = await tx((x) => inv.lockDays(x, propertyId, scope, '2026-11-10', '2026-11-12'));
      expect(days).toEqual([
        { day: '2026-11-10', total: 1, sold: 1, blocked: 0 },
        { day: '2026-11-11', total: 2, sold: 0, blocked: 0 },
      ]);
    });

    it('refuses an empty or reversed range', async () => {
      const u = await seedUnit('A', null);
      await expect(
        tx((x) => inv.lockDays(x, propertyId, { kind: 'unit', id: u }, '2026-11-10', '2026-11-10')),
      ).rejects.toThrow(/range/);
    });

    it('a scope whose type or unit is not in the property: 404 scope_not_found, no rows inserted', async () => {
      const missing = '00000000-0000-4000-8000-000000000000';
      for (const kind of ['unit_type', 'unit'] as const) {
        const err = await tx((x) => inv.lockDays(x, propertyId, { kind, id: missing }, '2026-11-10', '2026-11-11')).catch(
          (e) => e,
        );
        expect(err).toBeInstanceOf(DomainError);
        expect(err).toMatchObject({ code: 'scope_not_found', status: 404, details: { kind, id: missing } });
      }
      // Positive control: the same call for a scope that exists works.
      const u = await seedUnit('A', null);
      await tx((x) => inv.lockDays(x, propertyId, { kind: 'unit', id: u }, '2026-11-10', '2026-11-11'));
      expect((await t.pool.query('SELECT scope_id FROM inventory_day')).rows).toEqual([{ scope_id: u }]);
    });

    it('a day inserted by a booking racing a deactivation ends with the new total (scope lock)', async () => {
      const type = await seedType('DBL');
      const a = await seedUnit('101', type);
      await seedUnit('102', type);
      await seedUnit('103', type);
      const scope: Scope = { kind: 'unit_type', id: type };
      const cb = await t.pool.connect();
      const ca = await t.pool.connect();
      let settled = false;
      try {
        const xb = drizzle(cb, { schema }) as unknown as Tx;
        const xa = drizzle(ca, { schema }) as unknown as Tx;
        const pidA = (await ca.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;

        // (1) B inserts the new day (counting 3 units) and stays open.
        await cb.query('BEGIN');
        const booked = await inv.lockDays(xb, propertyId, scope, '2026-11-20', '2026-11-21');
        expect(booked).toEqual([{ day: '2026-11-20', total: 3, sold: 0, blocked: 0 }]);

        // (2) A deactivates a unit and recomputes, not awaited.
        await ca.query('BEGIN');
        const aDone = (async () => {
          await ca.query('UPDATE unit SET active = false WHERE id = $1', [a]);
          await inv.recomputeTotal(xa, propertyId, scope);
          await ca.query('COMMIT');
          return 'finished' as const;
        })().finally(() => {
          settled = true;
        });
        // Go on only once A is waiting on a lock or has finished, so the
        // outcome does not depend on timing.
        const aWaits = (async () => {
          while (!settled) {
            const r = await t.pool.query('SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted', [pidA]);
            if (r.rowCount) return 'waiting' as const;
            await new Promise((res) => setTimeout(res, 20));
          }
          return 'finished' as const;
        })();
        await Promise.race([aDone, aWaits]);

        // (3) B commits, then A completes.
        await cb.query('COMMIT');
        await aDone;
      } finally {
        settled = true;
        await cb.query('ROLLBACK').catch(() => undefined);
        await ca.query('ROLLBACK').catch(() => undefined);
        cb.release();
        ca.release();
      }

      // (4) The day B inserted carries the total after the deactivation.
      expect(await ledger(scope)).toEqual([{ day: '2026-11-20', total: 2, sold: 0, blocked: 0 }]);
    });
  });

  describe('take', () => {
    it('adds to the column for every night and refuses the first full night with no_availability', async () => {
      const type = await seedType('DBL');
      await seedUnit('101', type);
      await seedUnit('102', type);
      const scope: Scope = { kind: 'unit_type', id: type };
      await tx((x) => inv.take(x, propertyId, scope, '2026-11-11', '2026-11-12', 'sold', 1));
      await tx((x) => inv.take(x, propertyId, scope, '2026-11-11', '2026-11-13', 'blocked', 1));
      // 11 Nov is now full (1 sold + 1 blocked = 2), 12 Nov has room.

      const err = await tx((x) => inv.take(x, propertyId, scope, '2026-11-10', '2026-11-13', 'sold', 1)).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(DomainError);
      expect(err).toMatchObject({ code: 'no_availability', status: 409, details: { day: '2026-11-11' } });
      expect(await ledger(scope)).toEqual([
        { day: '2026-11-11', total: 2, sold: 1, blocked: 1 },
        { day: '2026-11-12', total: 2, sold: 0, blocked: 1 },
      ]);
    });

    it('-1 gives the nights back', async () => {
      const u = await seedUnit('A', null);
      const scope: Scope = { kind: 'unit', id: u };
      await tx((x) => inv.take(x, propertyId, scope, '2026-11-10', '2026-11-12', 'blocked', 1));
      await tx((x) => inv.take(x, propertyId, scope, '2026-11-10', '2026-11-12', 'blocked', -1));
      expect(await ledger(scope)).toEqual([
        { day: '2026-11-10', total: 1, sold: 0, blocked: 0 },
        { day: '2026-11-11', total: 1, sold: 0, blocked: 0 },
      ]);
    });
  });

  describe('recomputeTotal', () => {
    it('sets total from the active units for days from today on; past days keep theirs', async () => {
      const type = await seedType('DBL');
      await seedUnit('101', type);
      const scope: Scope = { kind: 'unit_type', id: type };
      await tx((x) => inv.lockDays(x, propertyId, scope, '2026-11-01', '2026-11-04'));
      await seedUnit('102', type);

      await tx((x) => inv.recomputeTotal(x, propertyId, scope));

      expect((await ledger(scope)).map((d) => [d.day, d.total])).toEqual([
        ['2026-11-01', 1],
        ['2026-11-02', 2],
        ['2026-11-03', 2],
      ]);
    });

    it('refuses with 409 inventory_conflict naming the first day where sold + blocked would exceed the new total', async () => {
      const type = await seedType('DBL');
      const a = await seedUnit('101', type);
      await seedUnit('102', type);
      const scope: Scope = { kind: 'unit_type', id: type };
      await tx((x) => inv.take(x, propertyId, scope, '2026-11-05', '2026-11-06', 'sold', 1));
      await tx((x) => inv.take(x, propertyId, scope, '2026-11-07', '2026-11-08', 'sold', 1));
      await tx((x) => inv.take(x, propertyId, scope, '2026-11-07', '2026-11-08', 'blocked', 1));

      const err = await tx(async (x) => {
        await x.execute(sql`UPDATE unit SET active = false WHERE id = ${a}`);
        await inv.recomputeTotal(x, propertyId, scope);
      }).catch((e) => e);

      expect(err).toBeInstanceOf(DomainError);
      expect(err).toMatchObject({ code: 'inventory_conflict', status: 409, details: { day: '2026-11-07' } });
      expect((await ledger(scope)).map((d) => d.total)).toEqual([2, 2]);
    });

    it('"today" is the property-local date: 23:30 UTC on 1 Nov is already 2 Nov in Belgrade', async () => {
      now = new Date('2026-11-01T23:30:00Z');
      const u = await seedUnit('A', null);
      const scope: Scope = { kind: 'unit', id: u };
      await tx((x) => inv.take(x, propertyId, scope, '2026-11-01', '2026-11-02', 'sold', 1));
      await t.pool.query(`UPDATE unit SET active = false WHERE id = $1`, [u]);

      // 1 Nov is yesterday in Belgrade: not recomputed, so no conflict.
      await tx((x) => inv.recomputeTotal(x, propertyId, scope));
      expect(await ledger(scope)).toEqual([{ day: '2026-11-01', total: 1, sold: 1, blocked: 0 }]);

      // Positive control: in UTC terms it would still be 1 Nov and conflict.
      await t.pool.query(`UPDATE property SET timezone = 'UTC'`);
      const err = await tx((x) => inv.recomputeTotal(x, propertyId, scope)).catch((e) => e);
      expect(err).toMatchObject({ code: 'inventory_conflict', details: { day: '2026-11-01' } });
    });

    it(`today() is ${TODAY} for the morning clock`, async () => {
      expect(await tx((x) => inv.today(x, propertyId))).toBe(TODAY);
    });
  });

  describe('scopeOfUnit', () => {
    it('a typed unit consumes its type, an untyped unit itself', async () => {
      const type = await seedType('DBL');
      const typed = await seedUnit('101', type);
      const loose = await seedUnit('A', null);
      expect(await tx((x) => inv.scopeOfUnit(x, propertyId, typed))).toEqual({ kind: 'unit_type', id: type });
      expect(await tx((x) => inv.scopeOfUnit(x, propertyId, loose))).toEqual({ kind: 'unit', id: loose });
    });

    it('a unit outside the given property is not found', async () => {
      const u = await seedUnit('101', null);
      const otherProperty = '00000000-0000-4000-8000-000000000000';
      await expect(tx((x) => inv.scopeOfUnit(x, otherProperty, u))).rejects.toThrow(/not found/);
    });
  });
});
