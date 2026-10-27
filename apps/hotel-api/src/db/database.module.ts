import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { AuditService } from '../common/audit.service';
import { PropertyContext } from '../common/property-context';
import { createPool } from './pool';
import * as schema from './schema';
import { DB, type Db, PG_POOL } from './tokens';

// The pool connects lazily, so importing this module never needs a live database.
@Global()
@Module({
  providers: [
    { provide: PG_POOL, useFactory: (): Pool => createPool() },
    { provide: DB, inject: [PG_POOL], useFactory: (pool: Pool): Db => drizzle(pool, { schema }) },
    AuditService,
    PropertyContext,
  ],
  exports: [PG_POOL, DB, AuditService, PropertyContext],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    if (!this.pool.ended) await this.pool.end();
  }
}
