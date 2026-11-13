import type { INestApplication, Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { CLOCK, type Clock } from '../src/common/clock';
import { DomainErrorFilter } from '../src/common/domain-error';
import { PropertyContext } from '../src/common/property-context';
import { configureHttp, HTTP_OPTIONS } from '../src/http';
import { TURNSTILE_CONFIG, type TurnstileConfig } from '../src/auth/turnstile';
import { PG_POOL } from '../src/db/tokens';
import { LicenceService } from '../src/licensing/licence.service';
import { LICENSING_CONFIG, type LicensingConfig } from '../src/licensing/licensing.config';
import { MAIL_FROM, MAIL_TRANSPORT, NoopMailTransport, type MailTransport } from '../src/mail/mail-transport';
import { createTestDb, TestDb } from './db';

/** The From header of test mail. */
export const TEST_MAIL_FROM = 'Demo Hotel <hotel@example.test>';

export interface TestAppOptions {
  /** Extra controllers (test-only routes). */
  controllers?: Type[];
  /** Replaces the licensing configuration read from the environment. */
  licensing?: LicensingConfig;
  /** Replaces the authentication clock. */
  clock?: Clock;
  /** Environment for the HTTP hardening (HOTEL_WEB_ORIGIN, src/http.ts); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /**
   * Replaces the Turnstile configuration read from the environment: null is
   * "off", a config is "on" (its verifyUrl points at test/fake-turnstile.ts).
   * The object is read at every login, so a spec may change it between tests.
   */
  turnstile?: TurnstileConfig | null;
  /** The test pool's client limit (default pg's 10); see createTestDb. */
  poolMax?: number;
  /** Replaces the mail transport; default is the Noop transport (the environment's SMTP settings are never read in tests). */
  mail?: MailTransport;
}

export interface TestApp {
  app: INestApplication;
  testDb: TestDb;
  /**
   * Empties the database and forgets what the app cached from it (the
   * property id, the held licence), so the next test starts from a fresh
   * installation on the same app.
   */
  reset(): Promise<void>;
}

// Boots the application on the worker's test database, wired like main.ts
// (same HTTP hardening and global filter). The app runs on testDb's pool: closing the app ends it.
export async function createTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const testDb = await createTestDb({ poolMax: opts.poolMax });
  let builder = Test.createTestingModule({
    imports: [AppModule, DiscoveryModule],
    controllers: opts.controllers ?? [],
  })
    .overrideProvider(PG_POOL)
    .useValue(testDb.pool);
  builder = builder.overrideProvider(MAIL_TRANSPORT).useValue(opts.mail ?? new NoopMailTransport());
  builder = builder.overrideProvider(MAIL_FROM).useValue(TEST_MAIL_FROM);
  if (opts.licensing) builder = builder.overrideProvider(LICENSING_CONFIG).useValue(opts.licensing);
  if (opts.clock) builder = builder.overrideProvider(CLOCK).useValue(opts.clock);
  if (opts.turnstile !== undefined) builder = builder.overrideProvider(TURNSTILE_CONFIG).useValue(opts.turnstile);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>(HTTP_OPTIONS);
  configureHttp(app, opts.env ?? process.env);
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
  return {
    app,
    testDb,
    async reset() {
      await testDb.truncate();
      app.get(PropertyContext).reset();
      await app.get(LicenceService).reload();
    },
  };
}
