import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createScratchPool } from '../../test/db';
import { migrate } from './migrate';

describe('migrate', () => {
  let pool: Pool;
  let dir: string;

  beforeEach(async () => {
    pool = await createScratchPool(`hotel_migrate_${process.env.JEST_WORKER_ID ?? '1'}`);
    dir = mkdtempSync(join(tmpdir(), 'hotel-migrations-'));
  });

  afterEach(async () => {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  async function tableExists(name: string): Promise<boolean> {
    const r = await pool.query('SELECT to_regclass($1) AS t', [`public.${name}`]);
    return r.rows[0].t !== null;
  }

  it('applies every file once and returns [] the second time', async () => {
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
    writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b (id int);');

    expect(await migrate(pool, dir)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(await migrate(pool, dir)).toEqual([]);

    expect(await tableExists('a')).toBe(true);
    expect(await tableExists('b')).toBe(true);
    const rows = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.rows.map((r) => r.name)).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  it('leaves neither a table nor a schema_migrations row for a broken file', async () => {
    writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE ok (id int);');
    // The first statement succeeds, the second fails: the whole file must roll back.
    writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE half (id int); SELECT * FROM missing_table;');

    await expect(migrate(pool, dir)).rejects.toThrow(/missing_table/);

    expect(await tableExists('ok')).toBe(true);
    expect(await tableExists('half')).toBe(false);
    const rows = await pool.query('SELECT name FROM schema_migrations');
    expect(rows.rows.map((r) => r.name)).toEqual(['0001_ok.sql']);
  });

  it('rolls back a file whose SQL succeeds when recording it in schema_migrations fails', async () => {
    // The file creates a table and pre-inserts its own schema_migrations row, so
    // the migrator's own INSERT hits a duplicate key AFTER the file's SQL ran.
    // Only the BEGIN/COMMIT wrapper can then undo the table.
    writeFileSync(
      join(dir, '0001_conflict.sql'),
      `CREATE TABLE created_by_file (id int);
       CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO schema_migrations (name) VALUES ('0001_conflict.sql');`,
    );

    await expect(migrate(pool, dir)).rejects.toThrow(/duplicate key/);

    expect(await tableExists('created_by_file')).toBe(false);
    const rows = await pool.query('SELECT name FROM schema_migrations');
    expect(rows.rowCount).toBe(0);
  });

  it('applies a file exactly once when two migrators run in parallel', async () => {
    // A plain CREATE TABLE fails on the second application, so a missing lock
    // makes one of the calls reject.
    writeFileSync(join(dir, '0001_once.sql'), 'CREATE TABLE once (id int);');

    const results = await Promise.all([migrate(pool, dir), migrate(pool, dir)]);

    expect(results.flat()).toEqual(['0001_once.sql']);
    const rows = await pool.query('SELECT name FROM schema_migrations');
    expect(rows.rowCount).toBe(1);
  });

  it('applies the real foundation migration', async () => {
    const applied = await migrate(pool);
    expect(applied).toContain('0001_foundation.sql');
    for (const t of ['property', 'legal_profile', 'audit_log']) {
      expect(await tableExists(t)).toBe(true);
    }
  });
});
