// Shapes hotel-api returns (apps/hotel-api/src/**/*.service.ts views).

export interface LocalizedText {
  sr: string;
  en?: string;
}

export interface UnitType {
  id: string;
  code: string;
  name: LocalizedText;
  capacity: number;
  beds: string | null;
  description: Partial<LocalizedText> | null;
  active: boolean;
}

export interface Unit {
  id: string;
  name: string;
  unitTypeId: string | null;
  address: string | null;
  municipality: string | null;
  eturistaObjectId: string | null;
  active: boolean;
  cleanliness: 'clean' | 'dirty' | 'inspected';
}

export type BlockReason = 'maintenance' | 'owner_use' | 'other';

export interface UnitBlock {
  id: string;
  unitId: string;
  /** First blocked night. */
  from: string;
  /** Exclusive: the first free night. */
  to: string;
  reason: BlockReason;
}

/**
 * GET /calendar bars carry their real dates: a stay or block may start
 * before the first requested day or end after the last. The grid clips them
 * for drawing (spanOf in components/calendar-grid.tsx).
 */
export type CalendarBar =
  | {
      kind: 'stay';
      stayId: string;
      reservationId: string;
      number: string;
      guest: string;
      arrival: string;
      departure: string;
      status: string;
    }
  | { kind: 'block'; blockId: string; from: string; to: string; reason: BlockReason };

export interface UnassignedStay {
  stayId: string;
  reservationId: string;
  number: string;
  guest: string;
  unitTypeId: string;
  arrival: string;
  departure: string;
  /** The reservation's version when the calendar was read: sent with assign-unit. */
  version: number;
}

export interface CalendarView {
  days: string[];
  availability: Array<{ scope: Scope; label: string; free: number[] }>;
  units: Array<{ id: string; name: string; unitTypeId: string | null; cleanliness: string; bars: CalendarBar[] }>;
  unassigned: UnassignedStay[];
}

export type ReservationStatus = 'requested' | 'confirmed' | 'cancelled' | 'no_show';
export type StayStatus = 'expected' | 'in_house' | 'checked_out' | 'cancelled';

export interface PricedNight {
  day: string;
  priceMinor: number;
}

export interface Reservation {
  id: string;
  number: string;
  status: ReservationStatus;
  source: string;
  channel: string | null;
  externalId: string | null;
  note: string | null;
  version: number;
  createdAt: string;
  holder: { id: string; firstName: string; lastName: string; email: string | null; phone: string | null; language: string };
  stays: Array<{
    id: string;
    unitTypeId: string | null;
    unitId: string | null;
    arrival: string;
    departure: string;
    adults: number;
    children: number;
    ratePlanId: string;
    status: StayStatus;
    nights: PricedNight[];
    totalMinor: number;
  }>;
  totalMinor: number;
}

/** POST /reservations/quote */
export interface Quote {
  stays: Array<{ nights: PricedNight[]; totalMinor: number }>;
  totalMinor: number;
}

export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  requested: 'Na upitu',
  confirmed: 'Potvrđena',
  cancelled: 'Otkazana',
  no_show: 'Gost nije došao',
};

export const STAY_STATUS_LABELS: Record<StayStatus, string> = {
  expected: 'Očekuje se',
  in_house: 'U objektu',
  checked_out: 'Odjavljen',
  cancelled: 'Otkazan',
};

export type Board = 'RO' | 'BB' | 'HB' | 'FB';

export interface RatePlan {
  id: string;
  code: string;
  name: LocalizedText;
  board: Board;
  cancellationPolicy: Record<string, unknown> | null;
  discount7Pct: number;
  discount30Pct: number;
  active: boolean;
}

export interface RateDay {
  day: string;
  priceMinor: number | null;
  closed: boolean;
}

export type Scope = { kind: 'unit_type' | 'unit'; id: string };

export const BLOCK_REASONS: Array<{ value: BlockReason; label: string }> = [
  { value: 'maintenance', label: 'Održavanje' },
  { value: 'owner_use', label: 'Korišćenje vlasnika' },
  { value: 'other', label: 'Drugo' },
];

export const BOARDS: Array<{ value: Board; label: string }> = [
  { value: 'RO', label: 'Samo smeštaj' },
  { value: 'BB', label: 'Noćenje s doručkom' },
  { value: 'HB', label: 'Polupansion' },
  { value: 'FB', label: 'Pun pansion' },
];

export function typeLabel(t: Pick<UnitType, 'code' | 'name'>): string {
  return `${t.code} – ${t.name.sr}`;
}

/** 1 osoba, 2–4 osobe, 5+ osoba (11–14 osoba). */
export function persons(n: number): string {
  const ten = n % 10;
  const hundred = n % 100;
  if (ten === 1 && hundred !== 11) return `${n} osoba`;
  if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return `${n} osobe`;
  return `${n} osoba`;
}
