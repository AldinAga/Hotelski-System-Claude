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

export type CalendarBar =
  | { kind: 'stay'; stayId: string; arrival: string; departure: string }
  | { kind: 'block'; blockId: string; from: string; to: string; reason: BlockReason };

export interface CalendarView {
  days: string[];
  units: Array<{ id: string; name: string; unitTypeId: string | null; bars: CalendarBar[] }>;
}

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
