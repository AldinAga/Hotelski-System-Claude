import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PropertyContext } from '../common/property-context';
import { DB, type Db } from '../db/tokens';
import { rangeOf } from '../rates/rates.service';
import type { Scope } from '../inventory/inventory.service';

/** The most days one calendar request may cover. */
export const CALENDAR_MAX_DAYS = 62;

/**
 * A bar overlapping the range, with its real dates: arrival/departure and
 * from/to are not clipped to the range (the client clips for drawing).
 * reservationId, number and guest are null when the caller may not see guest
 * details (housekeeping).
 */
export type CalendarBar =
  | {
      kind: 'stay';
      stayId: string;
      reservationId: string | null;
      number: string | null;
      guest: string | null;
      arrival: string;
      departure: string;
      status: string;
    }
  | { kind: 'block'; blockId: string; from: string; to: string; reason: string };

export interface CalendarView {
  days: string[];
  availability: Array<{ scope: Scope; label: string; free: number[] }>;
  units: Array<{ id: string; name: string; unitTypeId: string | null; cleanliness: string; bars: CalendarBar[] }>;
  unassigned: Array<{
    stayId: string;
    reservationId: string | null;
    number: string | null;
    guest: string | null;
    unitTypeId: string;
    arrival: string;
    departure: string;
    /**
     * The reservation's version, for POST /stays/:id/assign-unit (optimistic
     * check); null without guest details (that role cannot assign).
     */
    version: number | null;
  }>;
}

export interface CalendarOptions {
  /** false: reservation id, number, guest name and version are null (housekeeping). */
  guestDetails: boolean;
}

interface UnitRow {
  id: string;
  name: string;
  unit_type_id: string | null;
  cleanliness: string;
  type_label: string | null;
  [column: string]: unknown;
}

interface LedgerRow {
  scope_kind: Scope['kind'];
  scope_id: string;
  day: string;
  total: number;
  sold: number;
  blocked: number;
  [column: string]: unknown;
}

interface BarRow {
  kind: 'stay' | 'block';
  id: string;
  reservation_id: string | null;
  number: string | null;
  guest: string | null;
  unit_id: string | null;
  unit_type_id: string | null;
  from_day: string;
  to_day: string;
  status: string | null;
  reason: string | null;
  version: number | null;
  [column: string]: unknown;
}

const DAY_MS = 86_400_000;

function daysOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t < Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * The front-desk calendar (read only). Three queries inside one read-only
 * snapshot, whatever the number of units: the active units, the stored
 * inventory_day rows of the range, and the stays and blocks overlapping it.
 * Nothing is written: a day without an inventory_day row counts the active
 * units now, which is exactly the total InventoryService.lockDays would
 * insert for it (no row also means nothing sold or blocked on that day).
 */
@Injectable()
export class CalendarService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly property: PropertyContext,
  ) {}

  async view(fromRaw: unknown, toRaw: unknown, opts: CalendarOptions): Promise<CalendarView> {
    const { from, to } = rangeOf(fromRaw, toRaw, CALENDAR_MAX_DAYS);
    const propertyId = await this.property.id();
    const days = daysOf(from, to);

    const [unitRows, ledgerRows, barRows] = await this.db.transaction(
      async (tx) => {
        const units = await tx.execute<UnitRow>(sql`
          SELECT u.id, u.name, u.unit_type_id, u.cleanliness, ut.name->>'sr' AS type_label
            FROM unit u
            LEFT JOIN unit_type ut ON ut.property_id = u.property_id AND ut.id = u.unit_type_id
           WHERE u.property_id = ${propertyId} AND u.active
           ORDER BY u.name`);
        const ledger = await tx.execute<LedgerRow>(sql`
          SELECT scope_kind, scope_id, day::text AS day, total, sold, blocked
            FROM inventory_day
           WHERE property_id = ${propertyId} AND day >= ${from}::date AND day < ${to}::date`);
        const bars = await tx.execute<BarRow>(sql`
          SELECT 'stay' AS kind, s.id, s.reservation_id, r.number,
                 g.first_name || ' ' || g.last_name AS guest, s.unit_id, s.unit_type_id,
                 s.arrival::text AS from_day, s.departure::text AS to_day, s.status, NULL::text AS reason, r.version
            FROM stay s
            JOIN reservation r ON r.property_id = s.property_id AND r.id = s.reservation_id
            JOIN guest g ON g.property_id = r.property_id AND g.id = r.holder_guest_id
           WHERE s.property_id = ${propertyId} AND s.status NOT IN ('cancelled', 'no_show') AND r.status NOT IN ('cancelled', 'no_show')
             AND s.arrival < ${to}::date AND s.departure > ${from}::date
          UNION ALL
          SELECT 'block', b.id, NULL::uuid, NULL::text, NULL::text, b.unit_id, NULL::uuid,
                 lower(b.period)::text, upper(b.period)::text, NULL::text, b.reason, NULL::int
            FROM unit_block b
           WHERE b.property_id = ${propertyId} AND b.period && daterange(${from}::date, ${to}::date)
          ORDER BY from_day, id`);
        return [units.rows, ledger.rows, bars.rows] as const;
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    // Availability: one entry per scope that has an active unit.
    const scopes = new Map<string, { scope: Scope; label: string; total: number }>();
    for (const u of unitRows) {
      const scope: Scope = u.unit_type_id ? { kind: 'unit_type', id: u.unit_type_id } : { kind: 'unit', id: u.id };
      const key = `${scope.kind}:${scope.id}`;
      const entry = scopes.get(key);
      if (entry) entry.total += 1;
      else scopes.set(key, { scope, label: u.unit_type_id ? (u.type_label ?? u.name) : u.name, total: 1 });
    }
    const stored = new Map<string, LedgerRow>();
    for (const l of ledgerRows) stored.set(`${l.scope_kind}:${l.scope_id}:${l.day}`, l);
    const availability = [...scopes.entries()]
      .map(([key, { scope, label, total }]) => ({
        scope,
        label,
        free: days.map((day) => {
          const row = stored.get(`${key}:${day}`);
          return row ? row.total - row.sold - row.blocked : total;
        }),
      }))
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.scope.id < b.scope.id ? -1 : 1));

    // Bars keep their real dates (not clipped to [from, to)): a bar may start
    // before the first day or end after the last, and the client clips it for
    // drawing. That is how the screen knows a stay goes on beyond the range.
    const barsByUnit = new Map<string, CalendarBar[]>();
    const unassigned: CalendarView['unassigned'] = [];
    for (const r of barRows) {
      const span = { from: r.from_day, to: r.to_day };
      if (r.kind === 'block') {
        push(barsByUnit, r.unit_id as string, {
          kind: 'block',
          blockId: r.id,
          from: span.from,
          to: span.to,
          reason: r.reason as string,
        });
        continue;
      }
      const details = opts.guestDetails;
      const common = {
        stayId: r.id,
        reservationId: details ? (r.reservation_id as string) : null,
        number: details ? (r.number as string) : null,
        guest: details ? (r.guest as string) : null,
        arrival: span.from,
        departure: span.to,
      };
      if (r.unit_id) push(barsByUnit, r.unit_id, { kind: 'stay', ...common, status: r.status as string });
      else
        unassigned.push({
          ...common,
          unitTypeId: r.unit_type_id as string,
          version: details ? (r.version as number) : null,
        });
    }

    return {
      days,
      availability,
      units: unitRows.map((u) => ({
        id: u.id,
        name: u.name,
        unitTypeId: u.unit_type_id,
        cleanliness: u.cleanliness,
        bars: barsByUnit.get(u.id) ?? [],
      })),
      unassigned,
    };
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
