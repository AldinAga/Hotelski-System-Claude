import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const B64URL = /^[A-Za-z0-9_-]*$/;

// AES-256-GCM under HOTEL_SECRET_KEY for secrets kept in the database (the
// installation's private seed). Stored as `v1.<iv>.<ciphertext>.<tag>`, each
// part base64url, with a random 12-byte IV per encryption. A database dump
// alone does not reveal the seed; the key lives only in the environment.
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new TypeError('SecretBox key must be 32 bytes');
    this.key = Buffer.from(key);
  }

  /**
   * HOTEL_SECRET_KEY: canonical base64url of exactly 32 bytes. Anything else
   * (unset, wrong length, not base64url) gives null: licensing then reports
   * itself unconfigured instead of the API failing to boot.
   */
  static fromEnv(value: string | undefined): SecretBox | null {
    if (!value || !B64URL.test(value)) return null;
    const key = Buffer.from(value, 'base64url');
    if (key.length !== 32 || key.toString('base64url') !== value) return null;
    return new SecretBox(key);
  }

  seal(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join('.');
  }

  /** Throws on an unknown format, a wrong key or any tampering (GCM tag mismatch). */
  open(sealed: string): string {
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION || !parts.slice(1).every((p) => B64URL.test(p))) {
      throw new Error('SecretBox: unknown sealed format');
    }
    const iv = Buffer.from(parts[1], 'base64url');
    const ct = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new Error('SecretBox: unknown sealed format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}
