import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { DomainError } from '../src/common/domain-error';
import * as schema from '../src/db/schema';
import type { Tx } from '../src/db/tokens';
import { InventoryService, type Scope } from '../src/inventory/inventory.service';
import { createTestDb, type TestDb } from './db';

// Real Postgres, one transaction (one connection) per simulated sale. The ledger
// must never hold more sold + blocked than total, whatever the interleaving.

const CONCURRENCY = 20;

type Outcome = { ok: true } | { ok: false; error: unknown };

describe('inventory ledger under concurrent sales (e2e)', () => {
  let t: TestDb;
  let pool: Pool; // dedicated, big enough for CONCURRENCY parallel transactions
  let db: NodePgDatabase<typeof schema>;
  let propertyId: string;
  const inv = new InventoryService(() => new Date('2026-11-02T08:00:00Z'));

  beforeAll(async () => {
    t = await createTestDb();
    // Same database as the test pool, but with room for 20+ connections.
    const options = (t.pool as unknown as { options: Record<string, unknown> }).options;
    pool = new Pool({ ...options, max: 25 });
    db = drizzle(pool, { schema });
    // Open every connection up front so the sales start together.
    await Promise.all(Array.from({ length: CONCURRENCY }, () => pool.query('SELECT pg_sleep(0.1)')));
  });
  beforeEach(async () => {
    await t.truncate();
    propertyId = (await t.pool.query<{ id: string }>(`INSERT INTO property (name) VALUES ('Hotel') RETURNING id`))
      .rows[0].id;
  });
  afterAll(async () => {
    await pool.end();
    await t.close();
  });

  async function seedType(code: string, units: number): Promise<Scope> {
    const { rows } = await t.pool.query<{ id: string }>(
      `INSERT INTO unit_type (property_id, code, name, capacity) VALUES ($1, $2, '{"sr":"Soba"}', 2) RETURNING id`,
      [propertyId, code],
    );
    for (let i = 0; i < units; i++) {
      await t.pool.query(`INSERT INTO unit (property_id, name, unit_type_id) VALUES ($1, $2, $3)`, [
        propertyId,
        `${code}-${i}`,
        rows[0].id,
      ]);
    }
    return { kind: 'unit_type', id: rows[0].id };
  }

  async function seedLooseUnit(name: string): Promise<Scope> {
    const { rows } = await t.pool.query<{ id: string }>(
      `INSERT INTO unit (property_id, name) VALUES ($1, $2) RETURNING id`,
      [propertyId, name],
    );
    return { kind: 'unit', id: rows[0].id };
  }

  async function ledger(scope: Scope): Promise<Array<{ day: string; total: number; sold: number; blocked: number }>> {
    const { rows } = await t.pool.query(
      `SELECT day::text AS day, total, sold, blocked FROM inventory_day
        WHERE scope_kind = $1 AND scope_id = $2 ORDER BY day`,
      [scope.kind, scope.id],
    );
    return rows;
  }

  /** Each sale in its own transaction on its own connection; never throws. */
  function sale(fn: (x: Tx) => Promise<void>): Promise<Outcome> {
    return db.transaction((x) => fn(x as unknown as Tx)).then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
  }

  function failures(outcomes: Outcome[]): unknown[] {
    return outcomes.flatMap((o) => (o.ok ? [] : [o.error]));
  }

  it('20 parallel take(sold, +1) on a type with total = 5 for 3 nights: exactly 5 succeed, 15 get no_availability', async () => {
    const scope = await seedType('DBL', 5);

    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        sale((x) => inv.take(x, propertyId, scope, '2026-11-10', '2026-11-13', 'sold', 1)),
      ),
    );

    const failed = failures(outcomes);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(5);
    expect(failed).toHaveLength(15);
    for (const e of failed) {
      expect(e).toBeInstanceOf(DomainError);
      expect(e).toMatchObject({ code: 'no_availability', status: 409 });
    }
    // The ledger is the oracle: every night sold exactly the 5 units, never more.
    expect(await ledger(scope)).toEqual([
      { day: '2026-11-10', total: 5, sold: 5, blocked: 0 },
      { day: '2026-11-11', total: 5, sold: 5, blocked: 0 },
      { day: '2026-11-12', total: 5, sold: 5, blocked: 0 },
    ]);
  });

  it('overlapping ranges taken in opposite directions do not deadlock (both finish in < 5 s)', async () => {
    jest.setTimeout(15_000);
    // Per round: A takes [10, 13), B takes [11, 14); each one's first night is
    // inside the other's range, the shape that deadlocks when rows are locked
    // in arrival order. Several rounds on separate types run at once.
    const rounds = 10;
    const scopes: Scope[] = [];
    for (let i = 0; i < rounds; i++) scopes.push(await seedType(`T${i}`, 3));

    const started = Date.now();
    const outcomes = await Promise.all(
      scopes.flatMap((scope) => [
        sale((x) => inv.take(x, propertyId, scope, '2026-11-10', '2026-11-13', 'sold', 1)),
        sale((x) => inv.take(x, propertyId, scope, '2026-11-11', '2026-11-14', 'sold', 1)),
      ]),
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5_000);
    expect(outcomes).toHaveLength(rounds * 2);
    for (const e of failures(outcomes)) {
      // The only acceptable refusal is a business one; 40P01 is a deadlock.
      expect((e as { code?: string }).code).not.toBe('40P01');
      expect(e).toMatchObject({ code: 'no_availability' });
    }
    // total = 3, two sales: both fit, so both must have succeeded.
    expect(outcomes.every((o) => o.ok)).toBe(true);
    for (const scope of scopes) {
      expect(await ledger(scope)).toEqual([
        { day: '2026-11-10', total: 3, sold: 1, blocked: 0 },
        { day: '2026-11-11', total: 3, sold: 2, blocked: 0 },
        { day: '2026-11-12', total: 3, sold: 2, blocked: 0 },
        { day: '2026-11-13', total: 3, sold: 1, blocked: 0 },
      ]);
    }
  }, 15_000);

  it('a sale and a block of the same night in parallel on total = 1: exactly one wins', async () => {
    const rounds = 10;
    const units: Scope[] = [];
    for (let i = 0; i < rounds; i++) units.push(await seedLooseUnit(`Apartman ${i}`));

    const outcomes = await Promise.all(
      units.flatMap((scope) => [
        sale((x) => inv.take(x, propertyId, scope, '2026-11-20', '2026-11-21', 'sold', 1)),
        sale((x) => inv.take(x, propertyId, scope, '2026-11-20', '2026-11-21', 'blocked', 1)),
      ]),
    );

    for (let i = 0; i < rounds; i++) {
      const pair = [outcomes[i * 2], outcomes[i * 2 + 1]];
      expect(pair.filter((o) => o.ok)).toHaveLength(1);
      const loser = pair.find((o) => !o.ok) as { ok: false; error: unknown };
      expect(loser.error).toBeInstanceOf(DomainError);
      expect(loser.error).toMatchObject({ code: 'no_availability', status: 409, details: { day: '2026-11-20' } });

      const rows = await ledger(units[i]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ day: '2026-11-20', total: 1 });
      // Exactly one unit consumed, in the column of the winner.
      expect(rows[0].sold + rows[0].blocked).toBe(1);
      expect(rows[0].sold).toBe(pair[0].ok ? 1 : 0);
      expect(rows[0].blocked).toBe(pair[1].ok ? 1 : 0);
    }
  });
});
