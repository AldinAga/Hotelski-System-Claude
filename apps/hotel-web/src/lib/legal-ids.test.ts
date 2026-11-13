import { describe, expect, it } from 'vitest';
import { isValidJmbg, isValidMb, isValidPib, jmbgFault } from './legal-ids';

// The vectors of apps/hotel-api/src/legal/legal-ids.spec.ts: real public PIBs and
// hand-computed JMBGs, independent of the code.
describe('legal ids (copy of the API checks)', () => {
  it.each(['100002887', '104052135', '100001378', '101670560'])('PIB %s of a real company is valid', (pib) => {
    expect(isValidPib(pib)).toBe(true);
  });

  it.each(['100002888', '10000288', '1000028870', '10000288a'])('PIB %s is refused', (pib) => {
    expect(isValidPib(pib)).toBe(false);
  });

  it('JMBG: check digit and date', () => {
    expect(isValidJmbg('0101990710008')).toBe(true);
    expect(isValidJmbg('0101990710007')).toBe(false); // wrong check digit
    // 31 Feb 1990: the check digit of 310299071000 is 5, so this fails because of the date alone.
    expect(isValidJmbg('3102990710005')).toBe(false);
    expect(isValidJmbg('010199071000')).toBe(false);
  });

  it('JMBG: names why it is refused', () => {
    expect(jmbgFault('3102990710005')).toBe('date');
    expect(jmbgFault('0101990710007')).toBe('check_digit');
    expect(jmbgFault('0101990710008')).toBeNull();
  });

  it('JMBG: a leap day exists only in a leap year', () => {
    expect(isValidJmbg(withCheckDigit('290299250000'))).toBe(true); // 29 Feb 1992
    expect(isValidJmbg(withCheckDigit('290299050000'))).toBe(false); // 29 Feb 1990
  });

  it('PIB: a step that comes out as 0 counts as 10 (ISO 7064 MOD 11,10)', () => {
    // For 10000000 the rule gives check digit 8; reading a 0 step as 0 would give 1.
    expect(isValidPib('100000008')).toBe(true);
    expect(isValidPib('100000001')).toBe(false);
  });

  it('JMBG: 800 in the year part is 1800, which had no 29 February (2800 would have)', () => {
    expect(isValidJmbg(withCheckDigit('290280071000'))).toBe(false);
    expect(isValidJmbg(withCheckDigit('280280071000'))).toBe(true);
  });

  it('MB is exactly eight digits', () => {
    expect(isValidMb('07036540')).toBe(true);
    expect(isValidMb('7036540')).toBe(false);
    expect(isValidMb('070365401')).toBe(false);
    expect(isValidMb('0703654a')).toBe(false);
  });
});

/** Appends the JMBG check digit, computed here by the published formula (weights 7..2 over pairs). */
function withCheckDigit(first12: string): string {
  const d = [...first12].map(Number);
  const sum = [0, 1, 2, 3, 4, 5].reduce((acc, i) => acc + (7 - i) * (d[i] + d[i + 6]), 0);
  const m = 11 - (sum % 11);
  return first12 + String(m > 9 ? 0 : m);
}
