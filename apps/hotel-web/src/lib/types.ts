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
      /** reservationId, number and guest are null for housekeeping (no guest data). */
      reservationId: string | null;
      number: string | null;
      guest: string | null;
      arrival: string;
      departure: string;
      status: string;
    }
  | { kind: 'block'; blockId: string; from: string; to: string; reason: BlockReason };

export interface UnassignedStay {
  stayId: string;
  /** reservationId, number, guest and version are null for housekeeping (no guest data). */
  reservationId: string | null;
  number: string | null;
  guest: string | null;
  unitTypeId: string;
  arrival: string;
  departure: string;
  /** The reservation's version when the calendar was read: sent with assign-unit. */
  version: number | null;
}

export interface CalendarView {
  days: string[];
  availability: Array<{ scope: Scope; label: string; free: number[] }>;
  units: Array<{ id: string; name: string; unitTypeId: string | null; cleanliness: string; bars: CalendarBar[] }>;
  unassigned: UnassignedStay[];
}

export type ReservationStatus = 'requested' | 'confirmed' | 'cancelled' | 'no_show';
export type StayStatus = 'expected' | 'in_house' | 'checked_out' | 'cancelled' | 'no_show';

export interface PricedNight {
  day: string;
  priceMinor: number;
}

/** GET /guests and the guests of a stay (guests.service.ts). */
export interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  language: string;
  note: string | null;
}

export type StayGuest = Guest & { isPrimary: boolean };

/** GET /stays/:id/check-out-preview: what check-out would do now (stay-lifecycle.service.ts). */
export interface CheckOutPreview {
  businessDate: string;
  keptUntil: string;
  earlyDeparture: boolean;
  nightsToPost: Array<{ night: string; priceMinor: number }>;
  nightsToRelease: string[];
  balanceMinor: number;
}

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

/** GET /reservations/:id/messages (mail module). */
export interface ReservationMessage {
  id: string;
  template: 'reservation_confirmed' | 'reservation_cancelled';
  recipient: string | null;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
  history: Array<{ at: string; ok: boolean; error: string | null }>;
}

export type ReservationStay = Reservation['stays'][number];

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
    /** Primary guest first, then in the order they were added. */
    guests: StayGuest[];
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
  no_show: 'Nije došao',
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
