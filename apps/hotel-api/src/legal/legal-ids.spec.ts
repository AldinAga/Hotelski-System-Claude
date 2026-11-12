import { isValidBankAccount, isValidJmbg, isValidMb, isValidPib, jmbgFault, maskJmbg } from './legal-ids';

// Vectors are real public PIBs and hand-computed JMBGs, independent of the code.
describe('legal ids', () => {
  it.each(['100002887', '104052135', '100001378', '101670560'])('PIB %s of a real company is valid', (pib) => {
    expect(isValidPib(pib)).toBe(true);
  });

  it.each(['100002888', '10000288', '1000028870', '10000288a'])('PIB %s is refused', (pib) => {
    expect(isValidPib(pib)).toBe(false);
  });

  it('JMBG: check digit and date', () => {
    expect(isValidJmbg('0101990710008')).toBe(true);
    expect(isValidJmbg('0101990710007')).toBe(false); // wrong check digit
    // 31 Feb 1990. Hand-computed check digit of 310299071000 is 5 (7*3 + 6*8 + 5*1 + 4*2 + 3*9 + 2*9 = 127,
    // 127 mod 11 = 6, 11 - 6 = 5), so this fails because of the date and not because of the digit.
    expect(isValidJmbg('3102990710005')).toBe(false);
    expect(isValidJmbg('010199071000')).toBe(false);
  });

  it('JMBG: names why it is refused', () => {
    expect(jmbgFault('3102990710005')).toBe('date');
    expect(jmbgFault('0101990710007')).toBe('check_digit');
    expect(jmbgFault('0101990710008')).toBeNull();
  });

  it('JMBG: a leap day exists only in a leap year', () => {
    // 29 Feb 1992 is real; 29 Feb 1990 is not. Both get a correct check digit, so only the date decides.
    expect(isValidJmbg(withCheckDigit('290299250000'))).toBe(true); // 29 Feb 1992
    expect(isValidJmbg(withCheckDigit('290299050000'))).toBe(false); // 29 Feb 1990
  });

  it('MB is exactly eight digits', () => {
    expect(isValidMb('07036540')).toBe(true);
    expect(isValidMb('7036540')).toBe(false);
    expect(isValidMb('070365401')).toBe(false);
    expect(isValidMb('0703654a')).toBe(false);
  });

  it('bank account: three, up to thirteen and two digits with hyphens', () => {
    expect(isValidBankAccount('160-0000000123456-78')).toBe(true);
    expect(isValidBankAccount('160-1-78')).toBe(true);
    expect(isValidBankAccount('160-00000001234567-78')).toBe(false);
    expect(isValidBankAccount('16-123-78')).toBe(false);
    expect(isValidBankAccount('160123456778')).toBe(false);
  });

  it('mask keeps only the last four digits', () => {
    expect(maskJmbg('0101990710008')).toBe('•••••••••0008');
  });
});

/** Appends the JMBG check digit, computed here by the published formula (weights 7..2 over pairs). */
function withCheckDigit(first12: string): string {
  const d = [...first12].map(Number);
  const sum = [0, 1, 2, 3, 4, 5].reduce((acc, i) => acc + (7 - i) * (d[i] + d[i + 6]), 0);
  const m = 11 - (sum % 11);
  return first12 + String(m > 9 ? 0 : m);
}
