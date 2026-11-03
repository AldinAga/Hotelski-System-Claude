import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { TurnstileConfig } from '../src/auth/turnstile';
import { createTestApp, type TestApp } from './app';
import { cookieFrom, seedUser } from './auth-helpers';
import { FAKE_SECRET, PASS_TOKEN, startFakeTurnstile, type FakeTurnstile } from './fake-turnstile';

const SITE_KEY = 'site-key-0x4AAAAAAA-test';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Cloudflare Turnstile on POST /auth/login (src/auth/turnstile.ts). Off unless
// both keys are configured; when on, the token is checked with siteverify
// before the email is counted or the password looked at, and every doubt
// about siteverify fails closed.
describe('Turnstile on sign-in (e2e)', () => {
  let fake: FakeTurnstile;

  beforeAll(async () => {
    fake = await startFakeTurnstile();
  });
  afterAll(async () => {
    await fake.close();
  });
  beforeEach(() => fake.reset());

  async function attempts(ta: TestApp): Promise<number> {
    const { rows } = await ta.testDb.pool.query<{ n: string }>('SELECT count(*) AS n FROM login_attempt');
    return Number(rows[0].n);
  }

  describe('switched off (no keys)', () => {
    let ta: TestApp;
    let app: INestApplication;
    beforeAll(async () => {
      ta = await createTestApp({ turnstile: null });
      app = ta.app;
    });
    beforeEach(() => ta.reset());
    afterAll(() => app.close());

    it('GET /auth/config: no site key, without a session', async () => {
      const res = await request(app.getHttpServer()).get('/auth/config');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ turnstileSiteKey: null });
    });

    it('login works without a token and siteverify is never called', async () => {
      const rec = await seedUser(ta.testDb, 'receptionist');
      const res = await request(app.getHttpServer()).post('/auth/login').send({ email: rec.email, password: rec.password });
      expect(res.status).toBe(200);
      expect(cookieFrom(res)).not.toBeNull();
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe('switched on', () => {
    let ta: TestApp;
    let app: INestApplication;
    const config: TurnstileConfig = {
      siteKey: SITE_KEY,
      secretKey: FAKE_SECRET,
      verifyUrl: '',
      timeoutMs: 400,
      hostnames: null,
    };

    beforeAll(async () => {
      config.verifyUrl = fake.url;
      ta = await createTestApp({ turnstile: config });
      app = ta.app;
    });
    beforeEach(async () => {
      config.hostnames = null;
      await ta.reset();
    });
    afterAll(() => app.close());

    const login = (body: Record<string, unknown>) => request(app.getHttpServer()).post('/auth/login').send(body);

    it('GET /auth/config: exactly the site key, never the secret', async () => {
      const res = await request(app.getHttpServer()).get('/auth/config');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ turnstileSiteKey: SITE_KEY });
      expect(res.text).not.toContain(FAKE_SECRET);
    });

    it('no token: 403 captcha_failed; siteverify not called, attempt not counted, right password not enough', async () => {
      const rec = await seedUser(ta.testDb, 'receptionist');
      const res = await login({ email: rec.email, password: rec.password });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('captcha_failed');
      expect(cookieFrom(res)).toBeNull();
      expect(fake.requests).toHaveLength(0);
      expect(await attempts(ta)).toBe(0);
    });

    it.each([
      ['a number', 12345],
      ['an empty string', ''],
      ['a token over 2048 characters', 'x'.repeat(2049)],
    ])('a token that is %s: 403 captcha_failed without calling siteverify', async (_label, token) => {
      const rec = await seedUser(ta.testDb, 'receptionist');
      const res = await login({ email: rec.email, password: rec.password, turnstileToken: token });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('captcha_failed');
      expect(fake.requests).toHaveLength(0);
    });

    it('a passing token: the normal sign-in, and siteverify got secret, token, remote ip and an idempotency key', async () => {
      const rec = await seedUser(ta.testDb, 'receptionist');
      const res = await login({ email: rec.email, password: rec.password, turnstileToken: PASS_TOKEN });
      expect(res.status).toBe(200);
      expect(res.body.email).toBe(rec.email);
      expect(cookieFrom(res)).not.toBeNull();

      expect(fake.requests).toHaveLength(1);
      const sent = fake.requests[0];
      expect(sent.contentType).toMatch(/^application\/json/);
      expect(sent.body.secret).toBe(FAKE_SECRET);
      expect(sent.body.response).toBe(PASS_TOKEN);
      expect(sent.body.remoteip).toMatch(/127\.0\.0\.1|::1/);
      expect(sent.body.idempotency_key).toMatch(UUID);
    });

    it('a passing token and a wrong password: the normal 401, and that attempt is counted', async () => {
      const rec = await seedUser(ta.testDb, 'receptionist');
      const res = await login({ email: rec.email, password: 'pogresna-lozinka-1', turnstileToken: PASS_TOKEN });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
      expect(await attempts(ta)).toBe(1);
    });

    it('a token siteverify rejects: 403 captcha_failed, attempt not counted', async () => {
      const rec = await seedUser(ta.testDb, 'receptionist');
      const res = await login({ email: rec.email, password: rec.password, turnstileToken: 'forged-token' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('captcha_failed');
      expect(fake.requests).toHaveLength(1);
      expect(await attempts(ta)).toBe(0);
    });

    it('failed captchas cannot lock an account: ten of them, then the owner of the email signs in', async () => {
      const rec = await seedUser(ta.testDb, 'receptionist');
      for (let i = 0; i < 10; i++) {
        const res = await login({ email: rec.email, password: rec.password, turnstileToken: `forged-${i}` });
        expect(res.status).toBe(403);
      }
      const ok = await login({ email: rec.email, password: rec.password, turnstileToken: PASS_TOKEN });
      expect(ok.status).toBe(200);
    });

    it('an unknown email and a known one get the same captcha answer', async () => {
      const rec = await seedUser(ta.testDb, 'receptionist');
      const known = await login({ email: rec.email, password: 'x', turnstileToken: 'forged' });
      const unknown = await login({ email: 'nema-ga@hotel.test', password: 'x', turnstileToken: 'forged' });
      expect(known.status).toBe(403);
      expect(unknown.status).toBe(403);
      expect(unknown.body).toEqual(known.body);
    });

    it('a token issued for another action: 403 captcha_failed', async () => {
      fake.setAnswer({ action: 'register' });
      const rec = await seedUser(ta.testDb, 'receptionist');
      const res = await login({ email: rec.email, password: rec.password, turnstileToken: PASS_TOKEN });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('captcha_failed');
    });

    it('an empty action (Cloudflare test keys) is accepted', async () => {
      fake.setAnswer({ action: '' });
      const rec = await seedUser(ta.testDb, 'receptionist');
      const res = await login({ email: rec.email, password: rec.password, turnstileToken: PASS_TOKEN });
      expect(res.status).toBe(200);
    });

    it('with TURNSTILE_HOSTNAMES set: a token solved on another hostname is 403, a listed one passes', async () => {
      config.hostnames = ['recepcija.hotel.rs'];
      const rec = await seedUser(ta.testDb, 'receptionist');

      fake.setAnswer({ hostname: 'evil.example' });
      const foreign = await login({ email: rec.email, password: rec.password, turnstileToken: PASS_TOKEN });
      expect(foreign.status).toBe(403);
      expect(foreign.body.code).toBe('captcha_failed');

      fake.setAnswer({ hostname: 'recepcija.hotel.rs' });
      const listed = await login({ email: rec.email, password: rec.password, turnstileToken: PASS_TOKEN });
      expect(listed.status).toBe(200);
    });

    it.each([
      ['answers 500', 'status-500' as const],
      ['answers something that is not JSON', 'not-json' as const],
      ['does not answer in time', 'hang' as const],
    ])('siteverify %s: 503 captcha_unavailable (fails closed), attempt not counted', async (_label, mode) => {
      fake.setMode(mode);
      const rec = await seedUser(ta.testDb, 'receptionist');
      const started = Date.now();
      const res = await login({ email: rec.email, password: rec.password, turnstileToken: PASS_TOKEN });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('captcha_unavailable');
      expect(cookieFrom(res)).toBeNull();
      expect(Date.now() - started).toBeLessThan(5000);
      expect(await attempts(ta)).toBe(0);
    });

    it('siteverify unreachable (connection refused): 503 captcha_unavailable', async () => {
      const saved = config.verifyUrl;
      config.verifyUrl = 'http://127.0.0.1:1/turnstile/v0/siteverify';
      try {
        const rec = await seedUser(ta.testDb, 'receptionist');
        const res = await login({ email: rec.email, password: rec.password, turnstileToken: PASS_TOKEN });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('captcha_unavailable');
      } finally {
        config.verifyUrl = saved;
      }
    });

    it('neither the secret nor the token reaches the log', async () => {
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) =>
        jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
      );
      try {
        fake.setMode('status-500');
        const rec = await seedUser(ta.testDb, 'receptionist');
        await login({ email: rec.email, password: rec.password, turnstileToken: PASS_TOKEN });
        fake.setMode('normal');
        await login({ email: rec.email, password: rec.password, turnstileToken: 'forged-token' });
        const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
        // Not vacuous: the 503 is logged (with its reason).
        expect(logged).toContain('siteverify');
        expect(logged).not.toContain(FAKE_SECRET);
        expect(logged).not.toContain(PASS_TOKEN);
        expect(logged).not.toContain('forged-token');
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });
  });
});
