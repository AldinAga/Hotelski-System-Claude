import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { DomainError } from '../src/common/domain-error';
import * as schema from '../src/db/schema';
import type { Tx } from '../src/db/tokens';
import { InventoryService, type Scope } from '../src/inventory/inventory.service';
import { createTestDb, type TestDb } from './db';

// Real Postgres, one transaction (one connection) per simulated sale. The ledger
// must never hold more sold + blocked than total, whatever the interleaving.
// Interleavings are forced with pg_locks (a contender is let in only once the
// others are provably queued), not left to timing.

const CONCURRENCY = 20;
const WAIT_MS = 3_000;

type Outcome = { ok: true } | { ok: false; error: unknown };

const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

describe('inventory ledger under concurrent sales (e2e)', () => {
  let t: TestDb;
  let pool: Pool; // dedicated, big enough for CONCURRENCY parallel transactions
  let db: NodePgDatabase<typeof schema>;
  let propertyId: string;
  const inv = new InventoryService(() => new Date('2026-11-02T08:00:00Z'));

  beforeAll(async () => {
    t = await createTestDb();
    pool = new Pool({ connectionString: t.connectionString, max: 25 });
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

  /**
   * Commits the day rows up front, so the contenders find them already there:
   * otherwise the first inserter's uncommitted row would serialise everyone
   * on the INSERT and hide whether the later row lock does its job.
   */
  async function seedDays(scope: Scope, from: string, to: string): Promise<void> {
    await t.db.transaction((x) => inv.lockDays(x as unknown as Tx, propertyId, scope, from, to));
  }

  async function ledger(scope: Scope): Promise<Array<{ day: string; total: number; sold: number; blocked: number }>> {
    const { rows } = await t.pool.query(
      `SELECT day::text AS day, total, sold, blocked FROM inventory_day
        WHERE scope_kind = $1 AND scope_id = $2 ORDER BY day`,
      [scope.kind, scope.id],
    );
    return rows;
  }

  /** One sale = one transaction on its own connection; never throws. Its backend pid goes into `pids`. */
  function sale(fn: (x: Tx) => Promise<void>, pids?: number[]): Promise<Outcome> {
    return db
      .transaction(async (x) => {
        const { rows } = await x.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        pids?.push(rows[0].pid);
        await fn(x as unknown as Tx);
      })
      .then(
        () => ({ ok: true }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      );
  }

  /**
   * A sale that runs `fn`, then keeps its transaction (and locks) open until
   * release(), then runs `after` (if any) and commits.
   */
  function holdingSale(fn: (x: Tx) => Promise<void>, after?: (x: Tx) => Promise<void>) {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let markHeld!: () => void;
    const heldOnce = new Promise<void>((res) => (markHeld = res));
    const outcome = sale(async (x) => {
      await fn(x);
      markHeld();
      await gate;
      await after?.(x);
    });
    const held = Promise.race([
      heldOnce,
      outcome.then((o) => {
        throw new Error(`the holding sale ended before it was held: ${JSON.stringify(o, Object.getOwnPropertyNames)}`);
      }),
    ]);
    return { held, release, outcome };
  }

  /** Waits until `count` of the sales' backends wait on a lock; fails fast with a clear message otherwise. */
  async function waitUntilWaiting(pids: number[], count: number, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    let waiting = 0;
    while (Date.now() < deadline) {
      const r = await t.pool.query<{ n: number }>(
        `SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE pid = ANY($1::int[]) AND NOT granted`,
        [pids],
      );
      waiting = r.rows[0].n;
      if (waiting >= count) return;
      await delay(20);
    }
    throw new Error(`${what}: expected ${count} waiting on a lock within ${WAIT_MS} ms, saw ${waiting}`);
  }

  function failures(outcomes: Outcome[]): unknown[] {
    return outcomes.flatMap((o) => (o.ok ? [] : [o.error]));
  }

  it('20 parallel take(sold, +1) on a type with total = 5 for 3 nights: exactly 5 succeed, 15 get no_availability', async () => {
    const scope = await seedType('DBL', 5);
    await seedDays(scope, '2026-11-10', '2026-11-13');

    // The first sale takes its night and stays open, holding the day rows. The
    // other 19 are let loose against it and all queue before it commits.
    const first = holdingSale((x) => inv.take(x, propertyId, scope, '2026-11-10', '2026-11-13', 'sold', 1));
    await first.held;
    const pids: number[] = [];
    const rest = Array.from({ length: CONCURRENCY - 1 }, () =>
      sale((x) => inv.take(x, propertyId, scope, '2026-11-10', '2026-11-13', 'sold', 1), pids),
    );
    try {
      await waitUntilWaiting(pids, CONCURRENCY - 1, 'the 19 other sales');
    } finally {
      first.release();
    }
    const outcomes = [await first.outcome, ...(await Promise.all(rest))];

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

  it('a sale and a block of the same night on total = 1: the second waits for the first, then gets no_availability', async () => {
    for (const [firstColumn, secondColumn] of [
      ['sold', 'blocked'],
      ['blocked', 'sold'],
    ] as const) {
      const scope = await seedLooseUnit(`Apartman ${firstColumn}`);
      await seedDays(scope, '2026-11-20', '2026-11-21');

      // The first sale only locks the night (lockDays) and takes it after the
      // second one is queued. A row that is merely locked does not make the
      // second sale's INSERT ... ON CONFLICT wait, so what holds it back is
      // the FOR UPDATE of its own lockDays; without that lock it would read
      // sold + blocked = 0, go on to its UPDATE and overbook.
      const first = holdingSale(
        (x) => inv.lockDays(x, propertyId, scope, '2026-11-20', '2026-11-21').then(() => undefined),
        (x) => inv.take(x, propertyId, scope, '2026-11-20', '2026-11-21', firstColumn, 1),
      );
      await first.held;
      const pids: number[] = [];
      const second = sale((x) => inv.take(x, propertyId, scope, '2026-11-20', '2026-11-21', secondColumn, 1), pids);
      try {
        await waitUntilWaiting(pids, 1, `the ${secondColumn} sale behind the ${firstColumn} sale`);
      } finally {
        first.release();
      }
      const [a, b] = [await first.outcome, await second];

      expect(a).toEqual({ ok: true });
      expect(b.ok).toBe(false);
      const error = (b as { ok: false; error: unknown }).error;
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code: 'no_availability', status: 409, details: { day: '2026-11-20' } });
      expect(await ledger(scope)).toEqual([
        {
          day: '2026-11-20',
          total: 1,
          sold: firstColumn === 'sold' ? 1 : 0,
          blocked: firstColumn === 'blocked' ? 1 : 0,
        },
      ]);
    }
  });

  // What this proves is the scope lock modes, not day-row ordering: lockDays
  // takes the scope shared (bookings do not queue behind each other), while
  // recomputeTotal takes it exclusive (it waits for open bookings even on days
  // it does not touch). The booked days are in the past, so recomputeTotal has
  // no row to wait for: it can only be waiting on the scope lock.
  it('scope lock modes: bookings share the scope, recomputeTotal waits for them; all finish < 5 s without 40P01', async () => {
    const scope = await seedType('DBL', 3);
    await seedDays(scope, '2026-10-20', '2026-10-22'); // past (today is 2026-11-02)
    await seedDays(scope, '2026-11-10', '2026-11-11'); // future

    const a = holdingSale((x) => inv.take(x, propertyId, scope, '2026-10-20', '2026-10-21', 'sold', 1));
    await a.held;
    let b: Promise<Outcome> | undefined;
    let outcomes: Outcome[];
    const started = Date.now();
    try {
      // A second booking on the same scope is not blocked by the open one (shared + shared).
      const c = sale((x) => inv.take(x, propertyId, scope, '2026-10-21', '2026-10-22', 'sold', 1));
      const cResult = await Promise.race([c, delay(WAIT_MS).then(() => 'blocked' as const)]);
      if (cResult === 'blocked') throw new Error('a booking on the scope queued behind another booking: lockDays is not shared');
      expect(cResult).toEqual({ ok: true });

      // Adding a unit and recomputing the total must wait for the open booking.
      const pids: number[] = [];
      b = sale(async (x) => {
        await x.execute(
          sql`INSERT INTO unit (property_id, name, unit_type_id) VALUES (${propertyId}, 'DBL-new', ${scope.id})`,
        );
        await inv.recomputeTotal(x, propertyId, scope);
      }, pids);
      await waitUntilWaiting(pids, 1, 'recomputeTotal behind the open booking');
    } finally {
      a.release();
    }
    outcomes = [await a.outcome, await b!];
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5_000);
    for (const e of failures(outcomes)) {
      expect((e as { code?: string }).code).not.toBe('40P01');
    }
    expect(outcomes).toEqual([{ ok: true }, { ok: true }]);
    expect(await ledger(scope)).toEqual([
      { day: '2026-10-20', total: 3, sold: 1, blocked: 0 }, // past: keeps its total
      { day: '2026-10-21', total: 3, sold: 1, blocked: 0 },
      { day: '2026-11-10', total: 4, sold: 0, blocked: 0 }, // future: recomputed
    ]);
  }, 15_000);
});
