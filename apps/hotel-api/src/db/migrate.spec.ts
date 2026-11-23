import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { createScratchPool } from '../../test/db';
import { migrate } from './migrate';

// The expected hash is computed here, by the stated rule: sha256 of the text with line endings as LF.
const sha = (text: string) => createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex');

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

  describe('content hash', () => {
    const hashes = async () =>
      Object.fromEntries((await pool.query('SELECT name, content_hash FROM schema_migrations')).rows.map((r) => [r.name, r.content_hash]));

    it('records the hash of every applied file, and unchanged files pass again and again', async () => {
      writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
      writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b (id int);');
      await migrate(pool, dir);
      expect(await migrate(pool, dir)).toEqual([]);
      expect(await migrate(pool, dir)).toEqual([]);
      expect(await hashes()).toEqual({
        '0001_a.sql': sha('CREATE TABLE a (id int);'),
        '0002_b.sql': sha('CREATE TABLE b (id int);'),
      });
    });

    it('stops with an error naming the file when an applied file was edited', async () => {
      writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
      await migrate(pool, dir);
      writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int, extra int);');
      writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b (id int);');

      await expect(migrate(pool, dir)).rejects.toThrow(/migration 0001_a\.sql was edited after it was applied/);

      expect(await tableExists('b')).toBe(false); // nothing new ran behind the edited file
    });

    it('a file that differs only in its line endings is the same file', async () => {
      writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (\n  id int\n);\n');
      await migrate(pool, dir);
      writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (\r\n  id int\r\n);\r\n');
      expect(await migrate(pool, dir)).toEqual([]);
    });

    it('upgrades a 1a-shaped schema_migrations (no hash column) and fills the hashes, with a log line naming the files', async () => {
      writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
      writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b (id int);');
      await pool.query(`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      await pool.query(`CREATE TABLE a (id int); CREATE TABLE b (id int)`);
      await pool.query(`INSERT INTO schema_migrations (name) VALUES ('0001_a.sql'), ('0002_b.sql')`);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        expect(await migrate(pool, dir)).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('0001_a.sql, 0002_b.sql'));
      } finally {
        warn.mockRestore();
      }
      expect(await hashes()).toEqual({
        '0001_a.sql': sha('CREATE TABLE a (id int);'),
        '0002_b.sql': sha('CREATE TABLE b (id int);'),
      });
      // And from now on the hash counts.
      writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b (id int, x int);');
      await expect(migrate(pool, dir)).rejects.toThrow(/0002_b\.sql was edited/);
    });

    it('a row without a hash is filled, not refused (the file on disk is trusted once)', async () => {
      writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
      await migrate(pool, dir);
      await pool.query('UPDATE schema_migrations SET content_hash = NULL');
      expect(await migrate(pool, dir)).toEqual([]);
      expect(await hashes()).toEqual({ '0001_a.sql': sha('CREATE TABLE a (id int);') });
    });

    it('the migrator runs without the pool statement and lock timeouts, and gives them back', async () => {
      const limited = new Pool({ connectionString: pool.options.connectionString, max: 1, statement_timeout: 60_000, lock_timeout: 30_000 });
      try {
        writeFileSync(join(dir, '0001_seen.sql'), `CREATE TABLE seen AS SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt;`);
        await migrate(limited, dir);
        expect((await limited.query('SELECT st, lt FROM seen')).rows).toEqual([{ st: '0', lt: '0' }]);
        const after = await limited.query(`SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt`);
        expect(after.rows).toEqual([{ st: '1min', lt: '30s' }]);
      } finally {
        await limited.end();
      }
    });
  });

  it('applies the real foundation migration', async () => {
    const applied = await migrate(pool);
    expect(applied).toContain('0001_foundation.sql');
    for (const t of ['property', 'legal_profile', 'audit_log']) {
      expect(await tableExists(t)).toBe(true);
    }
  });
});
