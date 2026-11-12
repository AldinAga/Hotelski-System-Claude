// Serbian identifiers of the property's legal profile, as pure functions.
// PIB and JMBG carry a check digit; the matični broj is checked for its length
// only (its check digit algorithm is not confirmed on real numbers: open
// question 3, Ruling 5).

const DIGITS = (n: number) => new RegExp(`^\\d{${n}}$`);

/** PIB: nine digits, the last one is the ISO 7064 MOD 11,10 check digit of the first eight. */
export function isValidPib(v: string): boolean {
  if (!DIGITS(9).test(v)) return false;
  let p = 10;
  for (let i = 0; i < 8; i++) {
    let s = (Number(v[i]) + p) % 10;
    if (s === 0) s = 10;
    p = (2 * s) % 11;
  }
  return (11 - p) % 10 === Number(v[8]);
}

/** DDMMYYY of a JMBG as a real calendar day (YYY 000..799 are 2000..2799, 800..999 are 1800..1999). */
function isRealJmbgDate(v: string): boolean {
  const day = Number(v.slice(0, 2));
  const month = Number(v.slice(2, 4));
  const yyy = Number(v.slice(4, 7));
  const year = yyy < 800 ? 2000 + yyy : 1000 + yyy;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** The JMBG check digit of the first twelve digits. */
function jmbgCheckDigit(v: string): number {
  const d = (i: number) => Number(v[i]);
  const sum = 7 * (d(0) + d(6)) + 6 * (d(1) + d(7)) + 5 * (d(2) + d(8)) + 4 * (d(3) + d(9)) + 3 * (d(4) + d(10)) + 2 * (d(5) + d(11));
  const m = 11 - (sum % 11);
  return m > 9 ? 0 : m;
}

/** JMBG: thirteen digits, a real birth date in the first seven and the check digit last. */
export function isValidJmbg(v: string): boolean {
  if (!DIGITS(13).test(v)) return false;
  return isRealJmbgDate(v) && jmbgCheckDigit(v) === Number(v[12]);
}

/** Why a thirteen-digit JMBG is refused, for the message: 'date' or 'check_digit' (null: it is valid or not thirteen digits). */
export function jmbgFault(v: string): 'date' | 'check_digit' | null {
  if (!DIGITS(13).test(v)) return null;
  if (!isRealJmbgDate(v)) return 'date';
  return jmbgCheckDigit(v) === Number(v[12]) ? null : 'check_digit';
}

/** Matični broj: exactly eight digits. */
export function isValidMb(v: string): boolean {
  return DIGITS(8).test(v);
}

/** Bank account: bank code (3), number (1 to 13), check digits (2), with hyphens. */
export function isValidBankAccount(v: string): boolean {
  return /^\d{3}-\d{1,13}-\d{2}$/.test(v);
}

export const JMBG_MASK_CHAR = '•';

/** Nine bullets and the last four digits. */
export function maskJmbg(v: string): string {
  return JMBG_MASK_CHAR.repeat(9) + v.slice(-4);
}
