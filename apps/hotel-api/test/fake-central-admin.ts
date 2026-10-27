import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  fromBase64Url,
  generateSigningKeyPair,
  signKeySet,
  signLicense,
  verifyRequestSignature,
  type LicenseEnvelope,
  type LicensePayload,
  type PublicKeyEntry,
  type SignedKeySet,
  type Signer,
} from '@platform/licensing';

// A real HTTP stand-in for the Central Admin Panel's installation API, signing
// with the real @platform/licensing functions. Route shapes follow the Admin
// Panel (installations.service.ts, installation-api.controller.ts,
// keys.controller.ts). Shared by the licensing specs of tasks 3, 4 and 5.
//
// Keys: the pinned root set (issued an hour ago) holds key "root-1". A rotated
// set, signed by root-1 a minute later, retires root-1 and adds "k2", which
// signs licences. So a licence verifies only when the installation actually
// accepted the rotated set from the root.

export interface RecordedRequest {
  method: string;
  /** Raw request target: path plus query string. */
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface IssueCodeOptions {
  /**
   * Which key set the activation response carries and which key signs the
   * licence: 'rotated' (default; chains from the root), 'root' (the pinned root
   * set itself, as a fresh Admin Panel without rotations returns), 'foreign'
   * (signed by a key the root never vouched for).
   */
  keySet?: 'rotated' | 'root' | 'foreign';
  /** Overrides on this installation's licence payload. */
  licence?: Partial<LicensePayload>;
}

export interface FakeCentralAdmin {
  url: string;
  /** What `GET /v1/keys` returned before any rotation: the value of HOTEL_ROOT_KEYSET. */
  rootKeySet: SignedKeySet;
  issueCode(opts?: IssueCodeOptions): string;
  /** Patches every installation's licence and bumps its revision. */
  setLicence(patch: Partial<LicensePayload>): void;
  /** While down, every request is answered 503. */
  setDown(down: boolean): void;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

interface Installation {
  id: string;
  publicKey: string;
  revision: number;
  signer: 'rotated' | 'root' | 'foreign';
  overrides: Partial<LicensePayload>;
  envelope: LicenseEnvelope;
}

interface Code {
  used: boolean;
  opts: IssueCodeOptions;
}

const DAY_MS = 86_400_000;

function keyEntry(keyId: string, publicKey: string, from: string, until: string | null): PublicKeyEntry {
  return { key_id: keyId, public_key: publicKey, active_from: from, active_until: until };
}

export async function startFakeCentralAdmin(): Promise<FakeCentralAdmin> {
  const now = Date.now();
  const t0 = new Date(now - 60 * 60_000).toISOString();
  const t1 = new Date(now - 59 * 60_000).toISOString();
  const epoch = '2020-01-01T00:00:00.000Z';

  const rootPair = generateSigningKeyPair();
  const k2Pair = generateSigningKeyPair();
  const evilPair = generateSigningKeyPair();
  const signers: Record<'root' | 'rotated' | 'foreign', Signer> = {
    root: { keyId: 'root-1', privateKeyPem: rootPair.privateKeyPem },
    rotated: { keyId: 'k2', privateKeyPem: k2Pair.privateKeyPem },
    foreign: { keyId: 'evil-1', privateKeyPem: evilPair.privateKeyPem },
  };

  const rootKeySet = signKeySet(
    { type: 'keyset', issued_at: t0, keys: [keyEntry('root-1', rootPair.publicKey, epoch, null)] },
    signers.root,
  );
  const rotatedKeySet = signKeySet(
    {
      type: 'keyset',
      issued_at: t1,
      keys: [
        keyEntry('root-1', rootPair.publicKey, epoch, t1),
        keyEntry('k2', k2Pair.publicKey, t1, null),
      ],
    },
    signers.root,
  );
  const foreignKeySet = signKeySet(
    { type: 'keyset', issued_at: t1, keys: [keyEntry('evil-1', evilPair.publicKey, epoch, null)] },
    signers.foreign,
  );
  const published = [rootKeySet, rotatedKeySet];
  const keySetFor = { root: rootKeySet, rotated: rotatedKeySet, foreign: foreignKeySet };

  const codes = new Map<string, Code>();
  const installations = new Map<string, Installation>();
  const requests: RecordedRequest[] = [];
  let globalPatch: Partial<LicensePayload> = {};
  let down = false;

  function issue(inst: Omit<Installation, 'envelope'>): LicenseEnvelope {
    const issued = Date.now();
    const payload: LicensePayload = {
      type: 'license',
      license_id: `lic-${inst.id}`,
      revision: inst.revision,
      client_id: 'client-1',
      product: 'hotel',
      installation_id: inst.id,
      subscription_status: 'active',
      modules: ['hotel.core'],
      limits: { rooms: 20 },
      issued_at: new Date(issued).toISOString(),
      valid_until: new Date(issued + 30 * DAY_MS).toISOString(),
      grace_until: new Date(issued + 37 * DAY_MS).toISOString(),
      expiry_mode: 'hard_lock',
      claims: {},
      ...inst.overrides,
      ...globalPatch,
    };
    payload.revision = inst.revision;
    return signLicense(payload, signers[inst.signer]);
  }

  function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, body === undefined ? headers : { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  function refuse(res: ServerResponse, status: number, code: string, message: string): void {
    send(res, status, { code, message });
  }

  function parseJson(raw: string): Record<string, unknown> | null {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }

  // Signature only, as verifyRequestSignature documents; the clock window and
  // nonce replay table of the real server are not modelled.
  function authenticate(req: RecordedRequest): Installation | null {
    const id = req.headers['x-installation-id'];
    const inst = id ? installations.get(id) : undefined;
    if (!inst) return null;
    const ok = verifyRequestSignature({
      publicKey: inst.publicKey,
      method: req.method,
      pathWithQuery: req.path,
      body: req.body,
      headers: req.headers,
    });
    return ok ? inst : null;
  }

  function handle(rec: RecordedRequest, res: ServerResponse): void {
    if (down) return send(res, 503, { code: 'unavailable', message: 'down' });
    const url = new URL(rec.path, 'http://fake');

    if (rec.method === 'POST' && url.pathname === '/v1/installations/activate') {
      const body = parseJson(rec.body);
      const keys = body ? Object.keys(body).sort() : [];
      if (!body || keys.length !== 2 || keys[0] !== 'code' || keys[1] !== 'publicKey') {
        return refuse(res, 422, 'validation_failed', 'Telo mora biti tačno {code, publicKey}.');
      }
      const { code, publicKey } = body as { code: unknown; publicKey: unknown };
      let keyOk = false;
      try {
        keyOk = typeof publicKey === 'string' && fromBase64Url(publicKey).length === 32;
      } catch {
        keyOk = false;
      }
      if (typeof code !== 'string' || !keyOk) {
        return refuse(res, 422, 'validation_failed', 'Neispravan kod ili javni ključ.');
      }
      const entry = codes.get(code);
      if (!entry) return refuse(res, 404, 'activation_code_unknown', 'Aktivacioni kod nije pronađen.');
      if (entry.used) return refuse(res, 409, 'activation_code_used', 'Aktivacioni kod je već iskorišćen.');
      entry.used = true;
      const signer = entry.opts.keySet ?? 'rotated';
      const base = { id: randomUUID(), publicKey: publicKey as string, revision: 1, signer, overrides: entry.opts.licence ?? {} };
      const inst: Installation = { ...base, envelope: issue(base) };
      installations.set(inst.id, inst);
      return send(res, 200, { installationId: inst.id, license: inst.envelope, keySet: keySetFor[signer] });
    }

    if (rec.method === 'GET' && url.pathname === '/v1/keys') {
      const since = url.searchParams.get('since');
      if (since === null) return send(res, 200, published[published.length - 1]);
      const at = Date.parse(since);
      if (Number.isNaN(at)) return refuse(res, 400, 'invalid_since', 'Neispravan parametar "since".');
      return send(res, 200, { keySets: published.filter((s) => Date.parse(s.payload.issued_at) > at) });
    }

    if (url.pathname === '/v1/license' || url.pathname === '/v1/heartbeat') {
      const inst = authenticate(rec);
      if (!inst) return refuse(res, 401, 'request_unauthenticated', 'Potpis zahteva nije ispravan.');

      if (rec.method === 'GET' && url.pathname === '/v1/license') {
        const etag = `"${inst.revision}"`;
        if (rec.headers['if-none-match'] === etag) return send(res, 304, undefined, { etag });
        return send(res, 200, inst.envelope, { etag });
      }
      if (rec.method === 'POST' && url.pathname === '/v1/heartbeat') {
        const body = parseJson(rec.body);
        if (!body || Object.keys(body).join(',') !== 'version' || typeof body.version !== 'string') {
          return refuse(res, 422, 'validation_failed', 'Telo mora biti tačno {version}.');
        }
        return send(res, 200, { serverTime: new Date().toISOString(), latestRevision: inst.revision });
      }
    }

    return refuse(res, 404, 'not_found', 'Nepoznata ruta.');
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const rec: RecordedRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(rec);
      try {
        handle(rec, res);
      } catch (err) {
        send(res, 500, { code: 'internal', message: (err as Error).message });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    rootKeySet,
    issueCode(opts: IssueCodeOptions = {}): string {
      const code = `CODE-${randomUUID()}`;
      codes.set(code, { used: false, opts });
      return code;
    },
    setLicence(patch: Partial<LicensePayload>): void {
      globalPatch = { ...globalPatch, ...patch };
      for (const inst of installations.values()) {
        inst.revision += 1;
        inst.envelope = issue(inst);
      }
    },
    setDown(value: boolean): void {
      down = value;
    },
    requests,
    close(): Promise<void> {
      server.closeAllConnections();
      return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
