import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';

export const DEFAULT_MIGRATIONS_DIR = join(__dirname, 'migrations');

// Serialises concurrent migrators (two API instances booting together) so
// neither tries to apply the same file twice.
export const MIGRATION_LOCK_KEY = 7_301_001;

const logger = new Logger('Migrate');

/**
 * sha256 (hex) of a migration file's text with line endings normalised to LF:
 * the repository is edited on Windows (CRLF) and built on Linux (LF), and the
 * same file must hash the same in both.
 */
export function migrationHash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex');
}

// Applies every not-yet-recorded .sql file in name order, each file in its own
// transaction together with its schema_migrations row (name and content hash). A
// file is therefore either fully applied and recorded or not applied at all; a
// failure leaves earlier files in place and stops. Returns the names applied by
// this call.
//
// A file that was applied and has been edited since is not skipped silently: the
// start stops with an error that names it (an edit of an applied migration never
// reaches a database that already ran it). Rows written before the hash existed
// (every 1a installation) get the hash of the file on disk the first time, with a
// log line naming them.
//
// Migration files must not contain BEGIN/COMMIT (the migrator owns the
// transaction) nor CREATE INDEX CONCURRENTLY (illegal inside one).
//
// The pool's statement and lock timeouts (db/pool.ts) are lifted for the
// migrator's own connection: a backfill on a real database may run for minutes.
export async function migrate(pool: Pool, dir: string = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 0');
    await client.query('SET lock_timeout = 0');
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           name text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      // Done here and not in a numbered migration: the migrator needs the column
      // before it can read what the numbered ones recorded.
      await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS content_hash text');
      const recorded = new Map<string, string | null>(
        (await client.query('SELECT name, content_hash FROM schema_migrations')).rows.map((r) => [r.name, r.content_hash]),
      );
      const texts = new Map(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

      const unhashed: string[] = [];
      for (const file of files) {
        if (!recorded.has(file)) continue;
        const hash = migrationHash(texts.get(file)!);
        const was = recorded.get(file);
        if (was == null) {
          await client.query('UPDATE schema_migrations SET content_hash = $2 WHERE name = $1 AND content_hash IS NULL', [file, hash]);
          unhashed.push(file);
        } else if (was !== hash) {
          throw new Error(
            `migration ${file} was edited after it was applied (recorded hash ${was.slice(0, 12)}, file hash ${hash.slice(0, 12)}); ` +
              'restore the file and add a new migration instead',
          );
        }
      }
      if (unhashed.length > 0) {
        logger.warn(`no content hash was recorded for ${unhashed.join(', ')}; recorded the hash of the file on disk`);
      }

      for (const file of files) {
        if (recorded.has(file)) continue;
        try {
          await client.query('BEGIN');
          await client.query(texts.get(file)!);
          await client.query('INSERT INTO schema_migrations (name, content_hash) VALUES ($1, $2)', [file, migrationHash(texts.get(file)!)]);
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
    // Back to the pool's own timeouts before the connection is reused.
    try {
      await client.query('RESET statement_timeout');
      await client.query('RESET lock_timeout');
    } catch {
      /* a dead connection is dropped by the pool anyway */
    }
    client.release();
  }
  return applied;
}
