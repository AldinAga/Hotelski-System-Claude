import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { DomainErrorFilter } from '../src/common/domain-error';
import { PG_POOL } from '../src/db/tokens';
import { createTestDb, TestDb } from './db';

// Boots the application on the worker's test database, wired like main.ts
// (same global filter). Later tasks build their e2e specs on this.
export async function createTestApp(): Promise<{ app: INestApplication; testDb: TestDb }> {
  const testDb = await createTestDb();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL)
    .useValue(testDb.pool)
    .compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
  return { app, testDb };
}
