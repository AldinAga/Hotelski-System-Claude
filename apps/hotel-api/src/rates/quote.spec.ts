import { quoteStay, type QuoteNight } from './quote';

// Amounts are minor units: 10.000,00 RSD is 1_000_000.
const TEN_THOUSAND = 1_000_000;

function nights(count: number, priceMinor: number | null = TEN_THOUSAND, from = '2026-12-01'): QuoteNight[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => ({
    day: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    priceMinor,
    closed: false,
  }));
}

const amounts = (r: ReturnType<typeof quoteStay>) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason} on ${r.day}`);
  return r.nights.map((n) => n.price.amount_minor);
};

describe('quoteStay', () => {
  it('6 nights get no discount even when both discounts are set', () => {
    const r = quoteStay({ nights: nights(6), discount7Pct: 10, discount30Pct: 20, currency: 'RSD' });
    expect(amounts(r)).toEqual(Array(6).fill(TEN_THOUSAND));
    expect(r.ok && r.total).toEqual({ amount_minor: 6 * TEN_THOUSAND, currency_code: 'RSD' });
  });

  it('7 nights x 10.000,00 RSD with 10%: each night 9.000,00, total 63.000,00', () => {
    const r = quoteStay({ nights: nights(7), discount7Pct: 10, discount30Pct: 0, currency: 'RSD' });
    expect(amounts(r)).toEqual(Array(7).fill(900_000));
    expect(r.ok && r.total.amount_minor).toBe(6_300_000);
    expect(r.ok && r.nights[0]).toEqual({ day: '2026-12-01', price: { amount_minor: 900_000, currency_code: 'RSD' } });
  });

  it('29 nights still use the 7-night discount, 30 nights use the 30-night one', () => {
    const at29 = quoteStay({ nights: nights(29), discount7Pct: 10, discount30Pct: 20, currency: 'RSD' });
    expect(amounts(at29)[0]).toBe(900_000);
    const at30 = quoteStay({ nights: nights(30), discount7Pct: 10, discount30Pct: 20, currency: 'RSD' });
    expect(amounts(at30)).toEqual(Array(30).fill(800_000));
    expect(at30.ok && at30.total.amount_minor).toBe(30 * 800_000);
  });

  it('30 nights with a 30-night discount of 0 get no discount, not the 7-night one', () => {
    const r = quoteStay({ nights: nights(30), discount7Pct: 10, discount30Pct: 0, currency: 'RSD' });
    expect(amounts(r)[0]).toBe(TEN_THOUSAND);
  });

  it('discounts each night separately, rounding to a whole minor unit', () => {
    const r = quoteStay({
      nights: [...nights(6, 1_000_005), { day: '2026-12-07', priceMinor: 333, closed: false }],
      discount7Pct: 15,
      discount30Pct: 0,
      currency: 'RSD',
    });
    // 1_000_005 * 0.85 = 850_004.25 -> 850_004; 333 * 0.85 = 283.05 -> 283.
    expect(amounts(r)).toEqual([...Array(6).fill(850_004), 283]);
    expect(r.ok && r.total.amount_minor).toBe(6 * 850_004 + 283);
  });

  it('a night without a price: price_missing with that day', () => {
    const list = nights(3);
    list[1] = { day: list[1].day, priceMinor: null, closed: false };
    expect(quoteStay({ nights: list, discount7Pct: 0, discount30Pct: 0, currency: 'RSD' })).toEqual({
      ok: false,
      reason: 'price_missing',
      day: '2026-12-02',
    });
  });

  it('a closed night: closed with that day, even when it has a price', () => {
    const list = nights(3);
    list[2] = { day: list[2].day, priceMinor: TEN_THOUSAND, closed: true };
    expect(quoteStay({ nights: list, discount7Pct: 0, discount30Pct: 0, currency: 'RSD' })).toEqual({
      ok: false,
      reason: 'closed',
      day: '2026-12-03',
    });
  });

  it('reports the first problem night; a closed night with no price is closed, not price_missing', () => {
    const list = nights(3);
    list[0] = { day: list[0].day, priceMinor: null, closed: true };
    list[1] = { day: list[1].day, priceMinor: null, closed: false };
    expect(quoteStay({ nights: list, discount7Pct: 0, discount30Pct: 0, currency: 'RSD' })).toMatchObject({
      reason: 'closed',
      day: '2026-12-01',
    });
    list[0] = { day: list[0].day, priceMinor: 5, closed: false };
    expect(quoteStay({ nights: list, discount7Pct: 0, discount30Pct: 0, currency: 'RSD' })).toMatchObject({
      reason: 'price_missing',
      day: '2026-12-02',
    });
  });

  it('a price of 0 is allowed only when explicitly entered (null is still missing)', () => {
    const free = quoteStay({ nights: nights(2, 0), discount7Pct: 0, discount30Pct: 0, currency: 'RSD' });
    expect(free.ok && free.total.amount_minor).toBe(0);
    expect(amounts(free)).toEqual([0, 0]);
    const unset = quoteStay({ nights: nights(2, null), discount7Pct: 0, discount30Pct: 0, currency: 'RSD' });
    expect(unset).toMatchObject({ ok: false, reason: 'price_missing', day: '2026-12-01' });
  });

  it('refuses inputs that are caller bugs', () => {
    const base = { discount7Pct: 0, discount30Pct: 0, currency: 'RSD' as const };
    expect(() => quoteStay({ ...base, nights: [] })).toThrow(TypeError);
    expect(() => quoteStay({ ...base, nights: nights(1), discount7Pct: 101 })).toThrow(TypeError);
    expect(() => quoteStay({ ...base, nights: nights(1), discount30Pct: -1 })).toThrow(TypeError);
    expect(() => quoteStay({ ...base, nights: nights(1, 1.5) })).toThrow(TypeError);
    expect(() => quoteStay({ ...base, nights: nights(1, -1) })).toThrow(TypeError);
  });
});
