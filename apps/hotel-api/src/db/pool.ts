import { Pool } from 'pg';

export function createPool(connectionString: string | undefined = process.env.DATABASE_URL): Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  return new Pool({ connectionString });
}
