import { vatOf } from './documents.service';

// vatOf is vat = divide(multiply(sum, rate), 10000 + rate) per rate (preflight F32):
// an integer product divided once, rounded half-up by @platform/money (Math.round),
// and base = sum - vat.

describe('vatOf', () => {
  it('rounds an exact half up: 3 minor units at 20% hold 0.5, which is 1', () => {
    // 3 x 2000 = 6000; 6000 / 12000 = 0.5 exactly.
    expect(vatOf([{ amountMinor: 3, vatRateBp: 2000 }], true)).toEqual([{ rateBp: 2000, baseMinor: 2, vatMinor: 1 }]);
  });

  it('rounds once per rate, not per line', () => {
    // Two lines of 3 sum to 6; 6 x 2000 / 12000 = 1 exactly. Rounded per line it would be 1 + 1 = 2.
    expect(
      vatOf(
        [
          { amountMinor: 3, vatRateBp: 2000 },
          { amountMinor: 3, vatRateBp: 2000 },
        ],
        true,
      ),
    ).toEqual([{ rateBp: 2000, baseMinor: 5, vatMinor: 1 }]);
  });

  it('returns the rates in ascending order', () => {
    expect(
      vatOf(
        [
          { amountMinor: 120_000, vatRateBp: 2000 },
          { amountMinor: 1_000_000, vatRateBp: 1000 },
        ],
        true,
      )?.map((v) => v.rateBp),
    ).toEqual([1000, 2000]);
  });

  it('is null for a seller that is not a VAT payer, and when a line has no rate', () => {
    expect(vatOf([{ amountMinor: 100, vatRateBp: 2000 }], false)).toBeNull();
    expect(vatOf([{ amountMinor: 100, vatRateBp: 2000 }, { amountMinor: 100, vatRateBp: null }], true)).toBeNull();
  });
});
