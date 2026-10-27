import { createPrivateKey, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../../test/app';
import { createTestDb, type TestDb } from '../../test/db';
import { startFakeCentralAdmin, type FakeCentralAdmin } from '../../test/fake-central-admin';
import { AuditService } from '../common/audit.service';
import { DomainError } from '../common/domain-error';
import { auditLog } from '../db/schema';
import { ActivationService, type LicensingConfig } from './activation.service';
import { CentralAdminClient } from './central-admin.client';
import { LicenceStore } from './licence.store';
import { parseRootKeySet } from './licensing.config';
import { SecretBox } from './secret-box';

// DER prefix of an Ed25519 PKCS#8 key; the 32 seed bytes follow. Used to derive
// the public key from the stored seed independently of the code under test.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function publicKeyOfSeed(seed: string): string {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed, 'base64url')]),
    format: 'der',
    type: 'pkcs8',
  });
  return createPublicKey(key).export({ format: 'jwk' }).x!;
}

async function domainError(p: Promise<unknown>): Promise<DomainError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DomainError) return err;
    throw err;
  }
  throw new Error('expected a DomainError');
}

describe('ActivationService', () => {
  let t: TestDb;
  let fake: FakeCentralAdmin;
  let store: LicenceStore;
  let box: SecretBox;
  let config: LicensingConfig;
  let service: ActivationService;

  const activationRequests = () => fake.requests.filter((r) => r.path === '/v1/installations/activate');

  beforeAll(async () => {
    t = await createTestDb();
    fake = await startFakeCentralAdmin();
  });
  beforeEach(async () => {
    await t.truncate();
    store = new LicenceStore(t.db);
    box = new SecretBox(randomBytes(32));
    config = {
      client: new CentralAdminClient({ baseUrl: fake.url, allowHttp: true }),
      rootKeySet: parseRootKeySet(JSON.stringify(fake.rootKeySet)),
      secretBox: box,
    };
    service = new ActivationService(t.db, store, new AuditService(), config);
  });
  afterAll(async () => {
    await fake.close();
    await t.close();
  });

  it('valid code: stores installation_id and licence; the seed in the database is unreadable without HOTEL_SECRET_KEY', async () => {
    await service.activate(fake.issueCode());

    const row = await store.get();
    expect(row).not.toBeNull();
    expect(row!.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(row!.envelope.payload.installation_id).toBe(row!.installationId);
    expect(row!.envelope.payload.revision).toBe(1);
    // The rotated set accepted from the root is what is trusted now.
    expect(row!.keySet.keys.map((k) => k.key_id)).toEqual(['root-1', 'k2']);
    expect(row!.memory.highestRevision).toBe(1);

    const { rows } = await t.pool.query<{ private_seed_enc: string }>(
      'SELECT private_seed_enc FROM installation_licence',
    );
    const enc = rows[0].private_seed_enc;
    expect(enc).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const seed = box.open(enc);
    expect(Buffer.from(seed, 'base64url')).toHaveLength(32);
    expect(enc).not.toContain(seed);
    expect(() => new SecretBox(randomBytes(32)).open(enc)).toThrow();

    // The stored seed is the private half of the key registered at activation.
    const sent = JSON.parse(activationRequests().pop()!.body);
    expect(publicKeyOfSeed(seed)).toBe(sent.publicKey);
    // ...and the fake accepts requests signed with it for this installation.
    await expect(
      config.client!.heartbeat({ installationId: row!.installationId, privateKey: seed }, '0.0.0'),
    ).resolves.toMatchObject({ latestRevision: 1 });

    const audits = await t.db.select().from(auditLog);
    expect(audits).toEqual([
      expect.objectContaining({ action: 'installation.activate', entity: 'installation', entityId: row!.installationId }),
    ]);
  });

  it('a key set equal to the pinned root (no rotation yet) keeps the root and activates', async () => {
    await service.activate(fake.issueCode({ keySet: 'root' }));

    const row = await store.get();
    expect(row!.keySet).toEqual({
      issued_at: fake.rootKeySet.payload.issued_at,
      keys: fake.rootKeySet.payload.keys,
    });
  });

  it('a key set that does not chain from the root: nothing is stored, 422 activation_rejected', async () => {
    const err = await domainError(service.activate(fake.issueCode({ keySet: 'foreign' })));

    expect(err).toMatchObject({ code: 'activation_rejected', status: 422 });
    expect(err.details).toEqual({ reason: 'keyset_unknown_key' });
    expect(await store.get()).toBeNull();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('a licence for another installation (wrong_installation): nothing is stored', async () => {
    const err = await domainError(
      service.activate(fake.issueCode({ licence: { installation_id: randomUUID() } })),
    );

    expect(err).toMatchObject({ code: 'activation_rejected', status: 422 });
    expect(err.details).toEqual({ reason: 'wrong_installation' });
    expect(await store.get()).toBeNull();
  });

  it('an authentic licence that is not VALID or GRACE (suspended): nothing is stored', async () => {
    const err = await domainError(
      service.activate(fake.issueCode({ licence: { subscription_status: 'suspended' } })),
    );

    expect(err).toMatchObject({ code: 'activation_rejected', status: 422 });
    expect(err.details).toEqual({ reason: 'expired' });
    expect(await store.get()).toBeNull();
  });

  it('Admin Panel unavailable: 503 central_admin_unavailable, and the code can be used again', async () => {
    const code = fake.issueCode();
    const before = activationRequests().length;
    fake.setDown(true);
    let err: DomainError;
    try {
      err = await domainError(service.activate(code));
    } finally {
      fake.setDown(false);
    }

    expect(err).toMatchObject({ code: 'central_admin_unavailable', status: 503 });
    expect(activationRequests().length).toBe(before + 1);
    expect(await store.get()).toBeNull();

    await service.activate(code);
    expect(await store.get()).not.toBeNull();
  });

  it('a refusal from the Admin Panel keeps its code and status', async () => {
    const err = await domainError(service.activate('NO-SUCH-CODE'));

    expect(err).toMatchObject({ code: 'activation_code_unknown', status: 404 });
    expect(await store.get()).toBeNull();
  });

  it('second activation: 409 already_activated, and no code is spent on it', async () => {
    await service.activate(fake.issueCode());
    const first = await store.get();
    const before = activationRequests().length;

    const err = await domainError(service.activate(fake.issueCode()));

    expect(err).toMatchObject({ code: 'already_activated', status: 409 });
    expect(activationRequests().length).toBe(before);
    expect((await store.get())!.installationId).toBe(first!.installationId);
  });

  it.each([
    ['no secret key', { secretBox: null }],
    ['no root key set', { rootKeySet: null }],
    ['no Central Admin URL', { client: null }],
  ])('%s: 503 licensing_not_configured without calling the Admin Panel', async (_label, patch) => {
    const before = fake.requests.length;
    const partial = new ActivationService(t.db, store, new AuditService(), { ...config, ...patch });

    const err = await domainError(partial.activate(fake.issueCode()));

    expect(err).toMatchObject({ code: 'licensing_not_configured', status: 503 });
    expect(fake.requests.length).toBe(before);
    expect(await store.get()).toBeNull();
  });
});

describe('LicensingModule wiring', () => {
  let app: INestApplication;
  let testDb: TestDb;

  beforeAll(async () => {
    for (const k of ['CENTRAL_ADMIN_URL', 'CENTRAL_ADMIN_ALLOW_HTTP', 'HOTEL_ROOT_KEYSET', 'HOTEL_SECRET_KEY']) {
      delete process.env[k];
    }
    ({ app, testDb } = await createTestApp());
  });
  afterAll(async () => {
    // Closing the app ends the shared pool through DatabaseModule's shutdown hook.
    await app.close();
    if (!testDb.pool.ended) await testDb.close();
  });

  it('the API boots without licensing configuration and activation answers 503 licensing_not_configured', async () => {
    const err = await domainError(app.get(ActivationService).activate('ANY'));

    expect(err).toMatchObject({ code: 'licensing_not_configured', status: 503 });
  });
});
