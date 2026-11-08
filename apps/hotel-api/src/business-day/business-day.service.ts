import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../common/clock';
import { PropertyContext } from '../common/property-context';
import { DB, type Db, type Tx } from '../db/tokens';
import { localDate } from '../inventory/inventory.service';

// The business day (spec 5.6): the one open day of the property, the date
// every folio posting, payment and document carries. It is not the calendar
// date: it moves only when the night audit closes the day (Task 6).
//
// Lock order point 0 (constraints): a transaction that posts to a folio,
// checks a guest in or out, or issues a document takes the open day's row
// FOR SHARE first, before any reservation row; only the day close takes it
// FOR UPDATE. Those transactions therefore never post to a day that is being
// closed, and a close waits for them. book, cancel and assignUnit (1a) do not
// take it.
//
// A GET never writes (constraints): the row is created only by lockOpen,
// inside a transaction that changes data.

export interface BusinessDayView {
  /** The open business day, or today when none was opened yet. YYYY-MM-DD. */
  day: string;
  /** The property's calendar date now (CLOCK, property timezone). */
  today: string;
  /** False until the first writing transaction opened a day. */
  started: boolean;
  /** today − day, in days: how far the business day lags behind the calendar. */
  lagDays: number;
  lastClosed: { day: string; closedAt: string; mode: 'manual' | 'auto' } | null;
  lastAutoError: { at: string; code: string; details: unknown } | null;
  /** In-house stays due to leave on or before `day`: the close is refused while there are any. */
  blockers: CloseBlocker[];
  pending: BusinessDayPending;
}

/** One guest who blocks the close (also the details of 409 close_blocked). */
export interface CloseBlocker {
  stayId: string;
  reservationId: string;
  number: string;
  unitName: string | null;
  departure: string;
}

/** Counts for the open day, as the night audit would see them now. */
export type BusinessDayPending = {
  /** Stays checked in on this business day. */
  arrivals: number;
  /** Stays checked out on this business day. */
  departures: number;
  /** Stays in house now. */
  inHouse: number;
  /** In-house stays whose night `day` the close would post (arrival <= day < departure). */
  nightsToPost: number;
  /** Expected stays of confirmed reservations with arrival <= day: the close marks them no-show (preflight F39). */
  noShows: number;
};

/** Retries of lockOpen; see the comment there. */
const LOCK_ROUNDS = 3;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

@Injectable()
export class BusinessDayService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly property: PropertyContext,
  ) {}

  /**
   * Returns the open business day (YYYY-MM-DD) and holds its row FOR SHARE or
   * FOR UPDATE until the end of `tx`. Without an open row (a fresh
   * installation) it first opens the property's today. Call only from
   * transactions that write.
   *
   * Under READ COMMITTED a SELECT ... FOR UPDATE that waited for a day close
   * does not see the next day's row (its snapshot is older) and returns
   * nothing; so the body is a loop: locked SELECT, if empty INSERT ... ON
   * CONFLICT DO NOTHING, then SELECT again as a new statement. At most
   * LOCK_ROUNDS rounds. Every query runs on `tx`: callers hold one pooled
   * client each.
   */
  async lockOpen(tx: Tx, propertyId: string, mode: 'share' | 'update'): Promise<string> {
    const lock = mode === 'update' ? sql`FOR UPDATE` : sql`FOR SHARE`;
    for (let round = 0; round < LOCK_ROUNDS; round++) {
      const { rows } = await tx.execute<{ day: string }>(sql`
        SELECT day::text AS day FROM business_day
         WHERE property_id = ${propertyId} AND status = 'open'
         ${lock}`);
      if (rows[0]) return rows[0].day;
      const now = this.clock();
      const today = await this.todayIn(tx, propertyId, now);
      await tx.execute(sql`
        INSERT INTO business_day (property_id, day, status, opened_at)
        VALUES (${propertyId}, ${today}::date, 'open', ${now.toISOString()}::timestamptz)
        ON CONFLICT DO NOTHING`);
    }
    throw new Error(`business day: no open day for property ${propertyId} after ${LOCK_ROUNDS} rounds`);
  }

  /**
   * Reads only, in one repeatable-read snapshot: without a row the day is
   * today and `started` is false. `blockers` and `pending` describe what the
   * night audit would find for the open day now.
   */
  async view(): Promise<BusinessDayView> {
    const propertyId = await this.property.id();
    return this.db.transaction(
      async (tx) => {
        const today = await this.todayIn(tx, propertyId, this.clock());
        const { rows: open } = await tx.execute<{ day: string; last_auto_error: BusinessDayView['lastAutoError'] }>(sql`
          SELECT day::text AS day, last_auto_error FROM business_day
           WHERE property_id = ${propertyId} AND status = 'open'`);
        const { rows: closed } = await tx.execute<{ day: string; closed_at: string | Date; close_mode: 'manual' | 'auto' }>(sql`
          SELECT day::text AS day, closed_at, close_mode FROM business_day
           WHERE property_id = ${propertyId} AND status = 'closed'
           ORDER BY day DESC LIMIT 1`);
        const day = open[0]?.day ?? today;
        const last = closed[0];
        return {
          day,
          today,
          started: open.length > 0,
          lagDays: daysBetween(day, today),
          lastClosed: last ? { day: last.day, closedAt: new Date(last.closed_at).toISOString(), mode: last.close_mode } : null,
          lastAutoError: open[0]?.last_auto_error ?? null,
          blockers: await this.blockersOf(tx, propertyId, day),
          pending: await this.pendingOf(tx, propertyId, day),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  /**
   * Guests still in the house whose departure is on or before `day`: they
   * block the close of `day` (spec 5.6). By departure, then reservation number.
   */
  async blockersOf(q: Pick<Db, 'execute'>, propertyId: string, day: string): Promise<CloseBlocker[]> {
    const { rows } = await q.execute<{
      stay_id: string;
      reservation_id: string;
      number: string;
      unit_name: string | null;
      departure: string;
    }>(sql`
      SELECT s.id AS stay_id, s.reservation_id, r.number, u.name AS unit_name, s.departure::text AS departure
        FROM stay s
        JOIN reservation r ON r.property_id = s.property_id AND r.id = s.reservation_id
        LEFT JOIN unit u ON u.property_id = s.property_id AND u.id = s.unit_id
       WHERE s.property_id = ${propertyId} AND s.status = 'in_house' AND s.departure <= ${day}::date
       ORDER BY s.departure, r.number, s.id`);
    return rows.map((r) => ({
      stayId: r.stay_id,
      reservationId: r.reservation_id,
      number: r.number,
      unitName: r.unit_name,
      departure: r.departure,
    }));
  }

  /** What the close of `day` would count and do now, read only (preflight F39). */
  async pendingOf(q: Pick<Db, 'execute'>, propertyId: string, day: string): Promise<BusinessDayPending> {
    const { rows } = await q.execute<BusinessDayPending>(sql`
      SELECT
        (SELECT count(*)::int FROM stay
          WHERE property_id = ${propertyId} AND checked_in_business_date = ${day}::date) AS arrivals,
        (SELECT count(*)::int FROM stay
          WHERE property_id = ${propertyId} AND checked_out_business_date = ${day}::date) AS departures,
        (SELECT count(*)::int FROM stay WHERE property_id = ${propertyId} AND status = 'in_house') AS "inHouse",
        (SELECT count(*)::int FROM stay
          WHERE property_id = ${propertyId} AND status = 'in_house'
            AND arrival <= ${day}::date AND departure > ${day}::date) AS "nightsToPost",
        (SELECT count(*)::int FROM stay s
           JOIN reservation r ON r.property_id = s.property_id AND r.id = s.reservation_id
          WHERE s.property_id = ${propertyId} AND s.status = 'expected' AND s.arrival <= ${day}::date
            AND r.status = 'confirmed') AS "noShows"`);
    return rows[0];
  }

  /** The property's calendar date at `at` (CLOCK, never SQL now()). */
  private async todayIn(q: Pick<Db, 'execute'>, propertyId: string, at: Date): Promise<string> {
    const { rows } = await q.execute<{ timezone: string }>(sql`SELECT timezone FROM property WHERE id = ${propertyId}`);
    if (!rows[0]) throw new Error(`business day: property ${propertyId} not found`);
    return localDate(at, rows[0].timezone);
  }
}
