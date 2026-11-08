import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../common/audit.service';
import { CLOCK, type Clock } from '../common/clock';
import { DomainError } from '../common/domain-error';
import { isUuid, requireDate } from '../common/input';
import { PropertyContext } from '../common/property-context';
import { DB, type Db, type Tx } from '../db/tokens';
import { FolioNotOpen, FolioService, NightWithoutPrice } from '../folio/folio.service';
import { InventoryService } from '../inventory/inventory.service';
import { rangeOf } from '../rates/rates.service';
import { inventoryOrder, scopeOfStay, type Actor } from '../reservations/reservations.service';
import { BusinessDayService } from './business-day.service';
import { SettingsService } from './settings.service';

// The night audit (spec 5.6): closes the open business day D in one
// transaction. Nothing of it is visible until it commits; any refusal leaves
// the day open and nothing written.
//
// Locks, in the global order (constraints), never backwards:
//   0. the open business_day row FOR UPDATE (lockOpen): every check-in,
//      check-out, charge, payment and document holds it FOR SHARE, so they
//      wait for the close and then post to D + 1, or the close waits for them;
//   1. the reservation rows of the no-show candidates FOR UPDATE, by id;
//      1a. their stays FOR UPDATE, by id, read again under those locks;
//   3./4. the scope advisory lock and inventory_day rows (InventoryService.take),
//      for all no-shows first, in inventoryOrder (preflight F21);
//   6. the folio rows (FolioService.ensureFolio), last, by stay id, for the
//      no-show charges and the in-house nights together.
// cancel (1a) does not take the business day: it can commit between the
// choice of candidates and their reservation locks, so the candidates are read
// again after the locks (a cancelled stay drops out).
//
// The report is a jsonb snapshot stored with the closed day and never
// changed: closing a closed day answers it again (200, alreadyClosed).

export interface NoShowEntry {
  stayId: string;
  number: string;
  guest: string;
  arrival: string;
  chargedMinor: number;
}

export interface AuditReport {
  day: string;
  mode: 'manual' | 'auto';
  closedAt: string;
  closedBy: string | null;
  /** Stays checked in on D. */
  arrivals: number;
  /** Stays checked out on D (normal, early or same-day). */
  departures: number;
  /** In-house stays whose night D was posted by this close. */
  inHouse: number;
  noShows: NoShowEntry[];
  /** Accommodation lines with business date D, with their corrections (preflight F26). */
  roomRevenueMinor: number;
  /** All lines with business date D by kind; a correction counts for the kind it reverses (F26). */
  chargesByKindMinor: Record<string, number>;
  /** Payments (refunds and voids included) with business date D, by method. */
  paymentsByMethodMinor: Record<string, number>;
  /** Accommodation lines this close wrote: in-house nights and no-show first nights. */
  postedNights: number;
}

export interface CloseResult {
  alreadyClosed: boolean;
  report: AuditReport;
}

export interface ClosedDay {
  day: string;
  closedAt: string;
  closedBy: string | null;
  mode: 'manual' | 'auto';
  report: AuditReport;
}

export interface ClosedDaySummary {
  day: string;
  closedAt: string;
  mode: 'manual' | 'auto';
  roomRevenueMinor: number;
  noShows: number;
}

/** The longest range GET /business-days answers, in days. */
export const MAX_LIST_DAYS = 62;

const DAY_MS = 86_400_000;

/** YYYY-MM-DD plus `n` calendar days (UTC arithmetic, no time zone involved). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function minorFrom(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`night audit: amount ${raw} is not a safe integer`);
  return n;
}

const dayNotFound = () => new DomainError('business_day_not_found', 'Poslovni dan nije zatvoren ili ne postoji.', 404);
const closeFailed = (stayId: string, night: string) =>
  new DomainError('close_failed', 'Noćenje nije moglo da se proknjiži; dan je ostao otvoren.', 409, { stayId, night });

type ClosedRow = { day: string; closed_at: string | Date; closed_by: string | null; close_mode: 'manual' | 'auto'; report: AuditReport };

type CandidateStay = {
  id: string;
  reservation_id: string;
  unit_type_id: string | null;
  unit_id: string | null;
  arrival: string;
  departure: string;
  number: string;
  guest: string;
};

@Injectable()
export class NightAuditService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly property: PropertyContext,
    private readonly days: BusinessDayService,
    private readonly settings: SettingsService,
    private readonly folio: FolioService,
    private readonly inventory: InventoryService,
  ) {}

  /** Closes the open business day `day` (YYYY-MM-DD); see the comment at the top. `actor` null: the scheduler. */
  async close(rawDay: unknown, actor: Actor | null, mode: 'manual' | 'auto'): Promise<CloseResult> {
    const day = requireDate({ day: rawDay }, 'day');
    const propertyId = await this.property.id();

    return this.db.transaction(async (tx) => {
      const d = await this.days.lockOpen(tx, propertyId, 'update');
      // Before the mismatch check: a close that waited for another close of
      // the same day gets D + 1 from lockOpen and answers the stored report.
      const stored = await this.closedRow(tx, propertyId, day);
      if (stored) return { alreadyClosed: true, report: stored.report };
      if (day !== d) {
        throw new DomainError('business_day_mismatch', 'Otvoren je drugi poslovni dan; osvežite prikaz.', 409, { open: d });
      }
      const today = await this.inventory.today(tx, propertyId);
      if (d > today) {
        throw new DomainError('business_day_in_future', 'Poslovni dan koji još nije počeo ne može da se zatvori.', 409, {
          day: d,
          today,
        });
      }
      const departures = await this.days.blockersOf(tx, propertyId, d);
      if (departures.length > 0) {
        throw new DomainError('close_blocked', 'Gosti koji odlaze još nisu odjavljeni; odjavite ih pre zatvaranja dana.', 409, {
          departures,
        });
      }

      const noShows = await this.markNoShows(tx, propertyId, d, actor);
      const { noShowCharge } = await this.settings.read(tx, propertyId);
      const { rows: inHouse } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM stay
         WHERE property_id = ${propertyId} AND status = 'in_house'
           AND arrival <= ${d}::date AND departure > ${d}::date
         ORDER BY id`);

      // One folio pass by stay id (lock order point 6): no-show first nights and in-house nights.
      const postings = [
        ...(noShowCharge === 'first_night' ? noShows.map((s) => ({ stayId: s.id, night: s.arrival, source: 'no_show' as const })) : []),
        ...inHouse.map((s) => ({ stayId: s.id, night: d, source: 'night_audit' as const })),
      ].sort((a, b) => (a.stayId < b.stayId ? -1 : a.stayId > b.stayId ? 1 : 0));
      const charged = new Map<string, number>();
      let postedNights = 0;
      for (const p of postings) {
        const priceMinor = await this.post(tx, propertyId, p.stayId, p.night, d, p.source);
        if (priceMinor !== null) {
          postedNights += 1;
          if (p.source === 'no_show') charged.set(p.stayId, priceMinor);
        }
      }

      const closedAt = this.clock().toISOString();
      const report: AuditReport = {
        day: d,
        mode,
        closedAt,
        closedBy: actor?.id ?? null,
        ...(await this.counts(tx, propertyId, d)),
        inHouse: inHouse.length,
        noShows: noShows.map((s) => ({
          stayId: s.id,
          number: s.number,
          guest: s.guest,
          arrival: s.arrival,
          chargedMinor: charged.get(s.id) ?? 0,
        })),
        ...(await this.money(tx, propertyId, d)),
        postedNights,
      };
      await tx.execute(sql`
        UPDATE business_day
           SET status = 'closed', closed_at = ${closedAt}::timestamptz, closed_by = ${actor?.id ?? null}::uuid,
               close_mode = ${mode}, report = ${JSON.stringify(report)}::jsonb, last_auto_error = NULL
         WHERE property_id = ${propertyId} AND day = ${d}::date`);
      const next = addDays(d, 1);
      await tx.execute(sql`
        INSERT INTO business_day (property_id, day, status, opened_at)
        VALUES (${propertyId}, ${next}::date, 'open', ${closedAt}::timestamptz)`);
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor?.id ?? null,
        action: 'business_day.close',
        entity: 'business_day',
        entityId: d,
        before: { day: d, status: 'open' },
        after: { day: d, status: 'closed', mode, next, postedNights, noShows: noShows.length },
      });
      return { alreadyClosed: false, report };
    });
  }

  /** GET /business-days: the closed days of [from, to), at most MAX_LIST_DAYS days, by day. */
  async list(from: unknown, to: unknown): Promise<ClosedDaySummary[]> {
    const range = rangeOf(from, to, MAX_LIST_DAYS);
    const propertyId = await this.property.id();
    const { rows } = await this.db.execute<ClosedRow>(sql`
      SELECT day::text AS day, closed_at, closed_by, close_mode, report FROM business_day
       WHERE property_id = ${propertyId} AND status = 'closed'
         AND day >= ${range.from}::date AND day < ${range.to}::date
       ORDER BY day`);
    return rows.map((r) => ({
      day: r.day,
      closedAt: new Date(r.closed_at).toISOString(),
      mode: r.close_mode,
      roomRevenueMinor: r.report.roomRevenueMinor,
      noShows: r.report.noShows.length,
    }));
  }

  /** GET /business-days/:day: a closed day with its report; anything else is 404. */
  async get(rawDay: string): Promise<ClosedDay> {
    let day: string;
    try {
      day = requireDate({ day: rawDay }, 'day');
    } catch {
      throw dayNotFound();
    }
    const propertyId = await this.property.id();
    const row = await this.closedRow(this.db, propertyId, day);
    if (!row) throw dayNotFound();
    return {
      day: row.day,
      closedAt: new Date(row.closed_at).toISOString(),
      closedBy: row.closed_by,
      mode: row.close_mode,
      report: row.report,
    };
  }

  // ---- steps of close ----

  /**
   * Step 4: expected stays of confirmed reservations with arrival <= D become
   * no_show. Candidates, then their reservations FOR UPDATE by id, then the
   * candidates again under those locks (a cancel may have committed between).
   * Gives their nights back to the inventory (all of them, in inventoryOrder),
   * moves a reservation whose stays are all no-show or cancelled to no_show,
   * and bumps the version of every reservation that lost a stay.
   */
  private async markNoShows(tx: Tx, propertyId: string, d: string, actor: Actor | null): Promise<CandidateStay[]> {
    const { rows: picked } = await tx.execute<{ reservation_id: string }>(sql`
      SELECT DISTINCT s.reservation_id
        FROM stay s JOIN reservation r ON r.property_id = s.property_id AND r.id = s.reservation_id
       WHERE s.property_id = ${propertyId} AND s.status = 'expected' AND s.arrival <= ${d}::date
         AND r.status = 'confirmed'`);
    if (picked.length === 0) return [];
    const ids = picked.map((r) => r.reservation_id).sort();
    const { rows: locked } = await tx.execute<{ id: string; status: string; version: number }>(sql`
      SELECT id, status, version FROM reservation
       WHERE property_id = ${propertyId} AND id = ANY(${uuidArray(ids)})
       ORDER BY id
         FOR UPDATE`);
    const confirmed = locked.filter((r) => r.status === 'confirmed').map((r) => r.id);
    if (confirmed.length === 0) return [];
    const { rows: stays } = await tx.execute<CandidateStay>(sql`
      SELECT s.id, s.reservation_id, s.unit_type_id, s.unit_id, s.arrival::text AS arrival, s.departure::text AS departure,
             r.number, g.first_name || ' ' || g.last_name AS guest
        FROM stay s
        JOIN reservation r ON r.property_id = s.property_id AND r.id = s.reservation_id
        JOIN guest g ON g.property_id = r.property_id AND g.id = r.holder_guest_id
       WHERE s.property_id = ${propertyId} AND s.reservation_id = ANY(${uuidArray(confirmed)})
         AND s.status = 'expected' AND s.arrival <= ${d}::date
       ORDER BY s.id
         FOR UPDATE OF s`);
    if (stays.length === 0) return [];

    for (const s of inventoryOrder(stays.map((s) => ({ ...s, scope: scopeOfStay(s) })))) {
      await this.inventory.take(tx, propertyId, s.scope, s.arrival, s.departure, 'sold', -1);
    }
    await tx.execute(sql`
      UPDATE stay SET status = 'no_show' WHERE property_id = ${propertyId} AND id = ANY(${uuidArray(stays.map((s) => s.id))})`);

    const touched = [...new Set(stays.map((s) => s.reservation_id))].sort();
    const outcome = new Map<string, { status: string; version: number }>();
    for (const id of touched) {
      const r = locked.find((x) => x.id === id)!;
      const { rows: left } = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM stay
         WHERE property_id = ${propertyId} AND reservation_id = ${id} AND status NOT IN ('no_show', 'cancelled')`);
      const status = left[0].n === 0 ? 'no_show' : r.status;
      const version = r.version + 1;
      await tx.execute(sql`
        UPDATE reservation SET status = ${status}, version = ${version} WHERE id = ${id} AND property_id = ${propertyId}`);
      outcome.set(id, { status, version });
    }
    for (const s of stays) {
      const r = locked.find((x) => x.id === s.reservation_id)!;
      const after = outcome.get(s.reservation_id)!;
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor?.id ?? null,
        action: 'stay.no_show',
        entity: 'stay',
        entityId: s.id,
        before: { status: 'expected', reservationStatus: r.status, version: r.version },
        after: { status: 'no_show', reservationStatus: after.status, version: after.version, businessDate: d },
      });
    }
    const key = (s: CandidateStay) => `${s.arrival} ${s.number} ${s.id}`;
    return [...stays].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  }

  /**
   * Posts one night; the price posted, or null when nothing was written
   * (already posted, or priced 0). A night that cannot be posted (no
   * stay_night row, or the folio is not the stay's open folio) is 409
   * close_failed and rolls the whole close back (preflight F13).
   */
  private async post(
    tx: Tx,
    propertyId: string,
    stayId: string,
    night: string,
    d: string,
    source: 'night_audit' | 'no_show',
  ): Promise<number | null> {
    const folio = await this.folio.ensureFolio(tx, propertyId, stayId);
    if (folio.status !== 'open') throw closeFailed(stayId, night);
    let posted: boolean;
    try {
      posted = await this.folio.postNight(tx, propertyId, folio.id, { id: stayId }, night, d, source);
    } catch (err) {
      if (err instanceof NightWithoutPrice || err instanceof FolioNotOpen) throw closeFailed(stayId, night);
      throw err;
    }
    if (!posted) return null;
    const { rows } = await tx.execute<{ amount: string }>(sql`
      SELECT amount_minor::text AS amount FROM folio_line
       WHERE property_id = ${propertyId} AND folio_id = ${folio.id} AND kind = 'accommodation' AND night = ${night}::date`);
    return minorFrom(rows[0].amount);
  }

  private async counts(tx: Tx, propertyId: string, d: string): Promise<{ arrivals: number; departures: number }> {
    const { rows } = await tx.execute<{ arrivals: number; departures: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM stay WHERE property_id = ${propertyId} AND checked_in_business_date = ${d}::date) AS arrivals,
        (SELECT count(*)::int FROM stay WHERE property_id = ${propertyId} AND checked_out_business_date = ${d}::date) AS departures`);
    return rows[0];
  }

  private async money(
    tx: Tx,
    propertyId: string,
    d: string,
  ): Promise<Pick<AuditReport, 'roomRevenueMinor' | 'chargesByKindMinor' | 'paymentsByMethodMinor'>> {
    const { rows: lines } = await tx.execute<{ kind: string; amount: string }>(sql`
      SELECT coalesce(o.kind, l.kind) AS kind, sum(l.amount_minor)::text AS amount
        FROM folio_line l
        LEFT JOIN folio_line o ON o.property_id = l.property_id AND o.id = l.reverses_line_id
       WHERE l.property_id = ${propertyId} AND l.business_date = ${d}::date
       GROUP BY 1 ORDER BY 1`);
    const { rows: payments } = await tx.execute<{ method: string; amount: string }>(sql`
      SELECT method, sum(amount_minor)::text AS amount FROM payment
       WHERE property_id = ${propertyId} AND business_date = ${d}::date
       GROUP BY 1 ORDER BY 1`);
    const chargesByKindMinor: Record<string, number> = {};
    for (const l of lines) chargesByKindMinor[l.kind] = minorFrom(l.amount);
    const paymentsByMethodMinor: Record<string, number> = {};
    for (const p of payments) paymentsByMethodMinor[p.method] = minorFrom(p.amount);
    return { roomRevenueMinor: chargesByKindMinor.accommodation ?? 0, chargesByKindMinor, paymentsByMethodMinor };
  }

  private async closedRow(q: Pick<Db, 'execute'>, propertyId: string, day: string): Promise<ClosedRow | null> {
    const { rows } = await q.execute<ClosedRow>(sql`
      SELECT day::text AS day, closed_at, closed_by, close_mode, report FROM business_day
       WHERE property_id = ${propertyId} AND day = ${day}::date AND status = 'closed'`);
    return rows[0] ?? null;
  }
}

/** ids read from the database as one uuid[] parameter; each is checked first. */
function uuidArray(ids: string[]) {
  for (const id of ids) if (!isUuid(id)) throw new Error(`night audit: bad id ${id}`);
  return sql`${`{${ids.join(',')}}`}::uuid[]`;
}
