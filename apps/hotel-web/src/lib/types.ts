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

/** GET /stays/:id/folio and the lines and payments in it (folio.service.ts). Totals come from the server. */
export type FolioStatus = 'none' | 'open' | 'closed';

export interface FolioLine {
  id: string;
  kind: 'accommodation' | 'service' | 'fee' | 'correction' | string;
  description: string;
  amountMinor: number;
  vatRateBp: number | null;
  businessDate: string;
  night: string | null;
  sourceType: string;
  reversesLineId: string | null;
  /** The correction that reverses this line. */
  reversedBy: string | null;
  reason: string | null;
  createdAt: string;
}

export interface FolioPayment {
  id: string;
  method: PaymentMethod | string;
  amountMinor: number;
  businessDate: string;
  reference: string | null;
  reversesPaymentId: string | null;
  /** The payment that voids this one. */
  voidedBy: string | null;
  reason: string | null;
  createdAt: string;
}

export interface Folio {
  /** null while the stay has no folio (nothing was charged or paid yet). */
  id: string | null;
  stayId: string;
  reservationId: string;
  status: FolioStatus;
  lines: FolioLine[];
  payments: FolioPayment[];
  chargesMinor: number;
  paymentsMinor: number;
  /** Charges minus payments; negative is a credit the guest has. */
  balanceMinor: number;
  /** Agreed nights not yet posted, for the pro forma and the check-out preview. */
  unpostedNights: Array<{ night: string; priceMinor: number }>;
  /** The VAT rates (basis points) a manual charge may carry. */
  vatRatesBp: number[];
  /** Set while fiscalisation is required but not switched on. */
  fiscalNotice: 'not_available_yet' | null;
}

export type PaymentMethod = 'cash' | 'card' | 'transfer';

export const PAYMENT_METHODS: Array<{ value: PaymentMethod; label: string }> = [
  { value: 'cash', label: 'Gotovina' },
  { value: 'card', label: 'Kartica' },
  { value: 'transfer', label: 'Prenos' },
];

export function paymentMethodLabel(method: string): string {
  return PAYMENT_METHODS.find((m) => m.value === method)?.label ?? method;
}

export type DocumentKind = 'receipt' | 'proforma';

/** The snapshot a document was issued with (documents.service.ts). Seller fields can be null. */
export interface FolioDocumentContent {
  kind: DocumentKind;
  number: string;
  issuedAt: string;
  businessDate: string;
  notice: string;
  seller: {
    legalName: string | null;
    taxId: string | null;
    /** A natural person's JMBG arrives masked. */
    registryId: string | null;
    address: string | null;
    postalCode: string | null;
    city: string | null;
    bankAccount: string | null;
    vatPayer: boolean;
  };
  guest: { name: string; email: string | null };
  reservation: { number: string; arrival: string; departure: string; unit: string | null };
  lines: Array<{
    description: string;
    night: string | null;
    amountMinor: number;
    vatRateBp: number | null;
    /** A night the pro forma expects but that is not posted yet. */
    expected: boolean;
  }>;
  payments: Array<{ method: string; amountMinor: number; businessDate: string }>;
  totalMinor: number;
  paidMinor: number;
  dueMinor: number;
  /** VAT contained in the prices, per rate; null when the seller is not a VAT payer or a line has no rate. */
  vat: Array<{ rateBp: number; baseMinor: number; vatMinor: number }> | null;
}

export interface FolioDocument {
  id: string;
  kind: DocumentKind;
  number: string;
  issuedAt: string;
  content: FolioDocumentContent;
}

export interface FolioDocumentItem {
  id: string;
  kind: DocumentKind;
  number: string;
  issuedAt: string;
}

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  receipt: 'Nefiskalni račun',
  proforma: 'Predračun',
};

export type OutboxStatus ='pending' | 'sending' | 'sent' | 'failed' | 'skipped';

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
