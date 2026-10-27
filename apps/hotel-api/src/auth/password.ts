import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../common/domain-error';

// Stored as scrypt$N$r$p$saltB64$hashB64 so the cost parameters travel with the
// hash and can be raised later without invalidating existing passwords.
const N = 2 ** 15;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

export const PASSWORD_MIN_LENGTH = 10;
// scrypt cost does not grow with length, but a megabyte password still costs
// memory to receive and normalise.
export const PASSWORD_MAX_LENGTH = 1024;

// scrypt needs about 128 * N * r bytes; Node's default limit (32 MiB) sits
// exactly at this cost, so give it explicit headroom.
const maxmemFor = (n: number, r: number): number => 128 * n * r * 2 + 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLen, { N: n, r, p, maxmem: maxmemFor(n, r) }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** 422 password_too_short / password_too_long; the only gate for new passwords. */
export function assertPasswordPolicy(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new DomainError(
      'password_too_short',
      `Lozinka mora imati najmanje ${PASSWORD_MIN_LENGTH} znakova.`,
      422,
      { min: PASSWORD_MIN_LENGTH },
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new DomainError('password_too_long', 'Lozinka je predugačka.', 422, { max: PASSWORD_MAX_LENGTH });
  }
}

/** Refuses a password outside the policy, so no caller can store a short one. */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P, KEY_BYTES);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

// Never throws on a malformed stored value: a corrupt row must read as "wrong
// password", not as a 500 that distinguishes it from a wrong guess.
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // Bound the parameters so a tampered row cannot make verification allocate gigabytes.
  if (
    ![n, r, p].every(Number.isInteger) ||
    n < 2 ||
    n > 2 ** 20 ||
    (n & (n - 1)) !== 0 ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16
  ) {
    return false;
  }
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await derive(password, salt, n, r, p, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// A fixed, valid hash of a random throwaway password nobody knows, verified
// when a login names an unknown email, so that path costs one scrypt run too
// and response time does not reveal which emails exist.
export const DUMMY_PASSWORD_HASH =
  'scrypt$32768$8$1$keXqVvdj+zwtm/yhBfPBCA==$R8A1H8FhA3GeoUo3yB7sRDGws/IVNaULSAaYwGjRvHx+1FBQk16PO4jSFZXtcaP+kkjCHd+PxkjdiDotICkNcQ==';
