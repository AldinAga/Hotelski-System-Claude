import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Pool } from 'pg';
import { AppModule } from './app.module';
import { SetupService } from './auth/setup.service';
import { bootOrDegrade } from './boot';
import { DomainErrorFilter } from './common/domain-error';
import { configureHttp, HTTP_OPTIONS } from './http';
import { PG_POOL } from './db/tokens';
import { migrate } from './db/migrate';
import { LicenceService } from './licensing/licence.service';
import { NightAuditScheduler } from './business-day/night-audit.scheduler';

const port = Number(process.env.HOTEL_API_PORT ?? 4200);

async function bootstrap(): Promise<void> {
  // abortOnError: false makes Nest throw instead of calling process.exit when a
  // provider fails (for example a malformed HOTEL_ROOT_KEYSET), so the failure
  // reaches bootOrDegrade.
  // HTTP_OPTIONS turns off Nest's default body parsers; configureHttp adds the
  // request guard and the JSON parser only (src/http.ts, CSRF).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { abortOnError: false, ...HTTP_OPTIONS });
  try {
    configureHttp(app);
    app.useGlobalFilters(new DomainErrorFilter());
    app.enableShutdownHooks();
    await migrate(app.get<Pool>(PG_POOL));
    // Until the owner exists: a fresh setup token in the log at every boot.
    await app.get(SetupService).prepareOnBoot();
    // After migrations: loads the licence and starts heartbeat and key refresh.
    await app.get(LicenceService).start();
    // After the licence: the automatic night audit checks it at every tick. Stopped on shutdown (OnModuleDestroy).
    app.get(NightAuditScheduler).start();
    await app.listen(port);
  } catch (err) {
    // Stop timers and pools of the half-started app; the port stays free for
    // the 503 fallback.
    await app.close().catch(() => undefined);
    throw err;
  }
}

// A failed start keeps the process alive with /health answering 503 (boot.ts),
// so the container is Up (unhealthy) instead of crash-looping.
void bootOrDegrade(bootstrap, { port, log: (line) => console.error(line) });
