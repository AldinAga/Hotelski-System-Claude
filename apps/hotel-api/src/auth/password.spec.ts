import { DomainError } from '../common/domain-error';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password';

describe('password', () => {
  it('stores scrypt$32768$8$1$salt$hash with a 16-byte salt and a 64-byte key', async () => {
    const stored = await hashPassword('ispravna-lozinka');
    const parts = stored.split('$');
    expect(parts.slice(0, 4)).toEqual(['scrypt', '32768', '8', '1']);
    expect(Buffer.from(parts[4], 'base64')).toHaveLength(16);
    expect(Buffer.from(parts[5], 'base64')).toHaveLength(64);
  });

  it('verifies the right password and refuses a wrong one', async () => {
    const stored = await hashPassword('ispravna-lozinka');
    expect(await verifyPassword('ispravna-lozinka', stored)).toBe(true);
    expect(await verifyPassword('pogresna-lozinka', stored)).toBe(false);
  });

  it('salts: the same password hashes differently twice', async () => {
    expect(await hashPassword('ispravna-lozinka')).not.toBe(await hashPassword('ispravna-lozinka'));
  });

  it('refuses fewer than 10 characters (422 password_too_short) and accepts exactly 10', async () => {
    const err = await hashPassword('123456789').catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: 'password_too_short', status: 422 });
    await expect(hashPassword('1234567890')).resolves.toMatch(/^scrypt\$/);
  });

  it('reads a malformed or tampered stored value as a wrong password', async () => {
    for (const bad of ['', 'plain', 'scrypt$1$8$1$AA==$AA==', 'scrypt$1048577$8$1$AA==$AA==', 'bcrypt$x$y$z$a$b']) {
      expect(await verifyPassword('ispravna-lozinka', bad)).toBe(false);
    }
  });

  it('the dummy hash is a valid hash nobody can match with a guess', async () => {
    expect(await verifyPassword('ispravna-lozinka', DUMMY_PASSWORD_HASH)).toBe(false);
    expect(DUMMY_PASSWORD_HASH.split('$')).toHaveLength(6);
  });
});
