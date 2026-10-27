import { acceptKeySet, type KeySet } from '@platform/licensing';
import { CentralAdminClient } from './central-admin.client';
import { SecretBox } from './secret-box';

export const LICENSING_CONFIG = Symbol('LICENSING_CONFIG');

// Each part is null when its environment variable is missing; licensing then
// answers 503 licensing_not_configured while the rest of the API keeps working.
export interface LicensingConfig {
  client: CentralAdminClient | null;
  rootKeySet: KeySet | null;
  secretBox: SecretBox | null;
  /** Clock for licence evaluation; defaults to the system clock. */
  now?: () => Date;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/**
 * HOTEL_ROOT_KEYSET: the key set pinned at install time. Takes what
 * `GET {CENTRAL_ADMIN_URL}/v1/keys` prints (a signed key set) or a bare
 * `{issued_at, keys}`, as JSON or base64 of it. A signed set must verify
 * against its own keys, which catches a truncated or edited paste. Unset gives
 * null; anything malformed throws, so a wrong pin fails at startup.
 */
export function parseRootKeySet(raw: string | undefined | null): KeySet | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  const fail = (why: string): never => {
    throw new Error(`HOTEL_ROOT_KEYSET is not a valid key set (${why})`);
  };
  let text = raw.trim();
  if (!text.startsWith('{')) text = Buffer.from(text, 'base64').toString('utf8').trim();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untrusted JSON, shape-checked below
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('not JSON');
  }
  let keySet: KeySet;
  if (parsed?.payload?.type === 'keyset') {
    const self = acceptKeySet(parsed, {
      issued_at: '1970-01-01T00:00:00.000Z',
      keys: Array.isArray(parsed.payload.keys) ? parsed.payload.keys : [],
    });
    if (!self.ok) return fail(`signature: ${self.reason}`);
    keySet = self.keySet;
  } else if (typeof parsed?.issued_at === 'string' && Array.isArray(parsed?.keys)) {
    keySet = { issued_at: parsed.issued_at, keys: parsed.keys };
  } else {
    return fail('no issued_at and keys');
  }
  if (!ISO_UTC.test(keySet.issued_at) || Number.isNaN(Date.parse(keySet.issued_at))) {
    return fail('issued_at');
  }
  if (keySet.keys.length === 0) return fail('no keys');
  for (const k of keySet.keys) {
    if (typeof k?.key_id !== 'string' || typeof k?.public_key !== 'string') return fail('key entry');
  }
  return keySet;
}

/**
 * Reads CENTRAL_ADMIN_URL, CENTRAL_ADMIN_ALLOW_HTTP, HOTEL_ROOT_KEYSET and
 * HOTEL_SECRET_KEY. Throws only for configuration that is present but wrong in
 * a way that must stop the boot: an http URL without CENTRAL_ADMIN_ALLOW_HTTP=true,
 * an invalid URL, or a malformed root key set.
 */
export function loadLicensingConfig(env: Record<string, string | undefined>): LicensingConfig {
  const url = env.CENTRAL_ADMIN_URL?.trim();
  return {
    client: url
      ? new CentralAdminClient({ baseUrl: url, allowHttp: env.CENTRAL_ADMIN_ALLOW_HTTP === 'true' })
      : null,
    rootKeySet: parseRootKeySet(env.HOTEL_ROOT_KEYSET),
    secretBox: SecretBox.fromEnv(env.HOTEL_SECRET_KEY?.trim()),
  };
}
