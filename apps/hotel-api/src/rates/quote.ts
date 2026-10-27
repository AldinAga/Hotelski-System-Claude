import { add, fromMinor, multiply, zero, type Money } from '@platform/money';

/** One night of a stay as stored: `priceMinor` null means no price was entered. */
export interface QuoteNight {
  /** YYYY-MM-DD */
  day: string;
  priceMinor: number | null;
  closed: boolean;
}

export interface QuoteInput {
  nights: QuoteNight[];
  discount7Pct: number;
  discount30Pct: number;
  currency: 'RSD';
}

export type QuoteResult =
  | { ok: true; nights: Array<{ day: string; price: Money }>; total: Money }
  | { ok: false; reason: 'price_missing' | 'closed'; day: string };

export const LONG_STAY_NIGHTS = 7;
export const MONTH_STAY_NIGHTS = 30;

function assertPercent(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new TypeError(`quoteStay: ${name} must be an integer from 0 to 100 (got ${value})`);
  }
}

/**
 * Prices a stay from its nights (pure; the caller reads them from rate_day).
 *
 * The discount follows the number of nights: 30 or more use discount30Pct
 * (even when it is lower than discount7Pct), otherwise 7 or more use
 * discount7Pct. It is applied to each night separately and rounded to a whole
 * minor unit per night, and the total is the sum of the rounded nights, so the
 * bill lines add up to the total.
 *
 * The first night (in the order given) that cannot be sold ends the quote: a
 * closed night is `closed` even when it has a price, a night without a price
 * is `price_missing`. A price of 0 is a price: only null is missing.
 */
export function quoteStay(input: QuoteInput): QuoteResult {
  const { nights, discount7Pct, discount30Pct, currency } = input;
  if (nights.length === 0) throw new TypeError('quoteStay: a stay has at least one night');
  assertPercent(discount7Pct, 'discount7Pct');
  assertPercent(discount30Pct, 'discount30Pct');

  for (const n of nights) {
    if (n.closed) return { ok: false, reason: 'closed', day: n.day };
    if (n.priceMinor === null) return { ok: false, reason: 'price_missing', day: n.day };
    if (!Number.isSafeInteger(n.priceMinor) || n.priceMinor < 0) {
      throw new TypeError(`quoteStay: price of ${n.day} must be a non-negative integer (got ${n.priceMinor})`);
    }
  }

  const pct =
    nights.length >= MONTH_STAY_NIGHTS ? discount30Pct : nights.length >= LONG_STAY_NIGHTS ? discount7Pct : 0;
  const priced = nights.map((n) => ({
    day: n.day,
    price: multiply(fromMinor(n.priceMinor as number, currency), (100 - pct) / 100),
  }));
  const total = priced.reduce((sum, n) => add(sum, n.price), zero(currency));
  return { ok: true, nights: priced, total };
}
