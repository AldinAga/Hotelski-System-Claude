import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Pool } from 'pg';
import { AppModule } from './app.module';
import { SetupService } from './auth/setup.service';
import { DomainErrorFilter } from './common/domain-error';
import { PG_POOL } from './db/tokens';
import { migrate } from './db/migrate';
import { LicenceService } from './licensing/licence.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new DomainErrorFilter());
  app.enableShutdownHooks();
  await migrate(app.get<Pool>(PG_POOL));
  // Until the owner exists: a fresh setup token in the log at every boot.
  await app.get(SetupService).prepareOnBoot();
  // After migrations: loads the licence and starts heartbeat and key refresh.
  await app.get(LicenceService).start();
  await app.listen(Number(process.env.HOTEL_API_PORT ?? 4200));
}

void bootstrap();
