import { randomBytes } from 'node:crypto';
import { Controller, Get, Post, type INestApplication, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/domain-error';
import { PG_POOL } from '../src/db/tokens';
import { ActivationService } from '../src/licensing/activation.service';
import { CentralAdminClient } from '../src/licensing/central-admin.client';
import { LicenceService } from '../src/licensing/licence.service';
import { LicensedAction } from '../src/licensing/licensed-action';
import { LICENSING_CONFIG, parseRootKeySet, type LicensingConfig } from '../src/licensing/licensing.config';
import { SecretBox } from '../src/licensing/secret-box';
import { createTestDb, type TestDb } from './db';
import { startFakeCentralAdmin, type FakeCentralAdmin } from './fake-central-admin';
import { discoverRoutes, expressRouteCount } from './routes';

const DAY_MS = 86_400_000;

// Test-only stand-in for the reservation routes, which do not exist yet in 1a.
@Controller('test-reservations')
class TestReservationsController {
  @Get()
  @LicensedAction('hotel.core', 'reservation.view')
  list(): { ok: true } {
    return { ok: true };
  }

  @Post()
  @LicensedAction('hotel.core', 'reservation.create')
  create(): { created: true } {
    return { created: true };
  }
}

// Positive control for the scan: a controller someone forgot to annotate.
@Controller('forgotten')
class ForgottenController {
  @Get()
  find(): string {
    return 'x';
  }
}

// Each app gets its own pool on the worker's test database: closing the app
// ends its pool (DatabaseModule), which must not end the spec's own.
async function boot(config: LicensingConfig, controllers: Type[] = []): Promise<INestApplication> {
  const appDb = await createTestDb();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, DiscoveryModule],
    controllers,
  })
    .overrideProvider(PG_POOL)
    .useValue(appDb.pool)
    .overrideProvider(LICENSING_CONFIG)
    .useValue(config)
    .compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
  return app;
}

describe('licensed routes (e2e)', () => {
  let t: TestDb;
  let fake: FakeCentralAdmin;
  let clock: Date;
  let config: LicensingConfig;

  beforeAll(async () => {
    t = await createTestDb();
    fake = await startFakeCentralAdmin();
  });
  beforeEach(async () => {
    await t.truncate();
    clock = new Date();
    config = {
      client: new CentralAdminClient({ baseUrl: fake.url, allowHttp: true }),
      rootKeySet: parseRootKeySet(JSON.stringify(fake.rootKeySet)),
      secretBox: new SecretBox(randomBytes(32)),
      now: () => clock,
    };
  });
  afterAll(async () => {
    await fake.close();
    await t.close();
  });

  describe('every route is annotated', () => {
    it('the application: every route has @LicensedAction or @Unlicensed', async () => {
      const app = await boot(config);
      try {
        const routes = discoverRoutes(app);
        expect(routes.filter((r) => !r.annotated).map((r) => r.route)).toEqual([]);
        // Not vacuous: /health and /licence at least, and discovery saw every
        // route Express serves.
        expect(routes.length).toBeGreaterThanOrEqual(2);
        expect(routes.map((r) => r.route)).toEqual(
          expect.arrayContaining([expect.stringMatching(/^GET \/health /), expect.stringMatching(/^GET \/licence /)]),
        );
        expect(routes).toHaveLength(expressRouteCount(app));
      } finally {
        await app.close();
      }
    });

    it('positive control: a controller without an annotation is reported', async () => {
      const app = await boot(config, [ForgottenController]);
      try {
        const offenders = discoverRoutes(app).filter((r) => !r.annotated).map((r) => r.route);
        expect(offenders).toEqual(['GET /forgotten (ForgottenController.find)']);
        // And the guard refuses it at runtime as well.
        const res = await request(app.getHttpServer()).get('/forgotten');
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('route_not_classified');
      } finally {
        await app.close();
      }
    });
  });

  describe('the global guard', () => {
    let app: INestApplication;
    beforeEach(async () => {
      app = await boot(config, [TestReservationsController]);
    });
    afterEach(async () => {
      await app.close();
    });

    async function activateSafeMode(): Promise<void> {
      await app.get(ActivationService).activate(fake.issueCode({ licence: { expiry_mode: 'safe_mode' } }));
      await app.get(LicenceService).reload();
    }

    it('not activated: licensed routes 403 not_activated; /health and /licence answer', async () => {
      await app.get(LicenceService).reload();
      const server = app.getHttpServer();
      const res = await request(server).get('/test-reservations');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_activated');
      expect((await request(server).get('/health')).status).toBe(200);
      const licence = await request(server).get('/licence');
      expect(licence.status).toBe(200);
      expect(licence.body).toMatchObject({ activated: false, state: 'NOT_ACTIVATED' });
    });

    it('VALID: reservation.view and reservation.create pass', async () => {
      await activateSafeMode();
      const server = app.getHttpServer();
      expect((await request(server).get('/test-reservations')).status).toBe(200);
      expect((await request(server).post('/test-reservations')).status).toBe(201);
    });

    it('reservation.create in safe mode: 403 safe_mode_blocked; reservation.view still works', async () => {
      await activateSafeMode();
      clock = new Date(clock.getTime() + 40 * DAY_MS); // past grace_until (issue + 37 days)
      const server = app.getHttpServer();

      const create = await request(server).post('/test-reservations');
      expect(create.status).toBe(403);
      expect(create.body).toMatchObject({ code: 'safe_mode_blocked' });

      expect((await request(server).get('/test-reservations')).status).toBe(200);
      expect((await request(server).get('/licence')).body).toMatchObject({ state: 'EXPIRED' });
    });

    it('GET /licence returns the snapshot without signature or keys', async () => {
      await activateSafeMode();
      const res = await request(app.getHttpServer()).get('/licence');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(app.get(LicenceService).snapshot());
      expect(Object.keys(res.body).sort()).toEqual(['activated', 'graceUntil', 'limits', 'modules', 'state', 'validUntil']);
      const text = JSON.stringify(res.body);
      for (const secret of ['signature', 'public_key', 'key_id', 'installation_id', 'k2']) {
        expect(text).not.toContain(secret);
      }
    });
  });
});
