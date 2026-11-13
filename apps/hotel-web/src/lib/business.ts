// Shapes and wording of the business day, the business settings and the legal
// profile (hotel-api business-day/*, legal/*), and the small helpers their
// screens share. Amounts and days come from the server; nothing here
// calculates money or a business date.

import { formatDay } from './format';

export type CloseMode = 'manual' | 'auto';

/** One guest who blocks the close (also the details of 409 close_blocked). */
export interface CloseBlocker {
  stayId: string;
  reservationId: string;
  number: string;
  unitName: string | null;
  departure: string;
}

export interface BusinessDayPending {
  /** Stays checked in on the open day. */
  arrivals: number;
  /** Stays checked out on the open day. */
  departures: number;
  /** All guests in the house now. Not the report's inHouse, which counts the nights the close posted. */
  inHouse: number;
  /** Nights the close would post. */
  nightsToPost: number;
  /** Stays the close would mark as no-show. */
  noShows: number;
}

/** GET /business-day */
export interface BusinessDayView {
  day: string;
  today: string;
  started: boolean;
  /** today minus day: positive when the business day lags behind the calendar, negative after an evening close. */
  lagDays: number;
  lastClosed: { day: string; closedAt: string; mode: CloseMode } | null;
  lastAutoError: { at: string; code: string; details: unknown } | null;
  blockers: CloseBlocker[];
  pending: BusinessDayPending;
}

export interface NoShowEntry {
  stayId: string;
  number: string;
  guest: string;
  arrival: string;
  chargedMinor: number;
}

export interface AuditReport {
  day: string;
  mode: CloseMode;
  closedAt: string;
  closedBy: string | null;
  arrivals: number;
  departures: number;
  /** Guests in the house whose night the close posted. */
  inHouse: number;
  noShows: NoShowEntry[];
  roomRevenueMinor: number;
  chargesByKindMinor: Record<string, number>;
  paymentsByMethodMinor: Record<string, number>;
  postedNights: number;
}

/** POST /business-day/close */
export interface CloseResult {
  alreadyClosed: boolean;
  report: AuditReport;
}

/** GET /business-days/:day */
export interface ClosedDay {
  day: string;
  closedAt: string;
  closedBy: string | null;
  mode: CloseMode;
  report: AuditReport;
}

/** GET /business-days */
export interface ClosedDaySummary {
  day: string;
  closedAt: string;
  mode: CloseMode;
  roomRevenueMinor: number;
  noShows: number;
}

/** The closed days the screen lists, counted back from the open day. */
export const CLOSED_DAYS_SHOWN = 30;

/** GET and PUT /settings/business */
export interface BusinessSettings {
  autoCloseTime: string | null;
  noShowCharge: 'none' | 'first_night';
  accommodationVatBp: number | null;
  vatRatesBp: number[];
}

export const MAX_VAT_RATES = 5;

export const NO_SHOW_CHARGES: Array<{ value: BusinessSettings['noShowCharge']; label: string }> = [
  { value: 'none', label: 'Bez naplate' },
  { value: 'first_night', label: 'Prva noć' },
];

export type LegalKind = 'legal_entity' | 'entrepreneur' | 'natural_person';
export type FiscalComplianceMode = 'required' | 'invoice_only' | 'disabled';
export type AccommodationCategory =
  | 'hotel'
  | 'motel'
  | 'hostel'
  | 'guest_house'
  | 'apartment'
  | 'room'
  | 'house'
  | 'rural_household'
  | 'other';

/** GET and PUT /legal-profile. kind is null until the profile was saved once. */
export interface LegalProfile {
  kind: LegalKind | null;
  legalName: string | null;
  taxId: string | null;
  /** MB; for a natural person the JMBG, masked. */
  registryId: string | null;
  vatPayer: boolean;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  activityCode: string | null;
  bankAccount: string | null;
  email: string | null;
  phone: string | null;
  accommodationCategory: AccommodationCategory | null;
  categorizationNumber: string | null;
  fiscalComplianceMode: FiscalComplianceMode | null;
  fiscalNotice: 'not_available_yet' | null;
  complete: boolean;
  missing: string[];
}

export const LEGAL_KINDS: Array<{ value: LegalKind; label: string }> = [
  { value: 'legal_entity', label: 'Pravno lice' },
  { value: 'entrepreneur', label: 'Preduzetnik' },
  { value: 'natural_person', label: 'Fizičko lice' },
];

export const ACCOMMODATION_CATEGORIES: Array<{ value: AccommodationCategory; label: string }> = [
  { value: 'hotel', label: 'Hotel' },
  { value: 'motel', label: 'Motel' },
  { value: 'hostel', label: 'Hostel' },
  { value: 'guest_house', label: 'Gostinska kuća' },
  { value: 'apartment', label: 'Apartman' },
  { value: 'room', label: 'Soba' },
  { value: 'house', label: 'Kuća za odmor' },
  { value: 'rural_household', label: 'Seosko domaćinstvo' },
  { value: 'other', label: 'Drugo' },
];

export const FISCAL_COMPLIANCE_MODES: Array<{ value: FiscalComplianceMode; label: string }> = [
  { value: 'required', label: 'Fiskalni račun za svako plaćanje' },
  { value: 'invoice_only', label: 'Samo fakture, bez fiskalnog računa' },
  { value: 'disabled', label: 'Nisam obveznik fiskalizacije' },
];

/** What the API's fiscalNotice means (hotel-api legal-profile.service.ts, Ruling 4). */
export const FISCAL_NOTICE = 'Fiskalizacija još nije uključena; plaćanja se beleže bez fiskalnog računa.';

/** The profile fields an invoice needs (the API's `missing`), as the form names them. */
export function missingLabel(field: string, kind: LegalKind | null): string {
  switch (field) {
    case 'legalName':
      return 'pun naziv';
    case 'address':
      return 'adresa';
    case 'city':
      return 'mesto';
    case 'taxId':
      return 'PIB';
    case 'registryId':
      return kind === 'natural_person' ? 'JMBG' : 'matični broj';
    default:
      return field;
  }
}

/** Basis points typed as a percentage, e.g. "10", "10,5", "20.25"; null when it is not one or is over 100 %. Whole numbers only, no floats. */
export function parsePercent(text: string): number | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const bp = Number(m[1]) * 100 + (m[2] === undefined ? 0 : Number(m[2].padEnd(2, '0')));
  return bp <= 10_000 ? bp : null;
}

/** 1000 → "10", 1050 → "10,5", 1025 → "10,25". */
export function formatPercent(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = String(bp % 100).padStart(2, '0').replace(/0$/, '');
  return frac === '0' ? String(whole) : `${whole},${frac}`;
}

/** "2026-11-03" → "3.11." */
export function dayMonth(day: string): string {
  const full = formatDay(day);
  return full.slice(0, full.lastIndexOf('.') + 1);
}

/** 1 dan, 2 dana, 11 dana, 21 dan. */
export function daysLabel(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? `${n} dan` : `${n} dana`;
}

/** 1 gost, 2 gosta, 5 gostiju, 11 gostiju, 22 gosta. */
export function guestsLabel(n: number): string {
  const ten = n % 10;
  const hundred = n % 100;
  if (ten === 1 && hundred !== 11) return `${n} gost`;
  if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return `${n} gosta`;
  return `${n} gostiju`;
}

/** The hour and minute of a timestamp in the property's zone, e.g. "02:00". */
export function formatTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Belgrade',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(t));
}

/** Folio line kinds (hotel-api 0010 CHECK), as the report names them; an unknown key is shown as it is. */
export const LINE_KIND_LABELS: Record<string, string> = {
  accommodation: 'Smeštaj',
  tourist_tax: 'Boravišna taksa',
  fee: 'Naknada',
  pos: 'Ugostiteljski POS',
  service: 'Usluga',
  deposit: 'Depozit',
  correction: 'Ispravka',
};

/** Payment methods (hotel-api 0010 CHECK). */
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'Gotovina',
  card: 'Kartica',
  card_link: 'Link za plaćanje',
  ips_qr: 'IPS QR',
  transfer: 'Virman',
  advance: 'Avans',
};

/**
 * The close of a day changes what the menu badge shows. The screen that closed
 * it tells the badge through this event instead of leaving it on the old day.
 */
export const BUSINESS_DAY_CHANGED = 'hotel:business-day-changed';

export function announceBusinessDayChange(): void {
  window.dispatchEvent(new Event(BUSINESS_DAY_CHANGED));
}
