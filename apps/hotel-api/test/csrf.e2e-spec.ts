import { randomBytes } from 'node:crypto';
import { Body, Controller, Get, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Public } from '../src/auth/auth.guard';
import { ActivationService } from '../src/licensing/activation.service';
import { CentralAdminClient } from '../src/licensing/central-admin.client';
import { LicenceService } from '../src/licensing/licence.service';
import { Unlicensed } from '../src/licensing/licensed-action';
import { parseRootKeySet } from '../src/licensing/licensing.config';
import { SecretBox } from '../src/licensing/secret-box';
import { createTestApp, type TestApp } from './app';
import { seedUser, sessionCookieFor, setCookieLine } from './auth-helpers';
import { startFakeCentralAdmin, type FakeCentralAdmin } from './fake-central-admin';

// Final review, Important 1: a page on another port of the same host is the
// "same site", so SameSite=Strict still sends hotel_session with its form.
// The API therefore takes JSON bodies only and refuses unsafe requests whose
// Origin (or Sec-Fetch-Site) shows another origin (src/http.ts).

// Echoes what the body parser made of the body. GET, so the origin and
// content-type checks (unsafe methods only) never see it: what it shows is
// the parser alone.
@Controller('test-echo')
@Public()
@Unlicensed()
class EchoController {
  @Get()
  echo(@Body() body: unknown): { body: unknown } {
    return { body: body ?? null };
  }
}

const FRONT_DESK = '192.168.1.199:4201';

describe('cross-site request forgery (e2e)', () => {
  let fake: FakeCentralAdmin;
  let ta: TestApp;
  let app: INestApplication;

  beforeAll(async () => {
    fake = await startFakeCentralAdmin();
    ta = await createTestApp({
      controllers: [EchoController],
      env: {},
      licensing: {
        client: new CentralAdminClient({ baseUrl: fake.url, allowHttp: true }),
        rootKeySet: parseRootKeySet(JSON.stringify(fake.rootKeySet)),
        secretBox: new SecretBox(randomBytes(32)),
      },
    });
    app = ta.app;
  });
  beforeEach(async () => {
    await ta.reset();
  });
  afterAll(async () => {
    await app.close();
    await fake.close();
  });

  const server = () => app.getHttpServer();

  async function ownerCookie(): Promise<string> {
    await app.get(ActivationService).activate(fake.issueCode({ licence: { limits: { rooms: 20, users: 10 } } }));
    await app.get(LicenceService).reload();
    const owner = await seedUser(ta.testDb, 'owner');
    return sessionCookieFor(app, owner.id);
  }

  async function receptionists(): Promise<number> {
    const { rows } = await ta.testDb.pool.query(`SELECT count(*)::int AS n FROM app_user WHERE role = 'receptionist'`);
    return rows[0].n as number;
  }

  const newUser = { email: 'napadac@hotel.test', name: 'Napadač', role: 'receptionist', password: 'napadac-lozinka-1' };
  const form = 'email=napadac%40hotel.test&name=Napada%C4%8D&role=receptionist&password=napadac-lozinka-1';

  describe('JSON bodies only', () => {
    it('control: the same request as JSON, from the front desk origin, creates the user', async () => {
      const cookie = await ownerCookie();
      const res = await request(server())
        .post('/users')
        .set('Cookie', cookie)
        .set('X-Forwarded-Host', FRONT_DESK)
        .set('Origin', `http://${FRONT_DESK}`)
        .send(newUser);
      expect(res.status).toBe(201);
      expect(await receptionists()).toBe(1);
    });

    it('a form-encoded POST /users as the owner is 415 and creates no user', async () => {
      const cookie = await ownerCookie();
      const res = await request(server())
        .post('/users')
        .set('Cookie', cookie)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(form);
      expect(res.status).toBe(415);
      expect(res.body.code).toBe('unsupported_media_type');
      expect(await receptionists()).toBe(0);
    });

    it('text/plain (the other body an HTML form can send) is 415 too', async () => {
      const cookie = await ownerCookie();
      const res = await request(server())
        .post('/users')
        .set('Cookie', cookie)
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify(newUser));
      expect(res.status).toBe(415);
      expect(await receptionists()).toBe(0);
    });

    it('the parser reads JSON and nothing else (bodyParser: false, JSON parser only)', async () => {
      const json = await request(server()).get('/test-echo').set('Content-Type', 'application/json').send('{"role":"owner"}');
      expect(json.status).toBe(200);
      expect(json.body.body).toEqual({ role: 'owner' });

      const urlencoded = await request(server())
        .get('/test-echo')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('role=owner');
      expect(urlencoded.status).toBe(200);
      expect(urlencoded.body.body).not.toEqual({ role: 'owner' });
    });

    it('an unsafe request without a body (sign out) still works', async () => {
      const cookie = await ownerCookie();
      const res = await request(server())
        .post('/auth/logout')
        .set('Cookie', cookie)
        .set('X-Forwarded-Host', FRONT_DESK)
        .set('Origin', `http://${FRONT_DESK}`);
      expect(res.status).toBe(204);
    });
  });

  describe('origin of unsafe requests', () => {
    it('a JSON POST /users from another port of the same host is 403 origin_refused and creates no user', async () => {
      const cookie = await ownerCookie();
      const res = await request(server())
        .post('/users')
        .set('Cookie', cookie)
        .set('X-Forwarded-Host', FRONT_DESK)
        .set('Origin', 'http://192.168.1.199:3100')
        .send(newUser);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('origin_refused');
      expect(await receptionists()).toBe(0);
    });

    it('straight to the API port, an Origin other than the API host is refused', async () => {
      const cookie = await ownerCookie();
      const res = await request(server())
        .post('/users')
        .set('Cookie', cookie)
        .set('Origin', 'http://evil.example')
        .send(newUser);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('origin_refused');
      expect(await receptionists()).toBe(0);
    });

    it('through the Next rewrite the front desk origin passes: wrong credentials are the normal 401', async () => {
      const res = await request(server())
        .post('/auth/login')
        .set('X-Forwarded-Host', FRONT_DESK)
        .set('Origin', `http://${FRONT_DESK}`)
        .send({ email: 'nema@hotel.test', password: 'pogresna-lozinka' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
    });

    it('Origin "null" (sandboxed page, data: URL) is refused', async () => {
      const res = await request(server()).post('/auth/login').set('Origin', 'null').send({ email: 'a@b.rs', password: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('origin_refused');
    });

    it('without Origin, Sec-Fetch-Site same-site or cross-site is refused; same-origin passes', async () => {
      for (const site of ['same-site', 'cross-site']) {
        const res = await request(server())
          .post('/auth/login')
          .set('Sec-Fetch-Site', site)
          .send({ email: 'a@b.rs', password: 'x' });
        expect([site, res.status, res.body.code]).toEqual([site, 403, 'origin_refused']);
      }
      const ok = await request(server())
        .post('/auth/login')
        .set('Sec-Fetch-Site', 'same-origin')
        .send({ email: 'nema@hotel.test', password: 'pogresna-lozinka' });
      expect(ok.status).toBe(401);
    });

    it('a client with neither Origin nor Sec-Fetch-Site (scripts, smoke) passes', async () => {
      const res = await request(server()).post('/auth/login').send({ email: 'nema@hotel.test', password: 'pogresna-lozinka' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
    });

    it('GET is not checked: reading from any origin is not a forgery', async () => {
      const res = await request(server()).get('/health').set('Origin', 'http://evil.example');
      expect(res.status).toBe(200);
    });
  });

  describe('HOTEL_WEB_ORIGIN', () => {
    let pinned: TestApp;
    beforeAll(async () => {
      pinned = await createTestApp({ env: { HOTEL_WEB_ORIGIN: 'https://recepcija.hotel.rs, http://192.168.1.199:4201' } });
    });
    afterAll(async () => {
      await pinned.app.close();
    });

    it('only the listed origins pass, even when the Origin matches the addressed host', async () => {
      const listed = await request(pinned.app.getHttpServer())
        .post('/auth/login')
        .set('Origin', 'https://recepcija.hotel.rs')
        .send({ email: 'nema@hotel.test', password: 'pogresna-lozinka' });
      expect(listed.status).toBe(401);

      const sameHostNotListed = await request(pinned.app.getHttpServer())
        .post('/auth/login')
        .set('X-Forwarded-Host', 'drugi.hotel.rs')
        .set('Origin', 'https://drugi.hotel.rs')
        .send({ email: 'nema@hotel.test', password: 'pogresna-lozinka' });
      expect(sameHostNotListed.status).toBe(403);
      expect(sameHostNotListed.body.code).toBe('origin_refused');
    });
  });

  describe('Secure session cookie behind an HTTPS proxy', () => {
    it('X-Forwarded-Proto: https from the proxy marks the cookie Secure; plain HTTP does not', async () => {
      const rec = await seedUser(ta.testDb, 'receptionist');
      const https = await request(server())
        .post('/auth/login')
        .set('X-Forwarded-Proto', 'https')
        .send({ email: rec.email, password: rec.password });
      expect(https.status).toBe(200);
      expect(setCookieLine(https)).toMatch(/;\s*Secure/i);

      const http = await request(server()).post('/auth/login').send({ email: rec.email, password: rec.password });
      expect(http.status).toBe(200);
      expect(setCookieLine(http)).toBeDefined();
      expect(setCookieLine(http)).not.toMatch(/;\s*Secure/i);
    });
  });
});
