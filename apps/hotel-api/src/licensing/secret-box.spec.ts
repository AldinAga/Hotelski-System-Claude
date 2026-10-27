import { randomBytes } from 'node:crypto';
import { SecretBox } from './secret-box';

describe('SecretBox', () => {
  const key = randomBytes(32);

  it('round-trips and stores v1.<iv>.<ciphertext>.<tag> with a 12-byte IV and 16-byte tag', () => {
    const box = new SecretBox(key);
    const sealed = box.seal('tajna');
    const [version, iv, ct, tag] = sealed.split('.');

    expect(version).toBe('v1');
    expect(Buffer.from(iv, 'base64url')).toHaveLength(12);
    expect(Buffer.from(ct, 'base64url')).toHaveLength(5);
    expect(Buffer.from(tag, 'base64url')).toHaveLength(16);
    expect(box.open(sealed)).toBe('tajna');
  });

  it('uses a fresh IV for every encryption', () => {
    const box = new SecretBox(key);
    const a = box.seal('isto');
    const b = box.seal('isto');

    expect(a.split('.')[1]).not.toBe(b.split('.')[1]);
    expect(a).not.toBe(b);
  });

  it('refuses a tampered ciphertext, a wrong key and an unknown format', () => {
    const box = new SecretBox(key);
    const [v, iv, ct, tag] = box.seal('tajna').split('.');
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] ^= 1;

    expect(() => box.open([v, iv, flipped.toString('base64url'), tag].join('.'))).toThrow();
    expect(() => new SecretBox(randomBytes(32)).open([v, iv, ct, tag].join('.'))).toThrow();
    expect(() => box.open(['v2', iv, ct, tag].join('.'))).toThrow(/format/);
    expect(() => box.open('v1.abc')).toThrow(/format/);
  });

  it('fromEnv: a canonical base64url 32-byte key, otherwise null', () => {
    expect(SecretBox.fromEnv(key.toString('base64url'))).toBeInstanceOf(SecretBox);
    expect(SecretBox.fromEnv(undefined)).toBeNull();
    expect(SecretBox.fromEnv('')).toBeNull();
    expect(SecretBox.fromEnv(randomBytes(16).toString('base64url'))).toBeNull();
    expect(SecretBox.fromEnv(randomBytes(33).toString('base64url'))).toBeNull();
    expect(SecretBox.fromEnv('not base64url!!')).toBeNull();
  });

  it('the constructor refuses a key that is not 32 bytes', () => {
    expect(() => new SecretBox(randomBytes(31))).toThrow(/32/);
  });
});
