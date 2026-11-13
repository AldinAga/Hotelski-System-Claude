import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { bootOrDegrade } from './boot';
import { DomainErrorFilter } from './common/domain-error';
import { configureHttp, HTTP_OPTIONS } from './http';
import { startServices } from './start-services';

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
    // Migrations, setup token, licence, then the background jobs (src/start-services.ts, tested).
    await startServices(app);
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
