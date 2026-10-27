import { randomBytes } from 'node:crypto';
import { startFakeCentralAdmin, type FakeCentralAdmin } from '../../test/fake-central-admin';
import { loadLicensingConfig, parseRootKeySet } from './licensing.config';

describe('licensing configuration', () => {
  let fake: FakeCentralAdmin;

  beforeAll(async () => {
    fake = await startFakeCentralAdmin();
  });
  afterAll(async () => {
    await fake.close();
  });

  describe('parseRootKeySet', () => {
    it('accepts the signed output of GET /v1/keys, as JSON or base64 of it', () => {
      const json = JSON.stringify(fake.rootKeySet);
      const expected = { issued_at: fake.rootKeySet.payload.issued_at, keys: fake.rootKeySet.payload.keys };

      expect(parseRootKeySet(json)).toEqual(expected);
      expect(parseRootKeySet(Buffer.from(json).toString('base64'))).toEqual(expected);
    });

    it('accepts a bare {issued_at, keys}', () => {
      const bare = { issued_at: fake.rootKeySet.payload.issued_at, keys: fake.rootKeySet.payload.keys };
      expect(parseRootKeySet(JSON.stringify(bare))).toEqual(bare);
    });

    it('returns null when unset', () => {
      expect(parseRootKeySet(undefined)).toBeNull();
      expect(parseRootKeySet('  ')).toBeNull();
    });

    it('refuses a signed set that does not verify against its own keys (truncated or edited paste)', () => {
      const edited = JSON.parse(JSON.stringify(fake.rootKeySet));
      edited.payload.issued_at = '2021-01-01T00:00:00.000Z';

      expect(() => parseRootKeySet(JSON.stringify(edited))).toThrow(/HOTEL_ROOT_KEYSET.*bad_signature/);
      expect(() => parseRootKeySet('{"issued_at":')).toThrow(/HOTEL_ROOT_KEYSET/);
      expect(() => parseRootKeySet('{"issued_at":"yesterday","keys":[]}')).toThrow(/HOTEL_ROOT_KEYSET/);
    });
  });

  describe('loadLicensingConfig', () => {
    const full = () => ({
      CENTRAL_ADMIN_URL: fake.url,
      CENTRAL_ADMIN_ALLOW_HTTP: 'true',
      HOTEL_ROOT_KEYSET: JSON.stringify(fake.rootKeySet),
      HOTEL_SECRET_KEY: randomBytes(32).toString('base64url'),
    });

    it('builds client, root and secret box from a complete environment', () => {
      const c = loadLicensingConfig(full());

      expect(c.client).not.toBeNull();
      expect(c.rootKeySet?.issued_at).toBe(fake.rootKeySet.payload.issued_at);
      expect(c.secretBox).not.toBeNull();
    });

    it('leaves each missing or unusable part null so the API still boots', () => {
      expect(loadLicensingConfig({})).toEqual({ client: null, rootKeySet: null, secretBox: null });
      expect(loadLicensingConfig({ ...full(), HOTEL_SECRET_KEY: 'short' }).secretBox).toBeNull();
    });

    it('http URL without CENTRAL_ADMIN_ALLOW_HTTP=true: fails at startup', () => {
      expect(() => loadLicensingConfig({ ...full(), CENTRAL_ADMIN_ALLOW_HTTP: undefined })).toThrow(
        /CENTRAL_ADMIN_ALLOW_HTTP/,
      );
      expect(() => loadLicensingConfig({ ...full(), CENTRAL_ADMIN_ALLOW_HTTP: '1' })).toThrow(
        /CENTRAL_ADMIN_ALLOW_HTTP/,
      );
    });
  });
});
