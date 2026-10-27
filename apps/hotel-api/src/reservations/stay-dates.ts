/** The longest stay accepted, in nights. */
export const MAX_STAY_NIGHTS = 365;

export type StayDatesReason = 'departure_not_after_arrival' | 'too_long' | 'arrival_in_past' | 'bad_date';

export type StayDatesResult =
  | { ok: true; nights: number }
  | { ok: false; reason: StayDatesReason; field: 'arrival' | 'departure' };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Days since the epoch of a YYYY-MM-DD that exists, else null. */
function dayNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return ms / DAY_MS;
}

/**
 * The rules every new stay obeys, checked before anything is priced or
 * locked. Nights are [arrival, departure) in calendar days, so DST changes
 * do not count. `today` is the property's local date; a stay may start today.
 * The failure names the field to show the error on.
 */
export function validateStayDates(arrival: string, departure: string, today: string): StayDatesResult {
  const t = dayNumber(today);
  if (t === null) throw new TypeError(`validateStayDates: bad today ${String(today)}`);
  const a = dayNumber(arrival);
  if (a === null) return { ok: false, reason: 'bad_date', field: 'arrival' };
  const d = dayNumber(departure);
  if (d === null) return { ok: false, reason: 'bad_date', field: 'departure' };
  if (d <= a) return { ok: false, reason: 'departure_not_after_arrival', field: 'departure' };
  if (a < t) return { ok: false, reason: 'arrival_in_past', field: 'arrival' };
  const nights = d - a;
  if (nights > MAX_STAY_NIGHTS) return { ok: false, reason: 'too_long', field: 'departure' };
  return { ok: true, nights };
}
