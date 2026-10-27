import { randomBytes } from 'node:crypto';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { totpGenerate } from '../src/auth/totp';
import { ActivationService } from '../src/licensing/activation.service';
import { CentralAdminClient } from '../src/licensing/central-admin.client';
import { LicenceService } from '../src/licensing/licence.service';
import { LicensedAction } from '../src/licensing/licensed-action';
import { parseRootKeySet } from '../src/licensing/licensing.config';
import { SecretBox } from '../src/licensing/secret-box';
import { createTestApp, type TestApp } from './app';
import { cookieFrom, seedUser, sessionCookieFor, setCookieLine, type SeededUser } from './auth-helpers';
import { startFakeCentralAdmin, type FakeCentralAdmin } from './fake-central-admin';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

// A licensed route outside user management, for the guard order check.
@Controller('test-licensed')
class TestLicensedController {
  @Get()
  @LicensedAction('hotel.core', 'reservation.view')
  ok(): { ok: true } {
    return { ok: true };
  }
}

describe('authentication (e2e)', () => {
  let fake: FakeCentralAdmin;
  let ta: TestApp;
  let app: INestApplication;
  let clock: Date;

  beforeAll(async () => {
    fake = await startFakeCentralAdmin();
    ta = await createTestApp({
      controllers: [TestLicensedController],
      clock: () => clock,
      licensing: {
        client: new CentralAdminClient({ baseUrl: fake.url, allowHttp: true }),
        rootKeySet: parseRootKeySet(JSON.stringify(fake.rootKeySet)),
        secretBox: new SecretBox(randomBytes(32)),
      },
    });
    app = ta.app;
  });
  beforeEach(async () => {
    clock = new Date();
    await ta.reset();
  });
  afterAll(async () => {
    await app.close();
    await fake.close();
  });

  const server = () => app.getHttpServer();

  async function activate(users: number | null = 10): Promise<void> {
    await app.get(ActivationService).activate(fake.issueCode({ licence: { limits: { rooms: 20, users } } }));
    await app.get(LicenceService).reload();
  }

  function login(u: SeededUser, totp?: string) {
    return request(server()).post('/auth/login').send({ email: u.email, password: u.password, totp });
  }

  const codeNow = (u: SeededUser): string => totpGenerate(u.totpSecret!, clock);

  describe('login', () => {
    it('manager without TOTP: 401 totp_required; with TOTP: 200 and the cookie', async () => {
      const manager = await seedUser(ta.testDb, 'manager');

      const without = await login(manager);
      expect(without.status).toBe(401);
      expect(without.body.code).toBe('totp_required');
      expect(cookieFrom(without)).toBeNull();

      const wrong = await login(manager, '000000' === codeNow(manager) ? '111111' : '000000');
      expect(wrong.status).toBe(401);
      expect(wrong.body.code).toBe('totp_required');

      const ok = await login(manager, codeNow(manager));
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ id: manager.id, email: manager.email, name: 'Ime manager', role: 'manager' });
      const line = setCookieLine(ok)!;
      expect(line).toMatch(/^hotel_session=[A-Za-z0-9_-]{43};/);
      expect(line).toMatch(/; HttpOnly/);
      expect(line).toMatch(/; SameSite=Strict/);
      expect(line).not.toMatch(/; Secure/); // plain http here

      const me = await request(server()).get('/auth/me').set('Cookie', cookieFrom(ok)!);
      expect(me.status).toBe(200);
      expect(me.body).toEqual({ id: manager.id, email: manager.email, name: 'Ime manager', role: 'manager' });
    });

    it('Secure is set when the request came over https', async () => {
      // Express decides req.secure from the socket; behind "trust proxy" from
      // X-Forwarded-Proto. The test app trusts nothing, so mark the request.
      const expressApp = app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void };
      expressApp.set('trust proxy', true);
      try {
        const rec = await seedUser(ta.testDb, 'receptionist');
        const res = await request(server())
          .post('/auth/login')
          .set('X-Forwarded-Proto', 'https')
          .send({ email: rec.email, password: rec.password });
        expect(res.status).toBe(200);
        expect(setCookieLine(res)).toMatch(/; Secure/);
      } finally {
        expressApp.set('trust proxy', false);
      }
    });

    it('the same TOTP code a second time: 401', async () => {
      const manager = await seedUser(ta.testDb, 'manager');
      const code = codeNow(manager);
      expect((await login(manager, code)).status).toBe(200);

      const again = await login(manager, code);
      expect(again.status).toBe(401);
      expect(again.body.code).toBe('totp_required');

      // The next step's code works: the refusal was the replay, not the user.
      clock = new Date(clock.getTime() + 30_000);
      expect((await login(manager, codeNow(manager))).status).toBe(200);
    });

    it('the same TOTP code twice at once: exactly one session', async () => {
      const manager = await seedUser(ta.testDb, 'manager');
      const code = codeNow(manager);
      const results = await Promise.all([login(manager, code), login(manager, code)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
      const { rows } = await ta.testDb.pool.query('SELECT 1 FROM user_session WHERE user_id = $1', [manager.id]);
      expect(rows).toHaveLength(1);
    });

    it('receptionist signs in without TOTP; wrong password or unknown email: 401 invalid_credentials', async () => {
      const rec = await seedUser(ta.testDb, 'receptionist');
      expect((await login(rec)).status).toBe(200);

      const wrong = await login({ ...rec, password: 'pogresna-lozinka' });
      expect(wrong.status).toBe(401);
      expect(wrong.body.code).toBe('invalid_credentials');

      const unknown = await login({ ...rec, email: 'niko@hotel.test' });
      expect(unknown.status).toBe(401);
      expect(unknown.body.code).toBe('invalid_credentials');
    });

    it('an inactive user cannot sign in', async () => {
      const rec = await seedUser(ta.testDb, 'receptionist', { active: false });
      const res = await login(rec);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
    });

    it('the sixth attempt in 15 min: 429, even with the right password; other emails unaffected', async () => {
      const rec = await seedUser(ta.testDb, 'receptionist');
      const other = await seedUser(ta.testDb, 'receptionist');
      for (let i = 0; i < 5; i++) {
        const res = await login({ ...rec, password: `pogresna-${i}-lozinka` });
        expect(res.status).toBe(401);
      }
      const sixth = await login(rec);
      expect(sixth.status).toBe(429);
      expect(sixth.body.code).toBe('too_many_attempts');
      // Case and spacing do not open a new bucket.
      const shouted = await request(server())
        .post('/auth/login')
        .send({ email: `  ${rec.email.toUpperCase()} `, password: rec.password });
      expect(shouted.status).toBe(429);

      expect((await login(other)).status).toBe(200);

      // The window is 15 minutes, counted in the database.
      clock = new Date(clock.getTime() + 15 * MINUTE_MS + 1000);
      expect((await login(rec)).status).toBe(200);
    });

    it('five failures then a success: the success clears that email only', async () => {
      const rec = await seedUser(ta.testDb, 'receptionist');
      const other = await seedUser(ta.testDb, 'receptionist');
      for (let i = 0; i < 4; i++) await login({ ...other, password: `pogresna-${i}-lozinka` });
      for (let i = 0; i < 4; i++) await login({ ...rec, password: `pogresna-${i}-lozinka` });
      expect((await login(rec)).status).toBe(200);
      // rec starts over; other still has four failures, so its fifth counts and the sixth is refused.
      await login({ ...other, password: 'pogresna-x-lozinka' });
      expect((await login(other)).status).toBe(429);
    });

    it('records login and logout in the audit log, without secrets', async () => {
      const manager = await seedUser(ta.testDb, 'manager');
      const ok = await login(manager, codeNow(manager));
      await request(server()).post('/auth/logout').set('Cookie', cookieFrom(ok)!).expect(204);
      const { rows } = await ta.testDb.pool.query(
        `SELECT action, actor_user_id, after FROM audit_log WHERE entity = 'user' ORDER BY id`,
      );
      expect(rows.map((r) => r.action)).toEqual(['user.login', 'user.logout']);
      expect(rows.every((r) => r.actor_user_id === manager.id)).toBe(true);
      const text = JSON.stringify(rows);
      expect(text).not.toContain(manager.totpSecret!);
      expect(text).not.toContain('scrypt$');
    });
  });

  describe('sessions', () => {
    it('a route without a session: 401', async () => {
      for (const path of ['/auth/me', '/licence']) {
        const res = await request(server()).get(path);
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('session_required');
      }
      const create = await request(server()).post('/users').send({});
      expect(create.status).toBe(401);
      expect(create.body.code).toBe('session_required');
      const garbage = await request(server()).get('/auth/me').set('Cookie', 'hotel_session=nope');
      expect(garbage.status).toBe(401);
      // /health stays public.
      expect((await request(server()).get('/health')).status).toBe(200);
    });

    it('12 h without activity: 401; activity inside 12 h keeps the session alive', async () => {
      const rec = await seedUser(ta.testDb, 'receptionist');
      const cookie = cookieFrom(await login(rec))!;
      const me = () => request(server()).get('/auth/me').set('Cookie', cookie);

      clock = new Date(clock.getTime() + 11 * HOUR_MS);
      expect((await me()).status).toBe(200);
      clock = new Date(clock.getTime() + 11 * HOUR_MS); // 22 h after login, 11 h idle
      expect((await me()).status).toBe(200);

      clock = new Date(clock.getTime() + 12 * HOUR_MS + 1000);
      const expired = await me();
      expect(expired.status).toBe(401);
      expect(expired.body.code).toBe('session_required');
    });

    it('7 days after login: 401 even when used all along', async () => {
      const rec = await seedUser(ta.testDb, 'receptionist');
      const cookie = cookieFrom(await login(rec))!;
      const me = () => request(server()).get('/auth/me').set('Cookie', cookie);
      const start = clock.getTime();
      for (let h = 10; h < 7 * 24; h += 10) {
        clock = new Date(start + h * HOUR_MS);
        expect((await me()).status).toBe(200);
      }
      clock = new Date(start + 7 * 24 * HOUR_MS + 1000);
      expect((await me()).status).toBe(401);
    });

    it('logout ends the session and clears the cookie', async () => {
      const rec = await seedUser(ta.testDb, 'receptionist');
      const cookie = cookieFrom(await login(rec))!;
      const out = await request(server()).post('/auth/logout').set('Cookie', cookie);
      expect(out.status).toBe(204);
      expect(setCookieLine(out)).toMatch(/^hotel_session=;/);
      expect((await request(server()).get('/auth/me').set('Cookie', cookie)).status).toBe(401);
    });

    it('guard order: no session on a licensed route of an unactivated installation is 401, not 403', async () => {
      // Not activated, so LicenceGuard alone would answer 403 not_activated.
      const res = await request(server()).get('/test-licensed');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('session_required');

      // Positive control: signed in, the licence check is what refuses.
      const rec = await seedUser(ta.testDb, 'receptionist');
      const signedIn = await request(server())
        .get('/test-licensed')
        .set('Cookie', await sessionCookieFor(app, rec.id));
      expect(signedIn.status).toBe(403);
      expect(signedIn.body.code).toBe('not_activated');
    });
  });

  describe('users', () => {
    const newUser = (role: string, email = `novi-${Math.random().toString(36).slice(2, 8)}@hotel.test`) => ({
      email,
      name: 'Novi',
      role,
      password: 'nova-lozinka-123',
    });

    it('receptionist cannot create users: 403', async () => {
      await activate();
      const rec = await seedUser(ta.testDb, 'receptionist');
      const res = await request(server())
        .post('/users')
        .set('Cookie', await sessionCookieFor(app, rec.id))
        .send(newUser('housekeeping'));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden_role');
      const { rows } = await ta.testDb.pool.query(`SELECT 1 FROM app_user WHERE role = 'housekeeping'`);
      expect(rows).toHaveLength(0);
    });

    it('manager creates a receptionist who can sign in; the audit row has no secrets', async () => {
      await activate();
      const manager = await seedUser(ta.testDb, 'manager');
      const body = newUser('receptionist');
      const res = await request(server())
        .post('/users')
        .set('Cookie', await sessionCookieFor(app, manager.id))
        .send(body);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ email: body.email, name: 'Novi', role: 'receptionist', active: true });
      expect(res.body.totpUri).toBeUndefined();
      expect(res.body.passwordHash).toBeUndefined();

      const signIn = await request(server()).post('/auth/login').send({ email: body.email, password: body.password });
      expect(signIn.status).toBe(200);

      const { rows } = await ta.testDb.pool.query(`SELECT actor_user_id, after FROM audit_log WHERE action = 'user.create'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_user_id).toBe(manager.id);
      expect(JSON.stringify(rows[0].after)).not.toMatch(/scrypt|password|totp_secret|totpSecret/);
    });

    it('a new manager gets a TOTP enrolment URI and needs the code to sign in', async () => {
      await activate();
      const owner = await seedUser(ta.testDb, 'owner');
      const body = newUser('manager');
      const res = await request(server())
        .post('/users')
        .set('Cookie', await sessionCookieFor(app, owner.id))
        .send(body);
      expect(res.status).toBe(201);
      const uri = new URL(res.body.totpUri);
      const secret = uri.searchParams.get('secret')!;
      expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe(`/Hotel:${body.email}`);

      const without = await request(server()).post('/auth/login').send({ email: body.email, password: body.password });
      expect(without.body.code).toBe('totp_required');
      const withCode = await request(server())
        .post('/auth/login')
        .send({ email: body.email, password: body.password, totp: totpGenerate(secret, clock) });
      expect(withCode.status).toBe(200);
    });

    it('a manager cannot create an owner or change an owner', async () => {
      await activate();
      const owner = await seedUser(ta.testDb, 'owner');
      const manager = await seedUser(ta.testDb, 'manager');
      const cookie = await sessionCookieFor(app, manager.id);

      const create = await request(server()).post('/users').set('Cookie', cookie).send(newUser('owner'));
      expect(create.status).toBe(403);
      expect(create.body.code).toBe('role_not_allowed');

      const demote = await request(server()).patch(`/users/${owner.id}`).set('Cookie', cookie).send({ active: false });
      expect(demote.status).toBe(403);
      expect(demote.body.code).toBe('role_not_allowed');
    });

    it('nobody changes their own account through /users', async () => {
      await activate();
      const owner = await seedUser(ta.testDb, 'owner');
      const res = await request(server())
        .patch(`/users/${owner.id}`)
        .set('Cookie', await sessionCookieFor(app, owner.id))
        .send({ role: 'receptionist' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('cannot_modify_self');
    });

    it('the users limit counts active users on create and on reactivation', async () => {
      await activate(2);
      const owner = await seedUser(ta.testDb, 'owner');
      const cookie = await sessionCookieFor(app, owner.id);

      const second = await request(server()).post('/users').set('Cookie', cookie).send(newUser('receptionist'));
      expect(second.status).toBe(201);
      const third = await request(server()).post('/users').set('Cookie', cookie).send(newUser('receptionist'));
      expect(third.status).toBe(403);
      expect(third.body).toMatchObject({ code: 'limit_exceeded', details: { key: 'users', limit: 2, wanted: 3 } });

      // Deactivating frees a place; reactivating while it is taken is refused.
      const off = await request(server()).patch(`/users/${second.body.id}`).set('Cookie', cookie).send({ active: false });
      expect(off.status).toBe(200);
      expect(off.body.active).toBe(false);
      const replacement = await request(server()).post('/users').set('Cookie', cookie).send(newUser('housekeeping'));
      expect(replacement.status).toBe(201);
      const back = await request(server()).patch(`/users/${second.body.id}`).set('Cookie', cookie).send({ active: true });
      expect(back.status).toBe(403);
      expect(back.body.code).toBe('limit_exceeded');
    });

    it('deactivating a user ends their sessions; role changes apply at once', async () => {
      await activate();
      const owner = await seedUser(ta.testDb, 'owner');
      const rec = await seedUser(ta.testDb, 'receptionist');
      const ownerCookie = await sessionCookieFor(app, owner.id);
      const recCookie = await sessionCookieFor(app, rec.id);

      const promote = await request(server())
        .patch(`/users/${rec.id}`)
        .set('Cookie', ownerCookie)
        .send({ role: 'manager' });
      expect(promote.status).toBe(200);
      expect(promote.body.role).toBe('manager');
      expect(promote.body.totpUri).toMatch(/^otpauth:\/\/totp\/Hotel:/);
      expect((await request(server()).get('/auth/me').set('Cookie', recCookie)).body.role).toBe('manager');

      await request(server()).patch(`/users/${rec.id}`).set('Cookie', ownerCookie).send({ active: false }).expect(200);
      expect((await request(server()).get('/auth/me').set('Cookie', recCookie)).status).toBe(401);

      const { rows } = await ta.testDb.pool.query(`SELECT action FROM audit_log WHERE action = 'user.update'`);
      expect(rows).toHaveLength(2);
    });

    it('validates input: 422 validation_failed, 422 password_too_short, 409 email_taken, 404 user_not_found', async () => {
      await activate();
      const owner = await seedUser(ta.testDb, 'owner');
      const cookie = await sessionCookieFor(app, owner.id);
      const post = (body: unknown) => request(server()).post('/users').set('Cookie', cookie).send(body as object);

      expect((await post({ ...newUser('receptionist'), role: 'admin' })).body.code).toBe('validation_failed');
      expect((await post({ ...newUser('receptionist'), email: 'bez-et' })).body.code).toBe('validation_failed');
      expect((await post({ ...newUser('receptionist'), password: 'kratka' })).body.code).toBe('password_too_short');
      expect((await post(newUser('receptionist', owner.email.toUpperCase()))).body.code).toBe('email_taken');

      const missing = await request(server())
        .patch('/users/00000000-0000-0000-0000-000000000000')
        .set('Cookie', cookie)
        .send({ active: false });
      expect(missing.status).toBe(404);
      const notUuid = await request(server()).patch('/users/abc').set('Cookie', cookie).send({ active: false });
      expect(notUuid.status).toBe(404);
    });
  });
});
