import { describe, expect, it } from 'vitest';
import { formatAmountInput, formatDateTime, formatRsd, formatVatRate, nightsLabel, parseRsd } from './format';

describe('nightsLabel', () => {
  it('uses "noć" for 1, 21, 101 and "noći" for the rest, 11 included', () => {
    expect([1, 2, 5, 11, 12, 21, 22, 101, 111].map(nightsLabel)).toEqual([
      '1 noć',
      '2 noći',
      '5 noći',
      '11 noći',
      '12 noći',
      '21 noć',
      '22 noći',
      '101 noć',
      '111 noći',
    ]);
  });
});

// parseRsd existed before Task 11 (preflight F15): these vectors are
// characterisation tests of the amount field and were green when added.
describe('parseRsd', () => {
  it.each([
    ['1.234,56', 123456],
    ['1234,56', 123456],
    ['1234', 123400],
    ['12,3', 1230],
    ['0,50', 50],
    ['  5.500  ', 550000],
  ])('reads %s as %i minor units', (text, minor) => {
    expect(parseRsd(text)).toBe(minor);
  });

  it.each([['0,005'], ['-5'], ['1,234'], ['abc'], [''], ['1.23'], ['12,'], ['5 RSD']])('refuses %j', (text) => {
    expect(parseRsd(text)).toBeNull();
  });

  it('reads zero as zero, so a caller that needs more than zero has to check', () => {
    expect(parseRsd('0')).toBe(0);
  });

  it('does not lose para on a large amount (no float)', () => {
    expect(parseRsd('90.071.992.547.410,00')).toBeNull();
    expect(parseRsd('1.000.000,07')).toBe(100000007);
  });
});

describe('formatAmountInput', () => {
  it('shows an amount without the currency, and parseRsd reads it back', () => {
    expect(formatAmountInput(2_000_000)).toBe('20.000,00');
    expect(formatAmountInput(5)).toBe('0,05');
    for (const minor of [1, 99, 100, 123456, 2_000_000, 10_000_000_000]) {
      expect(parseRsd(formatAmountInput(minor))).toBe(minor);
    }
  });

  it('is formatRsd without the currency', () => {
    expect(formatRsd(2_000_000)).toBe('20.000,00 RSD');
  });
});

describe('formatVatRate', () => {
  it('shows basis points as a percentage with a decimal comma', () => {
    expect(formatVatRate(2000)).toBe('20 %');
    expect(formatVatRate(1000)).toBe('10 %');
    expect(formatVatRate(650)).toBe('6,5 %');
    expect(formatVatRate(0)).toBe('0 %');
  });
});

describe('formatDateTime', () => {
  it('shows the property day and clock time, not UTC', () => {
    // 13:05 UTC is 14:05 in Belgrade in November.
    expect(formatDateTime('2026-11-13T13:05:00.000Z')).toBe('13.11.2026 14:05');
    // 23:30 UTC on the 12th is already the 13th at the property.
    expect(formatDateTime('2026-11-12T23:30:00.000Z')).toBe('13.11.2026 00:30');
  });

  it('returns what it cannot read', () => {
    expect(formatDateTime('nije datum')).toBe('nije datum');
  });
});
