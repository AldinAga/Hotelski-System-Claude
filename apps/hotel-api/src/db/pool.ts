import { Logger } from '@nestjs/common';
import { Pool, type PoolConfig } from 'pg';

const logger = new Logger('Pool');

/** A request waits at most this long for a free pooled connection (or for a new one to open). */
export const CONNECTION_TIMEOUT_MS = 10_000;
/**
 * One statement may run at most this long. The longest legitimate statement of
 * the running application is a few rows of a night audit; nothing runs for
 * seconds. The migrator lifts it for its own connection (db/migrate.ts).
 */
export const STATEMENT_TIMEOUT_MS = 60_000;
/** A statement waits at most this long for a lock held by another transaction. */
export const LOCK_TIMEOUT_MS = 30_000;

/** The pool settings of the application and of the specs' pools, so both time out the same way. */
export function poolConfig(connectionString: string, extra: PoolConfig = {}): PoolConfig {
  return {
    connectionString,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    lock_timeout: LOCK_TIMEOUT_MS,
    ...extra,
  };
}

export function createPool(connectionString: string | undefined = process.env.DATABASE_URL): Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const pool = new Pool(poolConfig(connectionString));
  // pg emits 'error' when an idle client's connection drops (database restart,
  // network blip). Without a listener Node treats it as uncaught and the
  // process dies; the pool discards the dead client itself.
  pool.on('error', (err) => logger.error(`idle database client failed: ${err.message}`));
  return pool;
}
