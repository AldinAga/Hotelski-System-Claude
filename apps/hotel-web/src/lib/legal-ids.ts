// A copy of apps/hotel-api/src/legal/legal-ids.ts (PIB, JMBG and MB checks), kept
// in step by hand: there is no shared package in the workspace, and a new
// Platform Kit package needs the owner's approval (preflight F18). It lets the
// legal profile form refuse a bad number before it is sent. The API stays the
// only check that decides: it runs the same algorithms on every PUT.
// legal-ids.test.ts uses the vectors of the API's legal-ids.spec.ts.

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

/** The character a masked JMBG starts with (the API shows nine of them and the last four digits). */
export const JMBG_MASK_CHAR = '•';
