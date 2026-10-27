import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Pool } from 'pg';
import { AppModule } from './app.module';
import { DomainErrorFilter } from './common/domain-error';
import { PG_POOL } from './db/tokens';
import { migrate } from './db/migrate';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new DomainErrorFilter());
  app.enableShutdownHooks();
  await migrate(app.get<Pool>(PG_POOL));
  await app.listen(Number(process.env.HOTEL_API_PORT ?? 4200));
}

void bootstrap();
