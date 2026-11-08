import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { AuditService } from '../common/audit.service';
import { DomainError } from '../common/domain-error';
import {
  asBody,
  isExclusionViolation,
  isUniqueViolation,
  isUuid,
  optionalText,
  requireDate,
  validationFailed,
  type Body,
} from '../common/input';
import { PropertyContext } from '../common/property-context';
import { DB, type Db, type Tx } from '../db/tokens';
import { parseGuestInput, stayGuestsOf, type StayGuestView } from '../guests/guests.service';
import { InventoryService, scopeFor, scopeOrder, type Scope } from '../inventory/inventory.service';
import { RatesService } from '../rates/rates.service';
import { validateStayDates, MAX_STAY_NIGHTS, type StayDatesReason } from './stay-dates';

export const RESERVATION_SOURCES = ['front_desk', 'phone', 'website', 'widget', 'api', 'ota'] as const;
export type ReservationSource = (typeof RESERVATION_SOURCES)[number];

export const RESERVATION_STATUSES = ['requested', 'confirmed', 'cancelled', 'no_show'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export type StayStatus = 'expected' | 'in_house' | 'checked_out' | 'cancelled' | 'no_show';

/** The most stays one reservation may hold. */
export const MAX_STAYS = 20;
export const MAX_GUESTS_PER_STAY = 50;

/**
 * Namespace (first key) of the advisory lock on a (channel, externalId) pair:
 * a repeated request from a website or OTA waits for the first one and then
 * finds its reservation, before taking any inventory lock.
 */
export const RESERVATION_KEY_LOCK_NS = 7_301_009;

export interface BookStayInput {
  unitTypeId?: string;
  unitId?: string;
  arrival: string;
  departure: string;
  adults: number;
  children?: number;
  ratePlanId: string;
}

export interface BookInput {
  source: ReservationSource;
  channel?: string;
  externalId?: string;
  holder: { firstName: string; lastName: string; email?: string; phone?: string; language?: string };
  note?: string;
  stays: BookStayInput[];
}

/** Who makes the change: the signed-in user for the front desk. */
export interface Actor {
  id: string;
}

export interface BookResult {
  reservationId: string;
  number: string;
}

export interface StayView {
  id: string;
  unitTypeId: string | null;
  unitId: string | null;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  ratePlanId: string;
  status: StayStatus;
  nights: Array<{ day: string; priceMinor: number }>;
  totalMinor: number;
  /** Primary guest first, then in the order they were added (GuestsService). */
  guests: StayGuestView[];
}

export interface ReservationView {
  id: string;
  number: string;
  status: ReservationStatus;
  source: ReservationSource;
  channel: string | null;
  externalId: string | null;
  guarantee: string | null;
  note: string | null;
  version: number;
  createdAt: string;
  holder: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    language: string;
  };
  stays: StayView[];
  totalMinor: number;
}

export interface ReservationSummary {
  id: string;
  number: string;
  status: ReservationStatus;
  source: ReservationSource;
  holderName: string;
  arrival: string;
  departure: string;
  stayCount: number;
  version: number;
}

const LIST_LIMIT = 500;

const reservationNotFound = () => new DomainError('reservation_not_found', 'Rezervacija ne postoji.', 404);
const stayNotFound = () => new DomainError('stay_not_found', 'Boravak ne postoji.', 404);
const unitNotFound = (details?: Record<string, unknown>) =>
  new DomainError('unit_not_found', 'Jedinica ne postoji.', 404, details);
const unitTaken = () =>
  new DomainError('unit_taken', 'Jedinica je već zauzeta u tom periodu.', 409);
/** 409 version_conflict naming the reservation's current version (also check-in and check-out). */
export const versionConflict = (version: number) =>
  new DomainError('version_conflict', 'Rezervaciju je u međuvremenu neko izmenio; osvežite prikaz.', 409, { version });

/** The `version` a change sends: an integer ≥ 1, otherwise 422 naming version. */
export function versionOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw validationFailed('version');
  return v;
}

const STAY_DATE_MESSAGES: Record<StayDatesReason, string> = {
  bad_date: 'Neispravan datum.',
  departure_not_after_arrival: 'Datum odlaska mora biti posle datuma dolaska.',
  arrival_in_past: 'Datum dolaska ne može biti u prošlosti.',
  too_long: `Boravak može trajati najviše ${MAX_STAY_NIGHTS} noći.`,
};

function textOf(b: Body, field: string, path: string, max: number): string | undefined {
  try {
    return optionalText(b, field, max) ?? undefined;
  } catch {
    throw validationFailed(path);
  }
}

function intIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/**
 * Checks and normalises a booking request, whoever sends it (the HTTP body
 * or, later, the website and OTA adapters). Dates are left as sent: their
 * rules need the property's today and are checked by validateStayDates.
 */
export function parseBookInput(raw: unknown): BookInput {
  const b = asBody(raw);
  const source = b.source;
  if (typeof source !== 'string' || !(RESERVATION_SOURCES as readonly string[]).includes(source)) {
    throw validationFailed('source');
  }
  const channel = textOf(b, 'channel', 'channel', 50);
  const externalId = textOf(b, 'externalId', 'externalId', 200);
  if (externalId !== undefined && channel === undefined) {
    throw validationFailed('channel', 'Uz spoljni broj rezervacije mora se navesti kanal.');
  }
  // The holder follows the field rules of every guest (GuestsService); it has no note.
  const holder = parseGuestInput(b.holder, 'holder.', { note: false });
  const firstName = holder.firstName!;
  const lastName = holder.lastName!;
  const email = holder.email ?? undefined;
  const phone = holder.phone ?? undefined;
  const language = holder.language;
  const note = textOf(b, 'note', 'note', 2000);

  if (!Array.isArray(b.stays) || b.stays.length === 0 || b.stays.length > MAX_STAYS) throw validationFailed('stays');
  const stays = b.stays.map((rawStay, i): BookStayInput => {
    const s = asBody(rawStay);
    const at = (f: string) => `stays[${i}].${f}`;
    const uuidOrUndefined = (f: string): string | undefined => {
      const v = s[f];
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'string' || !isUuid(v)) throw validationFailed(at(f));
      return v.toLowerCase();
    };
    const unitTypeId = uuidOrUndefined('unitTypeId');
    const unitId = uuidOrUndefined('unitId');
    if (!unitTypeId && !unitId) throw validationFailed(at('unitTypeId'), 'Navedite tip jedinice ili jedinicu.');
    if (!intIn(s.adults, 1, MAX_GUESTS_PER_STAY)) throw validationFailed(at('adults'));
    const children = s.children === undefined ? 0 : s.children;
    if (!intIn(children, 0, MAX_GUESTS_PER_STAY)) throw validationFailed(at('children'));
    const ratePlanId = uuidOrUndefined('ratePlanId');
    if (!ratePlanId) throw validationFailed(at('ratePlanId'));
    return {
      ...(unitTypeId ? { unitTypeId } : {}),
      ...(unitId ? { unitId } : {}),
      arrival: s.arrival as string,
      departure: s.departure as string,
      adults: s.adults as number,
      children,
      ratePlanId,
    };
  });

  return {
    source: source as ReservationSource,
    ...(channel !== undefined ? { channel } : {}),
    ...(externalId !== undefined ? { externalId } : {}),
    holder: {
      firstName,
      lastName,
      ...(email !== undefined ? { email } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(language !== undefined ? { language } : {}),
    },
    ...(note !== undefined ? { note } : {}),
    stays,
  };
}

/** A stay's inventory scope, from what the stay stores (see migration 0007). */
export function scopeOfStay(s: { unit_type_id: string | null; unit_id: string | null }): Scope {
  if (s.unit_type_id) return { kind: 'unit_type', id: s.unit_type_id };
  if (s.unit_id) return { kind: 'unit', id: s.unit_id };
  throw new Error('reservations: stay without unit type and unit');
}

/** Scope order first, then arrival: the order in which a transaction takes or gives back nights. */
export function inventoryOrder<T extends { scope: Scope; arrival: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => scopeOrder(a.scope, b.scope) || (a.arrival < b.arrival ? -1 : a.arrival > b.arrival ? 1 : 0));
}

function minorFrom(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`reservations: amount ${raw} is not a safe integer`);
  return n;
}

function pgCause(err: unknown): { constraint?: string } {
  const e = err as { constraint?: string; cause?: { constraint?: string } } | null;
  return e?.constraint ? e : (e?.cause ?? {});
}

type UnitRow = { id: string; unit_type_id: string | null; active: boolean };
type StayPlan = { i: number; s: BookStayInput; scope: Scope; unitTypeId: string | null };
type PricedStay = StayPlan & { nights: Array<{ day: string; priceMinor: number }> };

/** POST /reservations/quote: the price book would store, per stay and in total. */
export interface QuoteView {
  stays: Array<{ nights: Array<{ day: string; priceMinor: number }>; totalMinor: number }>;
  totalMinor: number;
}
type StayRow = {
  id: string;
  reservation_id: string;
  unit_type_id: string | null;
  unit_id: string | null;
  arrival: string;
  departure: string;
  status: StayStatus;
};

/**
 * The one way a stay is made, cancelled or moved (spec 5.7): the front desk
 * today, the website and OTA adapters later, all through book.
 *
 * Locks follow the inventory hierarchy (InventoryService), with the
 * reservation row in front of it. In front of everything (phase 1b, lock
 * order point 0) is the open business_day row (BusinessDayService.lockOpen):
 * FOR SHARE for check-in, check-out, charges, payments and documents, FOR
 * UPDATE only for the day close. book, cancel and assignUnit do not take it,
 * and nothing takes it after a reservation row.
 *   0. the reservation row (cancel, assignUnit) or the (channel, externalId)
 *      advisory lock (book);
 *   1. unit rows (SELECT ... FOR UPDATE, by id), when stays name a unit;
 *   2. scope advisory locks and 3. day rows, through InventoryService.take,
 *      called in scopeOrder and, within a scope, by arrival;
 *   4. the reservation_counter row, last, so numbers stay gapless without
 *      holding the counter while waiting for inventory.
 */
@Injectable()
export class ReservationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly property: PropertyContext,
    private readonly inventory: InventoryService,
    private readonly rates: RatesService,
  ) {}

  // ---- book ----

  async book(input: BookInput, actor: Actor): Promise<BookResult> {
    const data = parseBookInput(input);
    const propertyId = await this.property.id();
    try {
      return await this.db.transaction((tx) => this.bookIn(tx, propertyId, data, actor));
    } catch (err) {
      if (isExclusionViolation(err)) throw unitTaken();
      // The key lock makes this unreachable for one installation; kept as the
      // answer the unique index would give if two writers ever raced anyway.
      if (data.externalId && isUniqueViolation(err) && pgCause(err).constraint === 'reservation_external_idx') {
        const existing = await this.db.transaction((tx) => this.findExternal(tx, propertyId, data));
        if (existing) return existing;
      }
      throw err;
    }
  }

  private async bookIn(tx: Tx, propertyId: string, data: BookInput, actor: Actor): Promise<BookResult> {
    if (data.externalId !== undefined) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${RESERVATION_KEY_LOCK_NS}::int, hashtext(${`${propertyId}:${data.channel}:${data.externalId}`}))`,
      );
      const existing = await this.findExternal(tx, propertyId, data);
      if (existing) return existing;
    }

    // 1–2. Dates, then the units named by a stay, locked.
    const plan = await this.checkStays(tx, propertyId, data, 'lock');

    // 3. Inventory: sold + 1 for every night, scopes in scopeOrder.
    for (const p of inventoryOrder(plan.map((p) => ({ ...p, arrival: p.s.arrival })))) {
      await this.inventory.take(tx, propertyId, p.scope, p.s.arrival, p.s.departure, 'sold', 1);
    }

    // 4. Prices, as agreed now.
    const priced = await this.priceStays(tx, propertyId, plan);

    // 5. Rows: guest, number, reservation, stays and their nights.
    const h = data.holder;
    const { rows: guestRows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO guest (property_id, first_name, last_name, email, phone, language)
      VALUES (${propertyId}, ${h.firstName}, ${h.lastName}, ${h.email ?? null}, ${h.phone ?? null}, ${h.language ?? 'sr'})
      RETURNING id`);
    const number = await this.nextNumber(tx, propertyId, Number(data.stays[0].arrival.slice(0, 4)));
    const { rows: resRows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO reservation (property_id, number, source, channel, external_id, holder_guest_id, status, note, created_by)
      VALUES (${propertyId}, ${number}, ${data.source}, ${data.channel ?? null}, ${data.externalId ?? null},
              ${guestRows[0].id}, 'confirmed', ${data.note ?? null}, ${actor.id})
      RETURNING id`);
    const reservationId = resRows[0].id;

    const stayAudit: Array<Record<string, unknown>> = [];
    for (const p of priced) {
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO stay (property_id, reservation_id, unit_type_id, unit_id, arrival, departure, adults, children, rate_plan_id, status)
        VALUES (${propertyId}, ${reservationId}, ${p.unitTypeId}, ${p.s.unitId ?? null}, ${p.s.arrival}::date, ${p.s.departure}::date,
                ${p.s.adults}, ${p.s.children ?? 0}, ${p.s.ratePlanId}, 'expected')
        RETURNING id`);
      const stayId = rows[0].id;
      // The holder is the primary guest of every stay (spec 5.4).
      await tx.execute(sql`
        INSERT INTO stay_guest (property_id, stay_id, guest_id, is_primary)
        VALUES (${propertyId}, ${stayId}, ${guestRows[0].id}, true)`);
      await tx.execute(sql`
        INSERT INTO stay_night (stay_id, property_id, day, price_minor, rate_plan_id)
        VALUES ${sql.join(
          p.nights.map((n) => sql`(${stayId}, ${propertyId}, ${n.day}::date, ${n.priceMinor}, ${p.s.ratePlanId})`),
          sql`, `,
        )}`);
      stayAudit.push({
        id: stayId,
        unitTypeId: p.unitTypeId,
        unitId: p.s.unitId ?? null,
        arrival: p.s.arrival,
        departure: p.s.departure,
        ratePlanId: p.s.ratePlanId,
        totalMinor: p.nights.reduce((sum, n) => sum + n.priceMinor, 0),
      });
    }

    await this.audit.record(tx, {
      propertyId,
      actorUserId: actor.id,
      action: 'reservation.create',
      entity: 'reservation',
      entityId: reservationId,
      after: {
        number,
        source: data.source,
        channel: data.channel ?? null,
        externalId: data.externalId ?? null,
        status: 'confirmed',
        holder: { guestId: guestRows[0].id, firstName: h.firstName, lastName: h.lastName },
        stays: stayAudit,
      },
    });
    return { reservationId, number };
  }

  // ---- quote ----

  /**
   * What book would charge for the same body, without booking: the same
   * parsing, date rules (validateStayDates) and unit checks, then
   * RatesService.quote per stay. Inside a read-only transaction, so nothing
   * is written: no inventory_day rows, no number, no audit. Availability is
   * not reserved or checked here; book answers no_availability itself.
   */
  async quote(input: unknown): Promise<QuoteView> {
    const data = parseBookInput(input);
    const propertyId = await this.property.id();
    return this.db.transaction(
      async (tx) => {
        const plan = await this.checkStays(tx, propertyId, data, 'read');
        const stays = (await this.priceStays(tx, propertyId, plan)).map((p) => ({
          nights: p.nights,
          totalMinor: p.nights.reduce((sum, n) => sum + n.priceMinor, 0),
        }));
        return { stays, totalMinor: stays.reduce((sum, s) => sum + s.totalMinor, 0) };
      },
      { accessMode: 'read only' },
    );
  }

  /**
   * Steps shared by book and quote, in book's order. 1: the date rules of
   * every stay, before anything is locked or priced. 2: the units named by a
   * stay, read by id (FOR UPDATE when booking: the same row UnitBlocksService
   * locks before checking its stays), then type, active and block checks.
   * Returns each stay with its inventory scope.
   */
  private async checkStays(tx: Tx, propertyId: string, data: BookInput, mode: 'lock' | 'read'): Promise<StayPlan[]> {
    const today = await this.inventory.today(tx, propertyId);
    data.stays.forEach((s, i) => {
      const r = validateStayDates(s.arrival, s.departure, today);
      if (!r.ok) throw new DomainError(r.reason, STAY_DATE_MESSAGES[r.reason], 422, { field: r.field, stay: i });
    });
    // Phase 1b: an arrival before the open business day could never be checked
    // in (check-in needs arrival = business date) and would silently become a
    // no-show; after an evening close that is "today". Read with a plain
    // SELECT: book and quote take no business-day lock and write nothing here;
    // without a row (no day opened yet) there is nothing to check.
    const { rows: open } = await tx.execute<{ day: string }>(sql`
      SELECT day::text AS day FROM business_day WHERE property_id = ${propertyId} AND status = 'open'`);
    const businessDate = open[0]?.day;
    if (businessDate !== undefined) {
      data.stays.forEach((s, i) => {
        if (s.arrival < businessDate) {
          throw new DomainError(
            'arrival_before_business_date',
            `Datum dolaska je pre otvorenog poslovnog dana (${businessDate}).`,
            422,
            { arrival: s.arrival, businessDate, stay: i },
          );
        }
      });
    }

    const units = new Map<string, UnitRow>();
    for (const unitId of [...new Set(data.stays.flatMap((s) => (s.unitId ? [s.unitId] : [])))].sort()) {
      const { rows } = await tx.execute<UnitRow>(
        sql`SELECT id, unit_type_id, active FROM unit WHERE id = ${unitId} AND property_id = ${propertyId}
            ${mode === 'lock' ? sql`FOR UPDATE` : sql``}`,
      );
      if (!rows[0]) throw unitNotFound({ unitId });
      units.set(unitId, rows[0]);
    }
    const plan = data.stays.map((s, i): StayPlan => {
      if (!s.unitId) return { i, s, scope: { kind: 'unit_type', id: s.unitTypeId! }, unitTypeId: s.unitTypeId! };
      const u = units.get(s.unitId)!;
      if (s.unitTypeId && s.unitTypeId !== u.unit_type_id) {
        throw new DomainError('unit_type_mismatch', 'Jedinica nije navedenog tipa.', 422, { stay: i, unitId: s.unitId });
      }
      return { i, s, scope: scopeFor(s.unitId, u.unit_type_id), unitTypeId: u.unit_type_id };
    });
    for (const { i, s } of plan) {
      if (!s.unitId) continue;
      if (!units.get(s.unitId)!.active) {
        throw new DomainError('unit_inactive', 'Jedinica je isključena.', 409, { stay: i, unitId: s.unitId });
      }
      await this.assertNotBlocked(tx, propertyId, s.unitId, s.arrival, s.departure, i);
    }
    return plan;
  }

  /** Every stay priced on its plan; the first night that cannot be sold refuses the whole request. */
  private async priceStays(tx: Tx, propertyId: string, plan: StayPlan[]): Promise<PricedStay[]> {
    const priced: PricedStay[] = [];
    for (const p of plan) {
      const q = await this.rates.quote(tx, propertyId, p.s.ratePlanId, p.scope, p.s.arrival, p.s.departure);
      if (!q.ok) {
        const message = q.reason === 'closed' ? `Noć ${q.day} je zatvorena za prodaju.` : `Nema cene za noć ${q.day}.`;
        throw new DomainError(q.reason, message, 422, { day: q.day, stay: p.i });
      }
      priced.push({ ...p, nights: q.nights.map((n) => ({ day: n.day, priceMinor: n.price.amount_minor })) });
    }
    return priced;
  }

  private async findExternal(tx: Tx, propertyId: string, data: BookInput): Promise<BookResult | null> {
    const { rows } = await tx.execute<{ id: string; number: string }>(sql`
      SELECT id, number FROM reservation
       WHERE property_id = ${propertyId} AND channel = ${data.channel ?? null} AND external_id = ${data.externalId ?? null}`);
    return rows[0] ? { reservationId: rows[0].id, number: rows[0].number } : null;
  }

  /** R-{year}-{000001}: per property and year, gapless (the counter row rolls back with a failed booking). */
  private async nextNumber(tx: Tx, propertyId: string, year: number): Promise<string> {
    const { rows } = await tx.execute<{ last: number }>(sql`
      INSERT INTO reservation_counter (property_id, year, last) VALUES (${propertyId}, ${year}, 1)
      ON CONFLICT (property_id, year) DO UPDATE SET last = reservation_counter.last + 1
      RETURNING last`);
    return `R-${year}-${String(rows[0].last).padStart(6, '0')}`;
  }

  /** 409 unit_blocked when a block of the unit overlaps [arrival, departure). Call with the unit row locked. */
  private async assertNotBlocked(
    tx: Tx,
    propertyId: string,
    unitId: string,
    arrival: string,
    departure: string,
    stay?: number,
  ): Promise<void> {
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM unit_block
       WHERE property_id = ${propertyId} AND unit_id = ${unitId}
         AND period && daterange(${arrival}::date, ${departure}::date, '[)')
       ORDER BY lower(period) LIMIT 1`);
    if (rows[0]) {
      throw new DomainError('unit_blocked', 'Jedinica je blokirana u tom periodu.', 409, {
        unitId,
        blockId: rows[0].id,
        ...(stay === undefined ? {} : { stay }),
      });
    }
  }

  // ---- cancel ----

  async cancel(id: string, expectedVersion: unknown, actor: Actor): Promise<{ id: string; status: 'cancelled'; version: number }> {
    if (!isUuid(id)) throw reservationNotFound();
    const version = versionOf(expectedVersion);
    const propertyId = await this.property.id();

    return this.db.transaction(async (tx) => {
      const r = await this.lockReservation(tx, propertyId, id);
      if (r.version !== version) throw versionConflict(r.version);
      if (r.status !== 'requested' && r.status !== 'confirmed') {
        throw new DomainError('reservation_not_cancellable', 'Rezervacija se ne može otkazati u ovom stanju.', 409, {
          status: r.status,
        });
      }
      const stays = await this.staysOf(tx, propertyId, id);
      if (stays.some((s) => s.status === 'in_house' || s.status === 'checked_out')) {
        throw new DomainError('reservation_not_cancellable', 'Gost je već prijavljen; rezervacija se ne može otkazati.', 409, {
          status: r.status,
        });
      }
      const live = stays.filter((s) => s.status === 'expected').map((s) => ({ ...s, scope: scopeOfStay(s) }));
      for (const s of inventoryOrder(live)) {
        await this.inventory.take(tx, propertyId, s.scope, s.arrival, s.departure, 'sold', -1);
      }
      await tx.execute(sql`
        UPDATE stay SET status = 'cancelled'
         WHERE property_id = ${propertyId} AND reservation_id = ${id} AND status = 'expected'`);
      const next = r.version + 1;
      await tx.execute(sql`
        UPDATE reservation SET status = 'cancelled', version = ${next}
         WHERE id = ${id} AND property_id = ${propertyId}`);
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'reservation.cancel',
        entity: 'reservation',
        entityId: id,
        before: { status: r.status, version: r.version },
        after: { status: 'cancelled', version: next, stays: live.map((s) => s.id) },
      });
      return { id, status: 'cancelled' as const, version: next };
    });
  }

  // ---- assign unit ----

  /**
   * Puts a stay on a unit of its own type. Inventory does not move: the
   * stay's nights stay sold in its type. A stay on a unit without a type is
   * its own scope and cannot move to another unit.
   */
  async assignUnit(
    stayId: string,
    unitId: unknown,
    expectedVersion: unknown,
    actor: Actor,
  ): Promise<{ stayId: string; unitId: string; version: number }> {
    if (!isUuid(stayId)) throw stayNotFound();
    if (typeof unitId !== 'string' || !isUuid(unitId)) throw validationFailed('unitId');
    const unit = unitId.toLowerCase();
    const version = versionOf(expectedVersion);
    const propertyId = await this.property.id();

    try {
      return await this.db.transaction(async (tx) => {
        const { rows: found } = await tx.execute<{ reservation_id: string }>(
          sql`SELECT reservation_id FROM stay WHERE id = ${stayId} AND property_id = ${propertyId}`,
        );
        if (!found[0]) throw stayNotFound();
        const r = await this.lockReservation(tx, propertyId, found[0].reservation_id);
        if (r.version !== version) throw versionConflict(r.version);
        const { rows: stays } = await tx.execute<StayRow>(sql`
          SELECT id, reservation_id, unit_type_id, unit_id, arrival::text AS arrival, departure::text AS departure, status
            FROM stay WHERE id = ${stayId} AND property_id = ${propertyId} FOR UPDATE`);
        const s = stays[0];
        if (s.status !== 'expected' && s.status !== 'in_house') {
          throw new DomainError('stay_not_assignable', 'Boravku se ne može dodeliti jedinica u ovom stanju.', 409, {
            status: s.status,
          });
        }
        const { rows: units } = await tx.execute<UnitRow>(
          sql`SELECT id, unit_type_id, active FROM unit WHERE id = ${unit} AND property_id = ${propertyId} FOR UPDATE`,
        );
        const u = units[0];
        if (!u) throw unitNotFound({ unitId: unit });
        if (!u.active) throw new DomainError('unit_inactive', 'Jedinica je isključena.', 409, { unitId: unit });
        if (s.unit_type_id === null || u.unit_type_id !== s.unit_type_id) {
          throw new DomainError('unit_type_mismatch', 'Jedinica nije tipa koji je rezervisan.', 422, {
            unitId: unit,
            unitTypeId: s.unit_type_id,
          });
        }
        await this.assertNotBlocked(tx, propertyId, unit, s.arrival, s.departure);
        await tx.execute(sql`UPDATE stay SET unit_id = ${unit} WHERE id = ${stayId} AND property_id = ${propertyId}`);
        const next = r.version + 1;
        await tx.execute(sql`
          UPDATE reservation SET version = ${next} WHERE id = ${r.id} AND property_id = ${propertyId}`);
        await this.audit.record(tx, {
          propertyId,
          actorUserId: actor.id,
          action: 'stay.assign_unit',
          entity: 'stay',
          entityId: stayId,
          before: { unitId: s.unit_id, version: r.version },
          after: { unitId: unit, version: next },
        });
        return { stayId, unitId: unit, version: next };
      });
    } catch (err) {
      if (isExclusionViolation(err)) throw unitTaken();
      throw err;
    }
  }

  // ---- reading ----

  async list(query: { from?: unknown; to?: unknown; status?: unknown; q?: unknown }): Promise<ReservationSummary[]> {
    const conds: SQL[] = [];
    const from = query.from === undefined ? undefined : requireDate({ from: query.from }, 'from');
    const to = query.to === undefined ? undefined : requireDate({ to: query.to }, 'to');
    if (from && to && to <= from) throw validationFailed('to', 'Datum "to" mora biti posle datuma "from".');
    if (query.status !== undefined) {
      if (typeof query.status !== 'string' || !(RESERVATION_STATUSES as readonly string[]).includes(query.status)) {
        throw validationFailed('status');
      }
      conds.push(sql`r.status = ${query.status}`);
    }
    const propertyId = await this.property.id();
    if (from || to) {
      conds.push(sql`EXISTS (SELECT 1 FROM stay x
        WHERE x.property_id = ${propertyId} AND x.reservation_id = r.id
          ${to ? sql`AND x.arrival < ${to}::date` : sql``}
          ${from ? sql`AND x.departure > ${from}::date` : sql``})`);
    }
    if (query.q !== undefined) {
      if (typeof query.q !== 'string' || query.q.trim().length > 100) throw validationFailed('q');
      const term = query.q.trim();
      if (term) {
        const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        conds.push(sql`(r.number ILIKE ${like} OR (g.first_name || ' ' || g.last_name) ILIKE ${like}
          OR (g.last_name || ' ' || g.first_name) ILIKE ${like} OR g.email::text ILIKE ${like}
          OR g.phone ILIKE ${like} OR r.external_id ILIKE ${like})`);
      }
    }
    const where = conds.length ? sql`AND ${sql.join(conds, sql` AND `)}` : sql``;
    const { rows } = await this.db.execute<{
      id: string;
      number: string;
      status: ReservationStatus;
      source: ReservationSource;
      version: number;
      first_name: string;
      last_name: string;
      arrival: string;
      departure: string;
      stay_count: number;
    }>(sql`
      SELECT r.id, r.number, r.status, r.source, r.version, g.first_name, g.last_name,
             min(s.arrival)::text AS arrival, max(s.departure)::text AS departure, count(s.id)::int AS stay_count
        FROM reservation r
        JOIN guest g ON g.id = r.holder_guest_id AND g.property_id = r.property_id
        JOIN stay s ON s.reservation_id = r.id AND s.property_id = r.property_id
       WHERE r.property_id = ${propertyId} ${where}
       GROUP BY r.id, g.id
       ORDER BY min(s.arrival), r.number
       LIMIT ${LIST_LIMIT}`);
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      source: r.source,
      holderName: `${r.first_name} ${r.last_name}`,
      arrival: r.arrival,
      departure: r.departure,
      stayCount: r.stay_count,
      version: r.version,
    }));
  }

  async get(id: string): Promise<ReservationView> {
    if (!isUuid(id)) throw reservationNotFound();
    const propertyId = await this.property.id();
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{
        id: string;
        number: string;
        status: ReservationStatus;
        source: ReservationSource;
        channel: string | null;
        external_id: string | null;
        guarantee: string | null;
        note: string | null;
        version: number;
        created_at: Date | string;
        guest_id: string;
        first_name: string;
        last_name: string;
        email: string | null;
        phone: string | null;
        language: string;
      }>(sql`
        SELECT r.id, r.number, r.status, r.source, r.channel, r.external_id, r.guarantee, r.note, r.version, r.created_at,
               g.id AS guest_id, g.first_name, g.last_name, g.email::text AS email, g.phone, g.language
          FROM reservation r
          JOIN guest g ON g.id = r.holder_guest_id AND g.property_id = r.property_id
         WHERE r.id = ${id} AND r.property_id = ${propertyId}`);
      const r = rows[0];
      if (!r) throw reservationNotFound();
      const { rows: stayRows } = await tx.execute<{
        id: string;
        unit_type_id: string | null;
        unit_id: string | null;
        arrival: string;
        departure: string;
        adults: number;
        children: number;
        rate_plan_id: string;
        status: StayStatus;
      }>(sql`
        SELECT id, unit_type_id, unit_id, arrival::text AS arrival, departure::text AS departure, adults, children, rate_plan_id, status
          FROM stay WHERE property_id = ${propertyId} AND reservation_id = ${id}
         ORDER BY arrival, departure, id`);
      const { rows: nightRows } = await tx.execute<{ stay_id: string; day: string; price_minor: string }>(sql`
        SELECT n.stay_id, n.day::text AS day, n.price_minor::text AS price_minor
          FROM stay_night n JOIN stay s ON s.id = n.stay_id AND s.property_id = n.property_id
         WHERE n.property_id = ${propertyId} AND s.reservation_id = ${id}
         ORDER BY n.day`);
      const guests = await stayGuestsOf(tx, propertyId, { reservationId: id });
      const stays: StayView[] = stayRows.map((s) => {
        const nights = nightRows
          .filter((n) => n.stay_id === s.id)
          .map((n) => ({ day: n.day, priceMinor: minorFrom(n.price_minor) }));
        return {
          id: s.id,
          unitTypeId: s.unit_type_id,
          unitId: s.unit_id,
          arrival: s.arrival,
          departure: s.departure,
          adults: s.adults,
          children: s.children,
          ratePlanId: s.rate_plan_id,
          status: s.status,
          nights,
          totalMinor: nights.reduce((sum, n) => sum + n.priceMinor, 0),
          guests: guests.get(s.id) ?? [],
        };
      });
      return {
        id: r.id,
        number: r.number,
        status: r.status,
        source: r.source,
        channel: r.channel,
        externalId: r.external_id,
        guarantee: r.guarantee,
        note: r.note,
        version: r.version,
        createdAt: new Date(r.created_at).toISOString(),
        holder: {
          id: r.guest_id,
          firstName: r.first_name,
          lastName: r.last_name,
          email: r.email,
          phone: r.phone,
          language: r.language,
        },
        stays,
        totalMinor: stays.reduce((sum, s) => sum + s.totalMinor, 0),
      };
    });
  }

  // ---- helpers ----

  private async lockReservation(
    tx: Tx,
    propertyId: string,
    id: string,
  ): Promise<{ id: string; status: ReservationStatus; version: number }> {
    const { rows } = await tx.execute<{ id: string; status: ReservationStatus; version: number }>(
      sql`SELECT id, status, version FROM reservation WHERE id = ${id} AND property_id = ${propertyId} FOR UPDATE`,
    );
    if (!rows[0]) throw reservationNotFound();
    return rows[0];
  }

  private async staysOf(tx: Tx, propertyId: string, reservationId: string): Promise<StayRow[]> {
    const { rows } = await tx.execute<StayRow>(sql`
      SELECT id, reservation_id, unit_type_id, unit_id, arrival::text AS arrival, departure::text AS departure, status
        FROM stay WHERE property_id = ${propertyId} AND reservation_id = ${reservationId}
       ORDER BY arrival, id
         FOR UPDATE`);
    return rows;
  }
}
