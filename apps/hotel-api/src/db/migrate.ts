import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

export const DEFAULT_MIGRATIONS_DIR = join(__dirname, 'migrations');

// Serialises concurrent migrators (two API instances booting together) so
// neither tries to apply the same file twice.
export const MIGRATION_LOCK_KEY = 7_301_001;

// Applies every not-yet-recorded .sql file in name order, each file in its own
// transaction together with its schema_migrations row. A file is therefore
// either fully applied and recorded or not applied at all; a failure leaves
// earlier files in place and stops. Returns the names applied by this call.
// Migration files must not contain BEGIN/COMMIT (the migrator owns the
// transaction) nor CREATE INDEX CONCURRENTLY (illegal inside one).
export async function migrate(pool: Pool, dir: string = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           name text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const done = new Set<string>(
        (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
      );
      for (const file of files) {
        if (done.has(file)) continue;
        const text = readFileSync(join(dir, file), 'utf8');
        try {
          await client.query('BEGIN');
          await client.query(text);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
        } catch (err) {
          // A failing ROLLBACK (dead connection) must not mask the real error.
          try {
            await client.query('ROLLBACK');
          } catch {
            /* the original error is what matters */
          }
          throw err;
        }
        applied.push(file);
      }
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      } catch {
        // The session-level lock dies with the connection; never mask the original error.
      }
    }
  } finally {
    client.release();
  }
  return applied;
}
