import { randomBytes } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SetupService } from '../src/auth/setup.service';
import { totpGenerate } from '../src/auth/totp';
import { LicenceService } from '../src/licensing/licence.service';
import { CentralAdminClient } from '../src/licensing/central-admin.client';
import { parseRootKeySet } from '../src/licensing/licensing.config';
import { SecretBox } from '../src/licensing/secret-box';
import { createTestApp, type TestApp } from './app';
import { cookieFrom, seedUser } from './auth-helpers';
import { startFakeCentralAdmin, type FakeCentralAdmin } from './fake-central-admin';

const TOKEN_FORMAT = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

describe('first-run setup (e2e)', () => {
  let fake: FakeCentralAdmin;
  let ta: TestApp;
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    fake = await startFakeCentralAdmin();
    ta = await createTestApp({
      licensing: {
        client: new CentralAdminClient({ baseUrl: fake.url, allowHttp: true }),
        rootKeySet: parseRootKeySet(JSON.stringify(fake.rootKeySet)),
        secretBox: new SecretBox(randomBytes(32)),
      },
    });
    app = ta.app;
  });
  beforeEach(async () => {
    fake.setDown(false);
    await ta.reset();
    token = (await app.get(SetupService).prepareOnBoot())!;
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await app.close();
    await fake.close();
  });

  const server = () => app.getHttpServer();
  const count = async (table: string): Promise<number> =>
    Number((await ta.testDb.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  const owner = {
    propertyName: 'Hotel Tara',
    legalKind: 'legal_entity',
    email: 'vlasnik@hotel.test',
    name: 'Vlasnik',
    password: 'vlasnikova-lozinka',
  };
  const activate = (setupToken: string, code = fake.issueCode()) =>
    request(server()).post('/setup/activate').send({ setupToken, code });

  describe('the setup token', () => {
    it('is XXXX-XXXX-XXXX from an unambiguous alphabet, logged once, stored only as a hash', async () => {
      await ta.reset();
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const fresh = await app.get(SetupService).prepareOnBoot();
      expect(fresh).toMatch(TOKEN_FORMAT);
      const lines = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(fresh!));
      expect(lines).toEqual([`[hotel-api] Kod za prvo podešavanje: ${fresh}`]);

      const { rows } = await ta.testDb.pool.query('SELECT token_hash FROM setup_token');
      expect(rows).toHaveLength(1);
      expect(Buffer.isBuffer(rows[0].token_hash)).toBe(true);
      expect(rows[0].token_hash.toString('utf8')).not.toContain(fresh!);
      expect(rows[0].token_hash.toString('hex')).not.toContain(Buffer.from(fresh!).toString('hex'));
    });

    it('a restart before setup is done replaces the token: the old one stops working', async () => {
      const old = token;
      const next = (await app.get(SetupService).prepareOnBoot())!;
      expect(next).toMatch(TOKEN_FORMAT);
      expect(next).not.toBe(old);
      expect(await count('setup_token')).toBe(1);
      expect((await activate(old)).status).toBe(403);
      expect((await activate(next)).status).toBe(200);
    });

    it('is not created once an owner exists', async () => {
      await ta.reset();
      await seedUser(ta.testDb, 'owner');
      expect(await app.get(SetupService).prepareOnBoot()).toBeNull();
      expect(await count('setup_token')).toBe(0);
    });

    it('accepts lower case and missing dashes', async () => {
      const sloppy = token.toLowerCase().replace(/-/g, '');
      expect((await activate(sloppy)).status).toBe(200);
    });
  });

  it('GET /setup/status answers without a session', async () => {
    const res = await request(server()).get('/setup/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ activated: false, hasOwner: false, hasProperty: false });
  });

  it('wrong setup token: 403, nothing is created and the Admin Panel is not called', async () => {
    const calls = fake.requests.length;
    const wrongToken = token === 'AAAA-AAAA-AAAA' ? 'BBBB-BBBB-BBBB' : 'AAAA-AAAA-AAAA';

    const act = await activate(wrongToken);
    expect(act.status).toBe(403);
    expect(act.body.code).toBe('setup_token_invalid');
    expect(fake.requests.length).toBe(calls);
    expect(await count('installation_licence')).toBe(0);

    // With a valid activation, the owner step still checks the token.
    expect((await activate(token)).status).toBe(200);
    const own = await request(server()).post('/setup/owner').send({ ...owner, setupToken: wrongToken });
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('setup_token_invalid');
    expect(await count('property')).toBe(0);
    expect(await count('legal_profile')).toBe(0);
    expect(await count('app_user')).toBe(0);
    expect(await count('setup_token')).toBe(1);

    const missing = await request(server()).post('/setup/owner').send(owner);
    expect(missing.status).toBe(403);
  });

  it('activation takes effect at once (licence reloaded)', async () => {
    const res = await activate(token);
    expect(res.status).toBe(200);
    expect(app.get(LicenceService).snapshot()).toMatchObject({ activated: true, state: 'VALID' });
    expect((await request(server()).get('/setup/status')).body).toEqual({
      activated: true,
      hasOwner: false,
      hasProperty: false,
    });
  });

  it('Admin Panel refusals become 422 activation_refused with the parent code; unavailable stays 503', async () => {
    const unknown = await activate(token, 'CODE-does-not-exist');
    expect(unknown.status).toBe(422);
    expect(unknown.body).toMatchObject({ code: 'activation_refused', details: { parentCode: 'activation_code_unknown' } });

    const code = fake.issueCode();
    expect((await activate(token, code)).status).toBe(200);
    // Hotel codes pass through unchanged.
    const again = await activate(token, fake.issueCode());
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_activated');
  });

  it('Admin Panel down: 503 central_admin_unavailable', async () => {
    fake.setDown(true);
    const res = await activate(token);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('central_admin_unavailable');
  });

  it('the owner step needs an activated installation first', async () => {
    const res = await request(server()).post('/setup/owner').send({ ...owner, setupToken: token });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_activated');
    expect(await count('app_user')).toBe(0);
  });

  describe('owner and TOTP confirmation', () => {
    const ownerStep = (extra: Record<string, unknown> = {}) =>
      request(server())
        .post('/setup/owner')
        .send({ ...owner, setupToken: token, ...extra });
    const confirm = (totp: string, setupToken = token) =>
      request(server()).post('/setup/confirm').send({ setupToken, totp });
    const secretOf = (uri: string): string => new URL(uri).searchParams.get('secret')!;
    const signIn = (totp?: string) =>
      request(server()).post('/auth/login').send({ email: owner.email, password: owner.password, totp });
    // confirm uses the current step; a later login needs the next one.
    const nextCode = (secret: string): string => totpGenerate(secret, new Date(Date.now() + 30_000));

    beforeEach(async () => {
      expect((await activate(token)).status).toBe(200);
    });

    it('creates property, legal profile and an unconfirmed owner; setup stays open', async () => {
      const res = await ownerStep();
      expect(res.status).toBe(201);
      expect(Object.keys(res.body)).toEqual(['totpUri']);
      const uri = new URL(res.body.totpUri);
      expect(res.body.totpUri.startsWith('otpauth://totp/Hotel:')).toBe(true);
      expect(uri.host).toBe('totp');
      expect(decodeURIComponent(uri.pathname)).toBe(`/Hotel:${owner.email}`);
      expect(uri.searchParams.get('issuer')).toBe('Hotel');
      expect(secretOf(res.body.totpUri)).toMatch(/^[A-Z2-7]{32}$/);

      const { rows: props } = await ta.testDb.pool.query(
        'SELECT p.name, l.kind, l.fiscal_compliance_mode FROM property p JOIN legal_profile l ON l.property_id = p.id',
      );
      expect(props).toEqual([{ name: 'Hotel Tara', kind: 'legal_entity', fiscal_compliance_mode: 'required' }]);
      const { rows: users } = await ta.testDb.pool.query('SELECT email, name, role, active, totp_state FROM app_user');
      expect(users).toEqual([{ email: owner.email, name: 'Vlasnik', role: 'owner', active: true, totp_state: 'setup' }]);

      expect(await count('setup_token')).toBe(1);
      expect((await request(server()).get('/setup/status')).body).toEqual({
        activated: true,
        hasOwner: true,
        hasProperty: true,
      });

      // Not armed yet: even a valid code does not sign the owner in.
      const early = await signIn(totpGenerate(secretOf(res.body.totpUri), new Date()));
      expect(early.status).toBe(401);
      expect(early.body.code).toBe('totp_not_enrolled');
    });

    it('a natural person starts with fiscalisation disabled', async () => {
      expect((await ownerStep({ legalKind: 'natural_person' })).status).toBe(201);
      const { rows } = await ta.testDb.pool.query('SELECT kind, fiscal_compliance_mode FROM legal_profile');
      expect(rows).toEqual([{ kind: 'natural_person', fiscal_compliance_mode: 'disabled' }]);
    });

    it('repeating the owner step returns a new URI and creates nothing twice', async () => {
      const first = await ownerStep();
      expect(first.status).toBe(201);
      const second = await ownerStep({ name: 'Vlasnik Drugi', propertyName: 'Hotel Drina' });
      expect(second.status).toBe(201);
      expect(secretOf(second.body.totpUri)).not.toBe(secretOf(first.body.totpUri));

      expect(await count('property')).toBe(1);
      expect(await count('legal_profile')).toBe(1);
      expect(await count('app_user')).toBe(1);
      const { rows } = await ta.testDb.pool.query('SELECT p.name AS property, u.name FROM property p, app_user u');
      expect(rows).toEqual([{ property: 'Hotel Drina', name: 'Vlasnik Drugi' }]);

      // Only the newest secret confirms.
      const stale = await confirm(totpGenerate(secretOf(first.body.totpUri), new Date()));
      expect(stale.status).toBe(422);
      expect(stale.body.code).toBe('totp_invalid');
      expect((await confirm(totpGenerate(secretOf(second.body.totpUri), new Date()))).status).toBe(200);
    });

    it('confirm: wrong code 422 totp_invalid, no owner yet 409 owner_missing, wrong token 403', async () => {
      const none = await confirm('123456');
      expect(none.status).toBe(409);
      expect(none.body.code).toBe('owner_missing');

      const res = await ownerStep();
      const right = totpGenerate(secretOf(res.body.totpUri), new Date());
      const wrongCode = right === '000000' ? '111111' : '000000';
      const wrong = await confirm(wrongCode);
      expect(wrong.status).toBe(422);
      expect(wrong.body.code).toBe('totp_invalid');

      const wrongToken = token === 'AAAA-AAAA-AAAA' ? 'BBBB-BBBB-BBBB' : 'AAAA-AAAA-AAAA';
      expect((await confirm(right, wrongToken)).status).toBe(403);

      // Still open and still unconfirmed.
      expect(await count('setup_token')).toBe(1);
      expect((await request(server()).get('/setup/status')).status).toBe(200);
    });

    it('the first code confirms: token deleted, owner signs in, every /setup/* answers 410', async () => {
      const res = await ownerStep();
      const secret = secretOf(res.body.totpUri);
      const ok = await confirm(totpGenerate(secret, new Date()));
      expect(ok.status).toBe(200);
      expect(await count('setup_token')).toBe(0);
      const { rows } = await ta.testDb.pool.query('SELECT totp_state FROM app_user');
      expect(rows).toEqual([{ totp_state: 'confirmed' }]);

      const login = await signIn(nextCode(secret));
      expect(login.status).toBe(200);
      expect(cookieFrom(login)).not.toBeNull();

      for (const [method, path] of [
        ['get', '/setup/status'],
        ['post', '/setup/activate'],
        ['post', '/setup/owner'],
        ['post', '/setup/confirm'],
      ] as const) {
        const done = await request(server())[method](path).send({ ...owner, setupToken: token, code: 'x', totp: '1' });
        expect(done.status).toBe(410);
        expect(done.body.code).toBe('setup_done');
      }
      // A boot after setup issues no new token.
      expect(await app.get(SetupService).prepareOnBoot()).toBeNull();
    });

    it('a restart between owner step and confirmation issues a new token that finishes setup', async () => {
      const res = await ownerStep();
      const next = (await app.get(SetupService).prepareOnBoot())!;
      expect(next).toMatch(TOKEN_FORMAT);
      const code = totpGenerate(secretOf(res.body.totpUri), new Date());
      expect((await confirm(code, token)).status).toBe(403);
      expect((await confirm(code, next)).status).toBe(200);
    });
  });

  it('validates the owner input', async () => {
    expect((await activate(token)).status).toBe(200);
    const bad = await request(server())
      .post('/setup/owner')
      .send({ ...owner, setupToken: token, legalKind: 'corporation' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('validation_failed');
    const short = await request(server())
      .post('/setup/owner')
      .send({ ...owner, setupToken: token, password: 'kratka' });
    expect(short.body.code).toBe('password_too_short');
    expect(await count('property')).toBe(0);
  });
});
