// Dates, days and money as the front desk reads them. Days are YYYY-MM-DD
// calendar dates of the property (Europe/Belgrade); arithmetic on them runs
// in UTC so daylight saving never shifts a day.

export const PROPERTY_TIME_ZONE = 'Europe/Belgrade';
const DAY_MS = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-12-24" → "24.12.2026"; anything else is returned unchanged. */
export function formatDay(day: string): string {
  const m = ISO_DAY.exec(day);
  return m ? `${Number(m[3])}.${Number(m[2])}.${m[1]}` : day;
}

/** A timestamp (or a plain day) as the property's calendar date, e.g. "3.11.2026". */
export function formatDate(value: string): string {
  if (ISO_DAY.test(value)) return formatDay(value);
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : formatDay(dayInZone(new Date(t)));
}

/** The calendar day of `at` in the property's zone, YYYY-MM-DD. */
export function dayInZone(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: PROPERTY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function today(): string {
  return dayInZone(new Date());
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Nights in [from, to). */
export function nightsBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function isDay(value: string): boolean {
  const m = ISO_DAY.exec(value);
  if (!m) return false;
  return new Date(Date.parse(`${value}T00:00:00Z`)).toISOString().slice(0, 10) === value;
}

/** Minor units (para) → "10.000,00 RSD". */
export function formatRsd(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const para = (abs % 100).toString().padStart(2, '0');
  return `${sign}${whole},${para} RSD`;
}

/**
 * Dinars typed by a person → minor units, or null when it is not an amount.
 * Accepts "5500", "5.500", "5500,50" and "5.500,50"; never goes through a
 * float, so 0.1 + 0.2 cannot creep in.
 */
export function parseRsd(text: string): number | null {
  const t = text.trim().replace(/\s/g, '');
  const m = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const whole = Number(m[1].replace(/\./g, ''));
  const para = m[2] === undefined ? 0 : Number(m[2].padEnd(2, '0'));
  const minor = whole * 100 + para;
  return Number.isSafeInteger(minor) ? minor : null;
}
