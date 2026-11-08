import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BusinessDayService } from '../business-day/business-day.service';
import { AuditService } from '../common/audit.service';
import { CLOCK, type Clock } from '../common/clock';
import { DomainError } from '../common/domain-error';
import { isUuid } from '../common/input';
import { PropertyContext } from '../common/property-context';
import { DB, type Db, type Tx } from '../db/tokens';
import { FolioService } from '../folio/folio.service';
import { GuestsService } from '../guests/guests.service';
import { InventoryService } from '../inventory/inventory.service';
import { scopeOfStay, versionConflict, versionOf, type Actor, type StayStatus } from '../reservations/reservations.service';

// Check-in and check-out of a stay (spec 5.4-5.6), against the open business
// day and the stay's folio.
//
// Locks, always in the global order (constraints), never backwards:
//   0. the open business_day row FOR SHARE (BusinessDayService.lockOpen),
//      which also gives the business date B of everything written here;
//   1. the reservation row FOR UPDATE (its version moves with check-in and
//      check-out); 1a. the stay row FOR UPDATE, after its reservation;
//   2. the unit row FOR UPDATE (check-in only: active and not blocked);
//   3. the scope advisory lock and 4. the inventory_day rows, through
//      InventoryService.take (check-out with an early departure only);
//   5. counters: none here;
//   6. the folio row FOR UPDATE (FolioService.ensureFolio), last.
// A payment takes 0 and then 6, so a payment and a check-out of one stay meet
// at the folio row: the check-out sees the payment's line in its balance, or
// the payment waits and then finds the folio closed (409 folio_closed).
//
// The preview is a GET and writes nothing (constraints): no lockOpen, no
// ensureFolio; it reads the open day plainly and the folio if there is one.

export interface CheckOutPreview {
  businessDate: string;
  /** The departure the stay keeps: max(B, arrival + 1 day). */
  keptUntil: string;
  earlyDeparture: boolean;
  /** Nights before keptUntil without an accommodation line, priced above 0. */
  nightsToPost: Array<{ night: string; priceMinor: number }>;
  /** Nights from keptUntil to the booked departure, given back on an early departure. */
  nightsToRelease: string[];
  /** The folio balance after nightsToPost are posted; check-out needs 0. */
  balanceMinor: number;
}

type ReservationRow = { id: string; status: string; version: number };
type StayRow = {
  id: string;
  reservation_id: string;
  unit_type_id: string | null;
  unit_id: string | null;
  arrival: string;
  departure: string;
  status: StayStatus;
};

const stayNotFound = () => new DomainError('stay_not_found', 'Boravak ne postoji.', 404);
const stayNotInHouse = (status: string) =>
  new DomainError('stay_not_in_house', 'Odjaviti se može samo gost koji je prijavljen.', 409, { status });

const DAY_MS = 86_400_000;

/** YYYY-MM-DD plus `n` calendar days (UTC arithmetic, no time zone involved). */
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Every day of [from, to). */
function daysOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
  return out;
}

@Injectable()
export class StayLifecycleService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly property: PropertyContext,
    private readonly days: BusinessDayService,
    private readonly folio: FolioService,
    private readonly guests: GuestsService,
    private readonly inventory: InventoryService,
  ) {}

  // ---- check-in ----

  async checkIn(stayId: string, expectedVersion: unknown, actor: Actor): Promise<{ stayId: string; status: 'in_house'; version: number }> {
    if (!isUuid(stayId)) throw stayNotFound();
    const version = versionOf(expectedVersion);
    const propertyId = await this.property.id();

    return this.db.transaction(async (tx) => {
      const businessDate = await this.days.lockOpen(tx, propertyId, 'share');
      const r = await this.lockReservationOf(tx, propertyId, stayId);
      if (r.version !== version) throw versionConflict(r.version);
      if (r.status !== 'confirmed') {
        throw new DomainError('reservation_not_confirmed', 'Rezervacija nije potvrđena.', 409, { status: r.status });
      }
      const s = await this.lockStay(tx, propertyId, stayId);
      if (s.status !== 'expected') {
        throw new DomainError('stay_not_expected', 'Prijaviti se može samo boravak koji se očekuje.', 409, { status: s.status });
      }
      if (s.arrival !== businessDate) {
        throw new DomainError(
          'check_in_wrong_day',
          `Prijava je moguća samo na dan dolaska (${s.arrival}); otvoren poslovni dan je ${businessDate}.`,
          409,
          { arrival: s.arrival, businessDate },
        );
      }
      if (s.unit_id === null) {
        throw new DomainError('unit_required', 'Pre prijave boravku treba dodeliti jedinicu.', 422);
      }
      const unitId = s.unit_id;
      const { rows: units } = await tx.execute<{ active: boolean }>(
        sql`SELECT active FROM unit WHERE id = ${unitId} AND property_id = ${propertyId} FOR UPDATE`,
      );
      if (!units[0]?.active) throw new DomainError('unit_inactive', 'Jedinica je isključena.', 409, { unitId });
      // Book and assign-unit already refuse blocked units, and a block cannot
      // cover a live stay (unit_occupied); this guards data from phase 1a.
      const { rows: blocks } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM unit_block
         WHERE property_id = ${propertyId} AND unit_id = ${unitId}
           AND period && daterange(${businessDate}::date, ${s.departure}::date, '[)')
         ORDER BY lower(period) LIMIT 1`);
      if (blocks[0]) {
        throw new DomainError('unit_blocked', 'Jedinica je blokirana u tom periodu.', 409, { unitId, blockId: blocks[0].id });
      }

      const at = this.clock().toISOString();
      await tx.execute(sql`
        UPDATE stay SET status = 'in_house', checked_in_at = ${at}::timestamptz, checked_in_by = ${actor.id},
                        checked_in_business_date = ${businessDate}::date
         WHERE id = ${stayId} AND property_id = ${propertyId}`);
      await this.guests.ensurePrimary(tx, propertyId, stayId);
      const folio = await this.folio.ensureFolio(tx, propertyId, stayId);
      const next = r.version + 1;
      await tx.execute(sql`UPDATE reservation SET version = ${next} WHERE id = ${r.id} AND property_id = ${propertyId}`);
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'stay.check_in',
        entity: 'stay',
        entityId: stayId,
        before: { status: s.status, version: r.version },
        after: { status: 'in_house', version: next, businessDate, unitId, folioId: folio.id },
      });
      return { stayId, status: 'in_house' as const, version: next };
    });
  }

  // ---- check-out ----

  /** What check-out would do now, without doing it: reads only. */
  async checkOutPreview(stayId: string): Promise<CheckOutPreview> {
    if (!isUuid(stayId)) throw stayNotFound();
    const propertyId = await this.property.id();
    return this.db.transaction(
      async (tx) => {
        const s = await this.readStay(tx, propertyId, stayId);
        if (s.status !== 'in_house') throw stayNotInHouse(s.status);
        const { rows: open } = await tx.execute<{ day: string }>(sql`
          SELECT day::text AS day FROM business_day WHERE property_id = ${propertyId} AND status = 'open'`);
        // An in-house stay implies an opened day (check-in took it); today is the fallback a GET may show.
        const businessDate = open[0]?.day ?? (await this.inventory.today(tx, propertyId));
        const plan = this.plan(s, businessDate);
        const nightsToPost = await this.folio.unpostedNights(tx, propertyId, stayId, plan.keptUntil);
        const { rows: folios } = await tx.execute<{ id: string }>(sql`
          SELECT id FROM folio WHERE property_id = ${propertyId} AND stay_id = ${stayId}`);
        const current = folios[0] ? (await this.folio.balanceOf(tx, folios[0].id)).balanceMinor : 0;
        return {
          businessDate,
          keptUntil: plan.keptUntil,
          earlyDeparture: plan.earlyDeparture,
          nightsToPost,
          nightsToRelease: plan.nightsToRelease,
          balanceMinor: nightsToPost.reduce((sum, n) => sum + n.priceMinor, current),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async checkOut(
    stayId: string,
    expectedVersion: unknown,
    actor: Actor,
  ): Promise<{ stayId: string; status: 'checked_out'; version: number; departure: string }> {
    if (!isUuid(stayId)) throw stayNotFound();
    const version = versionOf(expectedVersion);
    const propertyId = await this.property.id();

    return this.db.transaction(async (tx) => {
      const businessDate = await this.days.lockOpen(tx, propertyId, 'share');
      const r = await this.lockReservationOf(tx, propertyId, stayId);
      if (r.version !== version) throw versionConflict(r.version);
      const s = await this.lockStay(tx, propertyId, stayId);
      if (s.status !== 'in_house') throw stayNotInHouse(s.status);
      const { keptUntil, earlyDeparture, nightsToRelease } = this.plan(s, businessDate);

      if (earlyDeparture) {
        // The unused nights go back to the inventory; the stay ends at keptUntil
        // and its agreed nights from then on are dropped (they are not folio
        // rows; the audit keeps the old departure and the dropped nights).
        await this.inventory.take(tx, propertyId, scopeOfStay(s), keptUntil, s.departure, 'sold', -1);
        await tx.execute(sql`
          UPDATE stay SET departure = ${keptUntil}::date WHERE id = ${stayId} AND property_id = ${propertyId}`);
        await tx.execute(sql`
          DELETE FROM stay_night WHERE property_id = ${propertyId} AND stay_id = ${stayId} AND day >= ${keptUntil}::date`);
      }

      const folio = await this.folio.ensureFolio(tx, propertyId, stayId);
      if (folio.status !== 'open') throw new Error(`stays: in-house stay ${stayId} has a closed folio`);
      const postedNights: string[] = [];
      for (const { night } of await this.folio.unpostedNights(tx, propertyId, stayId, keptUntil)) {
        if (await this.folio.postNight(tx, propertyId, folio.id, { id: stayId }, night, businessDate, 'check_out')) {
          postedNights.push(night);
        }
      }
      const { balanceMinor } = await this.folio.balanceOf(tx, folio.id);
      if (balanceMinor !== 0) {
        // Thrown inside the transaction: the posted nights and the inventory roll back with it.
        throw new DomainError('folio_balance_open', 'Saldo folija mora biti nula pre odjave.', 409, { balanceMinor });
      }

      const at = this.clock().toISOString();
      await tx.execute(sql`
        UPDATE stay SET status = 'checked_out', checked_out_at = ${at}::timestamptz, checked_out_by = ${actor.id},
                        checked_out_business_date = ${businessDate}::date
         WHERE id = ${stayId} AND property_id = ${propertyId}`);
      await tx.execute(sql`
        UPDATE folio SET status = 'closed', closed_at = ${at}::timestamptz
         WHERE id = ${folio.id} AND property_id = ${propertyId}`);
      const next = r.version + 1;
      await tx.execute(sql`UPDATE reservation SET version = ${next} WHERE id = ${r.id} AND property_id = ${propertyId}`);
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'stay.check_out',
        entity: 'stay',
        entityId: stayId,
        before: { status: s.status, departure: s.departure, version: r.version },
        after: {
          status: 'checked_out',
          departure: keptUntil,
          version: next,
          businessDate,
          folioId: folio.id,
          earlyDeparture,
          releasedNights: nightsToRelease,
          postedNights,
        },
      });
      return { stayId, status: 'checked_out' as const, version: next, departure: keptUntil };
    });
  }

  // ---- helpers ----

  /** keptUntil = max(B, arrival + 1 day); with B ≤ departure (Task 6), keptUntil ≤ departure. */
  private plan(s: StayRow, businessDate: string): { keptUntil: string; earlyDeparture: boolean; nightsToRelease: string[] } {
    const minimum = addDays(s.arrival, 1);
    const keptUntil = businessDate > minimum ? businessDate : minimum;
    const earlyDeparture = keptUntil < s.departure;
    return { keptUntil, earlyDeparture, nightsToRelease: earlyDeparture ? daysOf(keptUntil, s.departure) : [] };
  }

  /** Lock order point 1: the stay's reservation FOR UPDATE; 404 stay_not_found. */
  private async lockReservationOf(tx: Tx, propertyId: string, stayId: string): Promise<ReservationRow> {
    const { rows: found } = await tx.execute<{ reservation_id: string }>(
      sql`SELECT reservation_id FROM stay WHERE id = ${stayId} AND property_id = ${propertyId}`,
    );
    if (!found[0]) throw stayNotFound();
    const { rows } = await tx.execute<ReservationRow>(sql`
      SELECT id, status, version FROM reservation
       WHERE id = ${found[0].reservation_id} AND property_id = ${propertyId} FOR UPDATE`);
    return rows[0];
  }

  /** Lock order point 1a: the stay row, read again under its lock. */
  private async lockStay(tx: Tx, propertyId: string, stayId: string): Promise<StayRow> {
    return this.readStay(tx, propertyId, stayId, true);
  }

  private async readStay(tx: Tx, propertyId: string, stayId: string, lock = false): Promise<StayRow> {
    const { rows } = await tx.execute<StayRow>(sql`
      SELECT id, reservation_id, unit_type_id, unit_id, arrival::text AS arrival, departure::text AS departure, status
        FROM stay WHERE id = ${stayId} AND property_id = ${propertyId}
        ${lock ? sql`FOR UPDATE` : sql``}`);
    if (!rows[0]) throw stayNotFound();
    return rows[0];
  }
}
