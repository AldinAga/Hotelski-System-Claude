import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Pool } from 'pg';
import { AppModule } from './app.module';
import { SetupService } from './auth/setup.service';
import { bootOrDegrade } from './boot';
import { DomainErrorFilter } from './common/domain-error';
import { PG_POOL } from './db/tokens';
import { migrate } from './db/migrate';
import { LicenceService } from './licensing/licence.service';

const port = Number(process.env.HOTEL_API_PORT ?? 4200);

async function bootstrap(): Promise<void> {
  // abortOnError: false makes Nest throw instead of calling process.exit when a
  // provider fails (for example a malformed HOTEL_ROOT_KEYSET), so the failure
  // reaches bootOrDegrade.
  const app = await NestFactory.create(AppModule, { abortOnError: false });
  try {
    app.useGlobalFilters(new DomainErrorFilter());
    app.enableShutdownHooks();
    await migrate(app.get<Pool>(PG_POOL));
    // Until the owner exists: a fresh setup token in the log at every boot.
    await app.get(SetupService).prepareOnBoot();
    // After migrations: loads the licence and starts heartbeat and key refresh.
    await app.get(LicenceService).start();
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
