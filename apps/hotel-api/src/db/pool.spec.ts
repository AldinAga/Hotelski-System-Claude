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

  it('refuses to start without a connection string', () => {
    expect(() => createPool('')).toThrow('DATABASE_URL is not set');
  });
});
