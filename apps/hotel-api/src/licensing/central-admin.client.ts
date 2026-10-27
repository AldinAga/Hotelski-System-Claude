import { signRequest, type LicenseEnvelope, type SignedKeySet } from '@platform/licensing';

// HTTP transport to the Central Admin Panel's installation API. It signs,
// sends and classifies answers; it decides nothing about the licence.
//
// Two kinds of error, which callers must keep apart:
//  - ParentRefusal: the Admin Panel understood and said no (4xx with {code}).
//  - ParentUnavailable: no answer we can trust (network, timeout, 5xx, odd
//    shape). "I don't know" -- never a verdict either way.

export class ParentRefusal extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ParentRefusal';
  }
}

export class ParentUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParentUnavailable';
  }
}

export interface InstallationAuth {
  installationId: string;
  /** The raw 32-byte Ed25519 seed, base64url (what signRequest takes). */
  privateKey: string;
}

export interface ActivationResponse {
  installationId: string;
  license: LicenseEnvelope;
  keySet: SignedKeySet;
}

export type LicenceFetch = { status: 'unchanged' } | { status: 'changed'; envelope: unknown };

export interface CentralAdminClientOptions {
  baseUrl: string;
  /** CENTRAL_ADMIN_ALLOW_HTTP=true: permit plain http (LAN staging, tests). */
  allowHttp?: boolean;
  timeoutMs?: number;
  /** Clock for X-Timestamp; injectable for tests. */
  now?: () => Date;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

// The activation code and every signed request travel over this connection;
// on plain http both are readable and the server's time is forgeable. So
// https only, unless the operator explicitly allows http.
function checkUrl(baseUrl: string, allowHttp: boolean): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('CENTRAL_ADMIN_URL is not a valid URL');
  }
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:') {
    if (allowHttp) return;
    throw new Error(
      `CENTRAL_ADMIN_URL must use https (got http://${url.host}); plain http needs CENTRAL_ADMIN_ALLOW_HTTP=true`,
    );
  }
  throw new Error(`CENTRAL_ADMIN_URL must use https (got ${url.protocol})`);
}

export class CentralAdminClient {
  readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly now: () => Date;

  constructor(options: CentralAdminClientOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    checkUrl(this.baseUrl, options.allowHttp === true);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  /** Public route: the code is the credential. `publicKey` is base64url of the raw 32 bytes. */
  async activate(code: string, publicKey: string): Promise<ActivationResponse> {
    const res = await this.send('POST', '/v1/installations/activate', JSON.stringify({ code, publicKey }));
    const body = await readJson(res);
    if (
      typeof body?.installationId !== 'string' ||
      !isObject(body?.license) ||
      !isObject(body?.keySet)
    ) {
      throw new ParentUnavailable('Centralni admin je vratio neočekivan odgovor na aktivaciju.');
    }
    return body as ActivationResponse;
  }

  /** GET /v1/license; with the held revision as If-None-Match, an unchanged licence is a 304. */
  async fetchLicence(auth: InstallationAuth, heldRevision?: number | null): Promise<LicenceFetch> {
    const headers: Record<string, string> = {};
    if (heldRevision !== undefined && heldRevision !== null) headers['if-none-match'] = `"${heldRevision}"`;
    const res = await this.send('GET', '/v1/license', '', auth, headers);
    if (res.status === 304) return { status: 'unchanged' };
    const envelope = await readJson(res);
    if (!isObject(envelope)) {
      throw new ParentUnavailable('Centralni admin je vratio licencu koja se ne može pročitati.');
    }
    return { status: 'changed', envelope };
  }

  /** POST /v1/heartbeat; the body is exactly {version}. */
  async heartbeat(
    auth: InstallationAuth,
    version: string,
  ): Promise<{ serverTime: string; latestRevision: number | null }> {
    const res = await this.send('POST', '/v1/heartbeat', JSON.stringify({ version }), auth);
    const body = await readJson(res);
    const latest = body?.latestRevision;
    if (
      typeof body?.serverTime !== 'string' ||
      !(latest === null || (typeof latest === 'number' && Number.isSafeInteger(latest)))
    ) {
      throw new ParentUnavailable('Centralni admin je vratio neočekivan odgovor na heartbeat.');
    }
    return { serverTime: body.serverTime, latestRevision: latest };
  }

  /** Public route: every key set published after `issuedAt`, oldest first. */
  async keySetsSince(issuedAt: string): Promise<SignedKeySet[]> {
    const res = await this.send('GET', `/v1/keys?since=${encodeURIComponent(issuedAt)}`, '');
    const body = await readJson(res);
    if (!Array.isArray(body?.keySets)) {
      throw new ParentUnavailable('Centralni admin je vratio neočekivan skup ključeva.');
    }
    return body.keySets as SignedKeySet[];
  }

  private async send(
    method: 'GET' | 'POST',
    pathWithQuery: string,
    body: string,
    auth?: InstallationAuth,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}${pathWithQuery}`);
    const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders };
    if (body) headers['content-type'] = 'application/json';
    if (auth) {
      // The server verifies over the request target it received, so a base URL
      // with a path prefix is signed including that prefix.
      Object.assign(
        headers,
        signRequest({
          installationId: auth.installationId,
          privateKey: auth.privateKey,
          method,
          pathWithQuery: url.pathname + url.search,
          body,
          now: this.now(),
        }),
      );
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body || undefined,
        // A 3xx must not resend the activation code or the signed headers to
        // another location; fetch then fails and the call is ParentUnavailable.
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // The error text is not echoed: network errors can quote request details.
      throw new ParentUnavailable(`Centralni admin nije dostupan (${(err as Error)?.name ?? 'greška'}).`);
    }
    if (res.status === 304 || (res.status >= 200 && res.status < 300)) return res;
    const refusal = await readJson(res);
    if (res.status >= 400 && res.status < 500 && typeof refusal?.code === 'string') {
      throw new ParentRefusal(
        refusal.code,
        res.status,
        typeof refusal.message === 'string' ? refusal.message : refusal.code,
      );
    }
    throw new ParentUnavailable(`Centralni admin je odgovorio neočekivano (HTTP ${res.status}).`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Parsed with this realm's JSON, not res.json(): the SDK's canonicalizer only
// accepts plain objects whose prototype is this realm's Object.prototype, and
// fetch builds res.json() objects in Node's own realm, which differs under a
// VM sandbox such as Jest's. A licence parsed that way fails as bad_signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untrusted JSON, shape-checked by each caller
async function readJson(res: Response): Promise<any> {
  try {
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
}
