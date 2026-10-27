import { Logger } from '@nestjs/common';
import { Pool } from 'pg';

const logger = new Logger('Pool');

export function createPool(connectionString: string | undefined = process.env.DATABASE_URL): Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const pool = new Pool({ connectionString });
  // pg emits 'error' when an idle client's connection drops (database restart,
  // network blip). Without a listener Node treats it as uncaught and the
  // process dies; the pool discards the dead client itself.
  pool.on('error', (err) => logger.error(`idle database client failed: ${err.message}`));
  return pool;
}
