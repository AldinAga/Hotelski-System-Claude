import { createPool } from './pool';

describe('createPool', () => {
  it('survives an error emitted by an idle client', async () => {
    const pool = createPool('postgres://u:p@127.0.0.1:1/none');
    try {
      // With no 'error' listener EventEmitter throws, which in production is an
      // uncaught exception that kills the process.
      expect(() => pool.emit('error', new Error('connection terminated'))).not.toThrow();
      expect(pool.listenerCount('error')).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  it('waits 10 s for a connection and cuts a statement at 60 s and a lock wait at 30 s', async () => {
    const pool = createPool('postgres://u:p@127.0.0.1:1/none');
    try {
      expect(pool.options).toMatchObject({ connectionTimeoutMillis: 10_000, statement_timeout: 60_000, lock_timeout: 30_000 });
    } finally {
      await pool.end();
    }
  });

  it('refuses to start without a connection string', () => {
    expect(() => createPool('')).toThrow('DATABASE_URL is not set');
  });
});
