import type { INestApplication, Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { CLOCK, type Clock } from '../src/common/clock';
import { DomainErrorFilter } from '../src/common/domain-error';
import { PropertyContext } from '../src/common/property-context';
import { PG_POOL } from '../src/db/tokens';
import { LicenceService } from '../src/licensing/licence.service';
import { LICENSING_CONFIG, type LicensingConfig } from '../src/licensing/licensing.config';
import { createTestDb, TestDb } from './db';

export interface TestAppOptions {
  /** Extra controllers (test-only routes). */
  controllers?: Type[];
  /** Replaces the licensing configuration read from the environment. */
  licensing?: LicensingConfig;
  /** Replaces the authentication clock. */
  clock?: Clock;
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
// (same global filter). The app runs on testDb's pool: closing the app ends it.
export async function createTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const testDb = await createTestDb();
  let builder = Test.createTestingModule({
    imports: [AppModule, DiscoveryModule],
    controllers: opts.controllers ?? [],
  })
    .overrideProvider(PG_POOL)
    .useValue(testDb.pool);
  if (opts.licensing) builder = builder.overrideProvider(LICENSING_CONFIG).useValue(opts.licensing);
  if (opts.clock) builder = builder.overrideProvider(CLOCK).useValue(opts.clock);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
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
