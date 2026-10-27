import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// RFC 6238 TOTP, SHA-1, 6 digits, 30 s step: the profile every authenticator
// app supports by default.
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of text.replace(/=+$/, '').toUpperCase()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32 secret');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 160 bits, the size RFC 4226 recommends for an HMAC-SHA1 key; base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

// RFC 4226 dynamic truncation, reduced to DIGITS digits.
function codeForStep(key: Buffer, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code an authenticator shows at `now` (tests and enrolment checks). */
export function totpGenerate(secretBase32: string, now: Date): string {
  return codeForStep(base32Decode(secretBase32), totpStep(now));
}

/**
 * Checks `code` against the step of `now` and one step either side (clock
 * drift, typing time). Returns the step that matched, or null. A matching step
 * that is not newer than `lastStep` is refused, so a code (or an older one)
 * cannot be used twice; the caller stores the returned step as the new
 * lastStep, conditionally, so two concurrent uses cannot both win.
 * All three candidates are always compared so timing does not reveal which matched.
 */
export function totpVerify(secretBase32: string, code: string, now: Date, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  let key: Buffer;
  try {
    key = base32Decode(secretBase32);
  } catch {
    return null;
  }
  if (key.length === 0) return null;
  const current = totpStep(now);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (const delta of [-1, 0, 1]) {
    const step = current + delta;
    // Steps before the epoch do not exist; compute anyway (constant work) but never match.
    const match = timingSafeEqual(given, Buffer.from(codeForStep(key, Math.max(step, 0))));
    if (match && step >= 0 && (lastStep === null || step > lastStep)) matched = step;
  }
  return matched;
}

/** Enrolment URI for authenticator apps (QR code). */
export function totpUri(secretBase32: string, email: string): string {
  return `otpauth://totp/Hotel:${encodeURIComponent(email)}?secret=${secretBase32}&issuer=Hotel`;
}
