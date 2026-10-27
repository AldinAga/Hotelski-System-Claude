import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../common/clock';
import { DomainError } from '../common/domain-error';
import type { Tx } from '../db/tokens';

/**
 * What a unit's nights are counted against: its type, or the unit itself when
 * it has no type (then total is 1 while it is active).
 */
export type Scope = { kind: 'unit_type' | 'unit'; id: string };

export interface InventoryDay {
  /** YYYY-MM-DD */
  day: string;
  total: number;
  sold: number;
  blocked: number;
}

/**
 * Namespace (first key) of the per-scope advisory locks. lockDays takes the
 * scope's lock shared, recomputeTotal exclusive: a booking never runs against
 * a total that a concurrent unit change is rewriting, and a day row inserted
 * by lockDays always counts the units as committed after the last recompute.
 */
export const INVENTORY_SCOPE_LOCK_NS = 7_301_006;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertRange(from: string, to: string): void {
  if (!DATE.test(from) || !DATE.test(to) || from >= to) {
    throw new TypeError(`inventory: invalid day range [${from}, ${to})`);
  }
}

/** The scope rule: a unit with a type consumes the type, a unit without one consumes itself. */
export function scopeFor(unitId: string, unitTypeId: string | null): Scope {
  return unitTypeId ? { kind: 'unit_type', id: unitTypeId } : { kind: 'unit', id: unitId };
}

/** Sorted by kind, then id: the one order in which several scopes are locked. */
export function scopeOrder(a: Scope, b: Scope): number {
  return a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind < b.kind ? -1 : 1;
}

/** The property-local calendar date of `at` (YYYY-MM-DD). */
export function localDate(at: Date, timezone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/**
 * The inventory ledger (inventory_day), the only source of availability
 * (spec 5.7). Nothing else writes inventory_day: callers go through lockDays,
 * take and recomputeTotal, always inside their own transaction.
 *
 * Lock hierarchy. Every transaction takes locks in this order and never
 * backwards, so bookings, blocks and unit changes cannot deadlock:
 *   1. the units advisory lock (UNITS_LOCK_KEY; unit and unit-type changes
 *      only), then the unit row (SELECT ... FOR UPDATE), when the caller
 *      touches a unit;
 *   2. the scope advisory locks (INVENTORY_SCOPE_LOCK_NS), several scopes in
 *      scopeOrder: lockDays/take take them shared, recomputeTotal exclusive;
 *   3. the inventory_day rows, in day order (FOR UPDATE ... ORDER BY day).
 * A transaction never takes a scope shared and later exclusive (or the other
 * way round): one role per scope per transaction. A caller that books several
 * scopes in one transaction must call lockDays/take for them in scopeOrder.
 */
@Injectable()
export class InventoryService {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /** Today in the property's timezone. */
  async today(tx: Tx, propertyId: string): Promise<string> {
    const { rows } = await tx.execute<{ timezone: string }>(
      sql`SELECT timezone FROM property WHERE id = ${propertyId}`,
    );
    if (!rows[0]) throw new Error(`inventory: property ${propertyId} not found`);
    return localDate(this.clock(), rows[0].timezone);
  }

  async scopeOfUnit(tx: Tx, propertyId: string, unitId: string): Promise<Scope> {
    const { rows } = await tx.execute<{ unit_type_id: string | null }>(
      sql`SELECT unit_type_id FROM unit WHERE id = ${unitId} AND property_id = ${propertyId}`,
    );
    if (!rows[0]) throw new Error(`inventory: unit ${unitId} not found`);
    return scopeFor(unitId, rows[0].unit_type_id);
  }

  /**
   * Inserts the missing days of [from, to) with total from the currently
   * active units, then locks all of them FOR UPDATE in day order and returns
   * them in that order. A scope whose type or unit does not belong to the
   * property is 404 scope_not_found.
   */
  async lockDays(tx: Tx, propertyId: string, scope: Scope, from: string, to: string): Promise<InventoryDay[]> {
    assertRange(from, to);
    await this.assertScopeExists(tx, propertyId, scope);
    await this.lockScope(tx, scope, 'shared');
    await tx.execute(sql`
      INSERT INTO inventory_day (property_id, scope_kind, scope_id, day, total)
      SELECT ${propertyId}::uuid, ${scope.kind}, ${scope.id}::uuid, d::date, (${this.totalSql(propertyId, scope)})
        FROM generate_series(${from}::date, ${to}::date - 1, interval '1 day') AS d
      ON CONFLICT DO NOTHING`);
    const { rows } = await tx.execute<{ day: string; total: number; sold: number; blocked: number }>(sql`
      SELECT day::text AS day, total, sold, blocked
        FROM inventory_day
       WHERE property_id = ${propertyId} AND scope_kind = ${scope.kind} AND scope_id = ${scope.id}
         AND day >= ${from}::date AND day < ${to}::date
       ORDER BY day
         FOR UPDATE`);
    return rows.map((r) => ({ day: r.day, total: r.total, sold: r.sold, blocked: r.blocked }));
  }

  /**
   * Adds `delta` to `column` for every night of [from, to). Taking (+1) is
   * refused with 409 no_availability naming the first night already full.
   */
  async take(
    tx: Tx,
    propertyId: string,
    scope: Scope,
    from: string,
    to: string,
    column: 'sold' | 'blocked',
    delta: 1 | -1,
  ): Promise<void> {
    if (column !== 'sold' && column !== 'blocked') throw new TypeError(`inventory: bad column ${String(column)}`);
    if (delta !== 1 && delta !== -1) throw new TypeError(`inventory: bad delta ${String(delta)}`);
    const days = await this.lockDays(tx, propertyId, scope, from, to);
    if (delta === 1) {
      const full = days.find((d) => d.sold + d.blocked + 1 > d.total);
      if (full) {
        throw new DomainError('no_availability', `Nema slobodnih jedinica za ${full.day}.`, 409, { day: full.day });
      }
    } else {
      const empty = days.find((d) => d[column] < 1);
      // Giving back what was never taken is a caller bug, not a user error.
      if (empty) throw new Error(`inventory: ${column} would go below zero on ${empty.day}`);
    }
    const col = column === 'sold' ? sql`sold` : sql`blocked`;
    await tx.execute(sql`
      UPDATE inventory_day SET ${col} = ${col} + ${delta}
       WHERE property_id = ${propertyId} AND scope_kind = ${scope.kind} AND scope_id = ${scope.id}
         AND day >= ${from}::date AND day < ${to}::date`);
  }

  /**
   * Sets total from the currently active units on every stored day of the
   * scope from the property's today on. Refused with 409 inventory_conflict
   * (first such day) when a day already holds more sold + blocked than the
   * new total. Call after the unit change, in the same transaction; with two
   * scopes, call in scopeOrder.
   */
  async recomputeTotal(tx: Tx, propertyId: string, scope: Scope): Promise<void> {
    await this.lockScope(tx, scope, 'exclusive');
    const today = await this.today(tx, propertyId);
    const { rows } = await tx.execute<{ day: string; sold: number; blocked: number; next: number }>(sql`
      SELECT day::text AS day, sold, blocked, (${this.totalSql(propertyId, scope)}) AS next
        FROM inventory_day
       WHERE property_id = ${propertyId} AND scope_kind = ${scope.kind} AND scope_id = ${scope.id}
         AND day >= ${today}::date
       ORDER BY day
         FOR UPDATE`);
    if (rows.length === 0) return;
    const conflict = rows.find((r) => r.sold + r.blocked > r.next);
    if (conflict) {
      throw new DomainError(
        'inventory_conflict',
        `Za ${conflict.day} je već prodato ili blokirano više jedinica nego što bi ostalo.`,
        409,
        { day: conflict.day },
      );
    }
    await tx.execute(sql`
      UPDATE inventory_day SET total = ${rows[0].next}
       WHERE property_id = ${propertyId} AND scope_kind = ${scope.kind} AND scope_id = ${scope.id}
         AND day >= ${today}::date`);
  }

  async assertScopeExists(tx: Tx, propertyId: string, scope: Scope): Promise<void> {
    const { rows } = await tx.execute(
      scope.kind === 'unit_type'
        ? sql`SELECT 1 FROM unit_type WHERE id = ${scope.id} AND property_id = ${propertyId}`
        : sql`SELECT 1 FROM unit WHERE id = ${scope.id} AND property_id = ${propertyId}`,
    );
    if (rows.length === 0) {
      throw new DomainError('scope_not_found', 'Tip ili jedinica ne postoji.', 404, { kind: scope.kind, id: scope.id });
    }
  }

  private async lockScope(tx: Tx, scope: Scope, mode: 'shared' | 'exclusive'): Promise<void> {
    const key = sql`${INVENTORY_SCOPE_LOCK_NS}::int, hashtext(${`${scope.kind}:${scope.id}`})`;
    await tx.execute(
      mode === 'shared'
        ? sql`SELECT pg_advisory_xact_lock_shared(${key})`
        : sql`SELECT pg_advisory_xact_lock(${key})`,
    );
  }

  /** The scope's total as of now: active units of the type, or 1 for an active untyped unit. */
  private totalSql(propertyId: string, scope: Scope) {
    return scope.kind === 'unit_type'
      ? sql`SELECT count(*)::int FROM unit
             WHERE property_id = ${propertyId} AND unit_type_id = ${scope.id} AND active`
      : sql`SELECT count(*)::int FROM unit
             WHERE property_id = ${propertyId} AND id = ${scope.id} AND unit_type_id IS NULL AND active`;
  }
}
