import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startFakeCentralAdmin, type FakeCentralAdmin } from '../../test/fake-central-admin';
import { newInstallationKeyPair } from './activation.service';
import {
  CentralAdminClient,
  ParentRefusal,
  ParentUnavailable,
  type InstallationAuth,
} from './central-admin.client';

const SIGNED_HEADERS = ['x-installation-id', 'x-timestamp', 'x-nonce', 'x-signature'];

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to fail');
}

describe('CentralAdminClient', () => {
  let fake: FakeCentralAdmin;
  let client: CentralAdminClient;
  let auth: InstallationAuth;

  beforeAll(async () => {
    fake = await startFakeCentralAdmin();
    client = new CentralAdminClient({ baseUrl: fake.url, allowHttp: true });
    const pair = newInstallationKeyPair();
    const activated = await client.activate(fake.issueCode(), pair.publicKey);
    auth = { installationId: activated.installationId, privateKey: pair.seed };
  });
  afterAll(async () => {
    await fake.close();
  });

  it('activate sends exactly {code, publicKey} and returns the installation, licence and key set', async () => {
    const pair = newInstallationKeyPair();
    const code = fake.issueCode();
    const res = await client.activate(code, pair.publicKey);

    const sent = fake.requests.filter((r) => r.path === '/v1/installations/activate').pop()!;
    expect(JSON.parse(sent.body)).toEqual({ code, publicKey: pair.publicKey });
    expect(res.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.license.payload.installation_id).toBe(res.installationId);
    expect(res.keySet.payload.type).toBe('keyset');
  });

  it('heartbeat and license requests carry X-Installation-Id, X-Timestamp, X-Nonce, X-Signature that the fake accepts', async () => {
    const before = fake.requests.length;

    const beat = await client.heartbeat(auth, '1.2.3');
    const changed = await client.fetchLicence(auth);
    const unchanged = await client.fetchLicence(auth, 1);

    expect(beat.latestRevision).toBe(1);
    expect(Number.isNaN(Date.parse(beat.serverTime))).toBe(false);
    expect(changed.status).toBe('changed');
    expect(changed.status === 'changed' && (changed.envelope as any).payload.installation_id).toBe(
      auth.installationId,
    );
    expect(unchanged).toEqual({ status: 'unchanged' });

    const sent = fake.requests.slice(before);
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /v1/heartbeat',
      'GET /v1/license',
      'GET /v1/license',
    ]);
    for (const r of sent) {
      for (const h of SIGNED_HEADERS) expect(r.headers[h]).toEqual(expect.any(String));
      expect(r.headers['x-installation-id']).toBe(auth.installationId);
    }
    expect(JSON.parse(sent[0].body)).toEqual({ version: '1.2.3' });
    expect(sent[2].headers['if-none-match']).toBe('"1"');
    // Each request gets its own nonce.
    expect(new Set(sent.map((r) => r.headers['x-nonce'])).size).toBe(3);
  });

  it('the fake refuses a request signed with another key (so the acceptance above is real)', async () => {
    const other = newInstallationKeyPair();
    const err = await caught(client.heartbeat({ ...auth, privateKey: other.seed }, '1.2.3'));

    expect(err).toBeInstanceOf(ParentRefusal);
    expect(err).toMatchObject({ code: 'request_unauthenticated', status: 401 });
  });

  it('a newer licence revision comes back as changed when the held revision is old', async () => {
    fake.setLicence({ modules: ['hotel.core', 'hotel.channel'] });
    const res = await client.fetchLicence(auth, 1);

    expect(res.status).toBe('changed');
    expect(res.status === 'changed' && (res.envelope as any).payload.revision).toBe(2);
  });

  it('keySetsSince returns the sets issued after the given instant', async () => {
    const sets = await client.keySetsSince(fake.rootKeySet.payload.issued_at);

    expect(sets).toHaveLength(1);
    expect(sets[0].payload.keys.map((k) => k.key_id)).toEqual(['root-1', 'k2']);
    const sent = fake.requests[fake.requests.length - 1];
    expect(sent.path).toBe(`/v1/keys?since=${encodeURIComponent(fake.rootKeySet.payload.issued_at)}`);
  });

  it('a 4xx answer with a code is a ParentRefusal carrying that code', async () => {
    const err = await caught(client.activate('NO-SUCH-CODE', newInstallationKeyPair().publicKey));

    expect(err).toBeInstanceOf(ParentRefusal);
    expect(err).toMatchObject({ code: 'activation_code_unknown', status: 404 });
  });

  it('a 5xx answer is ParentUnavailable, never a refusal', async () => {
    fake.setDown(true);
    try {
      const err = await caught(client.heartbeat(auth, '1.2.3'));
      expect(err).toBeInstanceOf(ParentUnavailable);
    } finally {
      fake.setDown(false);
    }
  });

  it('a network failure is ParentUnavailable', async () => {
    const closed = await startFakeCentralAdmin();
    await closed.close();
    const offline = new CentralAdminClient({ baseUrl: closed.url, allowHttp: true });

    expect(await caught(offline.keySetsSince('2020-01-01T00:00:00.000Z'))).toBeInstanceOf(ParentUnavailable);
  });

  it('a parent that never answers times out as ParentUnavailable', async () => {
    const hanging: Server = createServer(() => {
      /* never responds */
    });
    await new Promise<void>((r) => hanging.listen(0, '127.0.0.1', r));
    const { port } = hanging.address() as AddressInfo;
    try {
      const slow = new CentralAdminClient({ baseUrl: `http://127.0.0.1:${port}`, allowHttp: true, timeoutMs: 200 });
      const started = Date.now();
      const err = await caught(slow.keySetsSince('2020-01-01T00:00:00.000Z'));
      expect(err).toBeInstanceOf(ParentUnavailable);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      hanging.closeAllConnections();
      await new Promise((r) => hanging.close(r));
    }
  });

  it('defaults to a 15 s timeout', () => {
    expect(new CentralAdminClient({ baseUrl: 'https://admin.example.com' }).timeoutMs).toBe(15_000);
  });

  describe('URL policy', () => {
    it('http URL without permission: fails at construction', () => {
      expect(() => new CentralAdminClient({ baseUrl: 'http://admin.example.com' })).toThrow(
        /CENTRAL_ADMIN_ALLOW_HTTP/,
      );
      expect(() => new CentralAdminClient({ baseUrl: 'http://127.0.0.1:4100', allowHttp: false })).toThrow(
        /CENTRAL_ADMIN_ALLOW_HTTP/,
      );
    });

    it('https is accepted, and http only with allowHttp', () => {
      expect(() => new CentralAdminClient({ baseUrl: 'https://admin.example.com' })).not.toThrow();
      expect(() => new CentralAdminClient({ baseUrl: 'http://admin.example.com', allowHttp: true })).not.toThrow();
    });

    it('anything else is refused', () => {
      expect(() => new CentralAdminClient({ baseUrl: 'not a url' })).toThrow(/CENTRAL_ADMIN_URL/);
      expect(() => new CentralAdminClient({ baseUrl: 'ftp://admin.example.com', allowHttp: true })).toThrow(
        /CENTRAL_ADMIN_URL/,
      );
    });
  });
});
