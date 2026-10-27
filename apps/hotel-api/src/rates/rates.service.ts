import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { AuthUser } from '../auth/sessions.service';
import { AuditService } from '../common/audit.service';
import { DomainError } from '../common/domain-error';
import {
  asBody,
  isUniqueViolation,
  isUuid,
  localized,
  optionalText,
  requireDate,
  requireOneOf,
  requireText,
  validationFailed,
  type Body,
} from '../common/input';
import { PropertyContext } from '../common/property-context';
import { BOARDS, ratePlan, type Board, type LocalizedText } from '../db/schema';
import { DB, type Db, type Tx } from '../db/tokens';
import { InventoryService, type Scope } from '../inventory/inventory.service';
import { quoteStay, type QuoteNight, type QuoteResult } from './quote';

/** The most days one request may set or read. */
export const MAX_RANGE_DAYS = 731;

const CURRENCY = 'RSD' as const;
const DAY_MS = 86_400_000;

export interface RatePlanView {
  id: string;
  code: string;
  name: LocalizedText;
  board: Board;
  cancellationPolicy: Record<string, unknown> | null;
  discount7Pct: number;
  discount30Pct: number;
  active: boolean;
}

export interface RateDayView {
  day: string;
  priceMinor: number | null;
  closed: boolean;
}

type PlanRow = typeof ratePlan.$inferSelect;

function planView(r: PlanRow): RatePlanView {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    board: r.board,
    cancellationPolicy: r.cancellationPolicy ?? null,
    discount7Pct: r.discount7Pct,
    discount30Pct: r.discount30Pct,
    active: r.active,
  };
}

const planNotFound = () => new DomainError('rate_plan_not_found', 'Cenovnik ne postoji.', 404);
const codeTaken = () => new DomainError('rate_plan_code_taken', 'Cenovnik sa ovom oznakom već postoji.', 409);

function percentOf(b: Body, field: 'discount7Pct' | 'discount30Pct'): number | undefined {
  const v = b[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) throw validationFailed(field);
  return v;
}

function policyOf(b: Body): Record<string, unknown> | null | undefined {
  const v = b.cancellationPolicy;
  if (v === undefined || v === null) return v;
  if (typeof v !== 'object' || Array.isArray(v) || JSON.stringify(v).length > 4000) {
    throw validationFailed('cancellationPolicy');
  }
  return v as Record<string, unknown>;
}

/** { from, to } as ISO dates, to exclusive, at most MAX_RANGE_DAYS long. */
function rangeOf(from: unknown, to: unknown): { from: string; to: string } {
  const f = requireDate({ from }, 'from');
  const t = requireDate({ to }, 'to');
  if (t <= f) throw validationFailed('to', 'Datum "to" mora biti posle datuma "from".');
  const days = (Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / DAY_MS;
  if (days > MAX_RANGE_DAYS) {
    throw new DomainError('range_too_long', `Opseg može imati najviše ${MAX_RANGE_DAYS} dana.`, 422, {
      max: MAX_RANGE_DAYS,
      days,
    });
  }
  return { from: f, to: t };
}

function scopeKindOf(kind: unknown): Scope['kind'] {
  return requireOneOf({ scope: kind }, 'scope', ['unit_type', 'unit']);
}

function scopeFromBody(value: unknown): Scope {
  const v = asBody(value);
  const kind = scopeKindOf(v.kind);
  if (typeof v.id !== 'string' || !isUuid(v.id)) throw validationFailed('scope');
  return { kind, id: v.id };
}

/** The query form of a scope: "unit_type:<uuid>" or "unit:<uuid>". */
function scopeFromQuery(value: unknown): Scope {
  if (typeof value !== 'string') throw validationFailed('scope');
  const at = value.indexOf(':');
  if (at < 0) throw validationFailed('scope');
  const id = value.slice(at + 1);
  if (!isUuid(id)) throw validationFailed('scope');
  return { kind: scopeKindOf(value.slice(0, at)), id };
}

/**
 * Safe integer or null from a bigint column (pg returns bigint as text). The
 * column is bounded by what the API accepts, so a larger value is data damage.
 */
function priceFrom(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`rates: price ${raw} is not a safe integer`);
  return n;
}

/**
 * The base price list: rate plans and per-day prices per scope (unit type, or
 * a unit without a type). Reservations price every stay through quote.
 */
@Injectable()
export class RatesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly property: PropertyContext,
    private readonly inventory: InventoryService,
  ) {}

  // ---- rate plans ----

  async listPlans(): Promise<RatePlanView[]> {
    const propertyId = await this.property.id();
    const rows = await this.db.select().from(ratePlan).where(eq(ratePlan.propertyId, propertyId)).orderBy(asc(ratePlan.code));
    return rows.map(planView);
  }

  async createPlan(actor: AuthUser, body: unknown): Promise<RatePlanView> {
    const b = asBody(body);
    const code = requireText(b, 'code', 20);
    const name = localized(b.name, 'name', true);
    const board = b.board === undefined ? 'RO' : requireOneOf(b, 'board', BOARDS);
    const cancellationPolicy = policyOf(b) ?? null;
    const discount7Pct = percentOf(b, 'discount7Pct') ?? 0;
    const discount30Pct = percentOf(b, 'discount30Pct') ?? 0;
    const propertyId = await this.property.id();

    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(ratePlan)
          .values({ propertyId, code, name, board, cancellationPolicy, discount7Pct, discount30Pct })
          .returning();
        const view = planView(row);
        await this.audit.record(tx, {
          propertyId,
          actorUserId: actor.id,
          action: 'rate_plan.create',
          entity: 'rate_plan',
          entityId: row.id,
          after: view,
        });
        return view;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw codeTaken();
      throw err;
    }
  }

  async updatePlan(actor: AuthUser, id: string, body: unknown): Promise<RatePlanView> {
    if (!isUuid(id)) throw planNotFound();
    const b = asBody(body);
    const patch: Partial<typeof ratePlan.$inferInsert> = {};
    if (b.code !== undefined) patch.code = requireText(b, 'code', 20);
    if (b.name !== undefined) patch.name = localized(b.name, 'name', true);
    if (b.board !== undefined) patch.board = requireOneOf(b, 'board', BOARDS);
    const policy = policyOf(b);
    if (policy !== undefined) patch.cancellationPolicy = policy;
    const d7 = percentOf(b, 'discount7Pct');
    if (d7 !== undefined) patch.discount7Pct = d7;
    const d30 = percentOf(b, 'discount30Pct');
    if (d30 !== undefined) patch.discount30Pct = d30;
    if (b.active !== undefined) {
      if (typeof b.active !== 'boolean') throw validationFailed('active');
      patch.active = b.active;
    }
    if (Object.keys(patch).length === 0) throw validationFailed('code', 'Nema izmena.');
    const propertyId = await this.property.id();

    try {
      return await this.db.transaction(async (tx) => {
        const before = await this.lockPlan(tx, propertyId, id);
        const [row] = await tx
          .update(ratePlan)
          .set(patch)
          .where(and(eq(ratePlan.id, id), eq(ratePlan.propertyId, propertyId)))
          .returning();
        const view = planView(row);
        await this.audit.record(tx, {
          propertyId,
          actorUserId: actor.id,
          action: 'rate_plan.update',
          entity: 'rate_plan',
          entityId: id,
          before: planView(before),
          after: view,
        });
        return view;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw codeTaken();
      throw err;
    }
  }

  // ---- days ----

  /**
   * Sets price and/or closed on every night of [from, to) in one statement.
   * A field that is not sent keeps its stored value; a night without a row
   * gets one (closed alone leaves the price empty). Returns the nights set.
   */
  async setDays(actor: AuthUser, planId: string, body: unknown): Promise<{ days: number }> {
    if (!isUuid(planId)) throw planNotFound();
    const b = asBody(body);
    const scope = scopeFromBody(b.scope);
    const { from, to } = rangeOf(b.from, b.to);
    const priceMinor = b.priceMinor;
    if (priceMinor !== undefined && (typeof priceMinor !== 'number' || !Number.isSafeInteger(priceMinor) || priceMinor < 0)) {
      throw validationFailed('priceMinor');
    }
    if (b.closed !== undefined && typeof b.closed !== 'boolean') throw validationFailed('closed');
    if (priceMinor === undefined && b.closed === undefined) {
      throw validationFailed('priceMinor', 'Pošaljite cenu ili oznaku zatvorenosti.');
    }
    const price = priceMinor === undefined ? null : priceMinor;
    const closed = b.closed === undefined ? null : b.closed;
    const propertyId = await this.property.id();

    return this.db.transaction(async (tx) => {
      await this.lockPlan(tx, propertyId, planId);
      await this.assertPriceable(tx, propertyId, scope);
      const res = await tx.execute(sql`
        INSERT INTO rate_day (property_id, rate_plan_id, scope_kind, scope_id, day, price_minor, closed)
        SELECT ${propertyId}::uuid, ${planId}::uuid, ${scope.kind}, ${scope.id}::uuid, d::date,
               ${price}::bigint, COALESCE(${closed}::boolean, false)
          FROM generate_series(${from}::date, ${to}::date - 1, interval '1 day') AS d
        ON CONFLICT (property_id, rate_plan_id, scope_kind, scope_id, day) DO UPDATE SET
          price_minor = COALESCE(EXCLUDED.price_minor, rate_day.price_minor),
          closed = CASE WHEN ${closed}::boolean IS NULL THEN rate_day.closed ELSE EXCLUDED.closed END`);
      const days = res.rowCount ?? 0;
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'rate_day.set',
        entity: 'rate_plan',
        entityId: planId,
        after: { scope, from, to, ...(priceMinor === undefined ? {} : { priceMinor }), ...(b.closed === undefined ? {} : { closed: b.closed }) },
      });
      return { days };
    });
  }

  /** The stored days of [from, to) for the scope, in day order (nights without a row are absent). */
  async listDays(planId: string, query: { scope?: unknown; from?: unknown; to?: unknown }): Promise<RateDayView[]> {
    if (!isUuid(planId)) throw planNotFound();
    const scope = scopeFromQuery(query.scope);
    const { from, to } = rangeOf(query.from, query.to);
    const propertyId = await this.property.id();

    return this.db.transaction(async (tx) => {
      await this.assertPlanExists(tx, propertyId, planId);
      await this.assertPriceable(tx, propertyId, scope);
      const { rows } = await tx.execute<{ day: string; price_minor: string | null; closed: boolean }>(sql`
        SELECT day::text AS day, price_minor::text AS price_minor, closed
          FROM rate_day
         WHERE property_id = ${propertyId} AND rate_plan_id = ${planId}
           AND scope_kind = ${scope.kind} AND scope_id = ${scope.id}
           AND day >= ${from}::date AND day < ${to}::date
         ORDER BY day`);
      return rows.map((r) => ({ day: r.day, priceMinor: priceFrom(r.price_minor), closed: r.closed }));
    });
  }

  // ---- quote ----

  /**
   * Prices the stay [arrival, departure) on the plan for the scope, inside the
   * caller's transaction. A night without a rate_day row has no price. An
   * unknown plan is 404 rate_plan_not_found, an inactive one 422
   * rate_plan_inactive, a scope outside the property 404 scope_not_found.
   */
  async quote(
    tx: Tx,
    propertyId: string,
    ratePlanId: string,
    scope: Scope,
    arrival: string,
    departure: string,
  ): Promise<QuoteResult> {
    const { from, to } = rangeOf(arrival, departure);
    if (!isUuid(ratePlanId)) throw planNotFound();
    const [plan] = await tx
      .select()
      .from(ratePlan)
      .where(and(eq(ratePlan.id, ratePlanId), eq(ratePlan.propertyId, propertyId)));
    if (!plan) throw planNotFound();
    if (!plan.active) throw new DomainError('rate_plan_inactive', 'Cenovnik nije aktivan.', 422);
    await this.inventory.assertScopeExists(tx, propertyId, scope);

    const { rows } = await tx.execute<{ day: string; price_minor: string | null; closed: boolean | null }>(sql`
      SELECT d::date::text AS day, r.price_minor::text AS price_minor, r.closed
        FROM generate_series(${from}::date, ${to}::date - 1, interval '1 day') AS d
        LEFT JOIN rate_day r
          ON r.property_id = ${propertyId} AND r.rate_plan_id = ${ratePlanId}
         AND r.scope_kind = ${scope.kind} AND r.scope_id = ${scope.id} AND r.day = d::date
       ORDER BY d`);
    const nights: QuoteNight[] = rows.map((r) => ({
      day: r.day,
      priceMinor: priceFrom(r.price_minor),
      closed: r.closed ?? false,
    }));
    return quoteStay({ nights, discount7Pct: plan.discount7Pct, discount30Pct: plan.discount30Pct, currency: CURRENCY });
  }

  /**
   * The scope exists and is what a quote prices: a unit that has a type is
   * sold (and priced) through its type, so prices stored on the unit itself
   * would never be used (422 scope_not_priced, Ruling 19).
   */
  private async assertPriceable(tx: Tx, propertyId: string, scope: Scope): Promise<void> {
    await this.inventory.assertScopeExists(tx, propertyId, scope);
    if (scope.kind !== 'unit') return;
    const { rows } = await tx.execute<{ unit_type_id: string | null }>(
      sql`SELECT unit_type_id FROM unit WHERE id = ${scope.id} AND property_id = ${propertyId}`,
    );
    if (rows[0]?.unit_type_id) {
      throw new DomainError('scope_not_priced', 'Jedinica ima tip; cene se unose za tip jedinice.', 422, {
        unitTypeId: rows[0].unit_type_id,
      });
    }
  }

  private async lockPlan(tx: Tx, propertyId: string, id: string): Promise<PlanRow> {
    const [row] = await tx
      .select()
      .from(ratePlan)
      .where(and(eq(ratePlan.id, id), eq(ratePlan.propertyId, propertyId)))
      .for('update');
    if (!row) throw planNotFound();
    return row;
  }

  private async assertPlanExists(tx: Tx, propertyId: string, id: string): Promise<void> {
    const [row] = await tx
      .select({ id: ratePlan.id })
      .from(ratePlan)
      .where(and(eq(ratePlan.id, id), eq(ratePlan.propertyId, propertyId)));
    if (!row) throw planNotFound();
  }
}
