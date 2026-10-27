import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate';
import * as schema from '../src/db/schema';

export interface TestDb {
  pool: Pool;
  db: NodePgDatabase<typeof schema>;
  truncate(): Promise<void>;
  close(): Promise<void>;
}

function urlFor(database: string): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set');
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe database name: ${name}`);
  return `"${name}"`;
}

// Creates the database when it is missing and, with `fresh`, drops it first.
export async function ensureDatabase(name: string, fresh = false): Promise<void> {
  const admin = new Pool({ connectionString: urlFor('postgres') });
  try {
    if (fresh) {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    }
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);
    }
  } finally {
    await admin.end();
  }
}

// A pool on a throw-away database; used by specs that need an empty database
// of their own (the migrator spec).
export async function createScratchPool(name: string): Promise<Pool> {
  await ensureDatabase(name, true);
  return new Pool({ connectionString: urlFor(name) });
}

// One database per Jest worker, created and migrated once per worker process.
export async function createTestDb(): Promise<TestDb> {
  const name = `hotel_test_${process.env.JEST_WORKER_ID ?? '1'}`;
  await ensureDatabase(name);
  const pool = new Pool({ connectionString: urlFor(name) });
  await migrate(pool);
  const db = drizzle(pool, { schema });
  return {
    pool,
    db,
    async truncate() {
      const { rows } = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
      );
      if (rows.length === 0) return;
      const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
      await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    },
    close: () => pool.end(),
  };
}
