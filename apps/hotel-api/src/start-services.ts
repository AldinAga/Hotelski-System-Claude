import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SetupService } from './auth/setup.service';
import { NightAuditScheduler } from './business-day/night-audit.scheduler';
import { migrate } from './db/migrate';
import { PG_POOL } from './db/tokens';
import { LicenceService } from './licensing/licence.service';
import { OutboxDispatcher } from './mail/outbox.dispatcher';

/**
 * What main.ts does with a built app before it listens, in this order: migrations,
 * the setup token, the licence, then the two background jobs. The jobs read the
 * schema and the licence at every tick, so they start last. They stop on shutdown
 * (OnModuleDestroy). Lives here, not in main.ts, because main.ts starts the
 * process when it is imported and so cannot be tested.
 */
export async function startServices(app: Pick<INestApplication, 'get'>): Promise<void> {
  await migrate(app.get<Pool>(PG_POOL));
  // Until the owner exists: a fresh setup token in the log at every boot.
  await app.get(SetupService).prepareOnBoot();
  // After migrations: loads the licence and starts heartbeat and key refresh.
  await app.get(LicenceService).start();
  // After the licence: the automatic night audit checks it at every tick.
  app.get(NightAuditScheduler).start();
  // The e-mail dispatcher: sends what bookIn and cancel queued.
  app.get(OutboxDispatcher).start();
}
