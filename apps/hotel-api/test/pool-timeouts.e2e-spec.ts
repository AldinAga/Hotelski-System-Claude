import { NightAuditScheduler } from '../src/business-day/night-audit.scheduler';
import { isDatabaseBusy } from '../src/common/domain-error';
import { startFrontDesk, type FrontDesk } from './front-desk';

// A pool that cannot give out a connection must not hold a request (or the
// health check) for ever: src/db/pool.ts sets a connection, statement and lock
// timeout, and the global filter turns a timeout into 503 database_busy.
// The specs' pools are built from the same poolConfig, so they behave alike.

describe('database timeouts (e2e, pool of one connection)', () => {
  let fd: FrontDesk;

  beforeAll(async () => {
    fd = await startFrontDesk({ poolMax: 1 });
  });
  beforeEach(async () => {
    await fd.reset();
  });
  afterAll(() => fd.close());

  /** The answer, or a failure after `ms` when the request is still waiting (the held connection is released in finally). */
  const answered = <T>(request: PromiseLike<T>, ms = 20_000): Promise<T> =>
    Promise.race([
      Promise.resolve(request),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)),
    ]);

  it('the pool hands out connections that carry the statement and lock timeouts', async () => {
    const [row] = await fd.sql<{ st: string; lt: string }>(
      `SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt`,
    );
    expect(row).toEqual({ st: '1min', lt: '30s' });
  });

  it('a request that cannot get a connection answers 503 database_busy after the connection timeout, not never', async () => {
    const held = await fd.ta.testDb.pool.connect();
    try {
      const started = Date.now();
      const res = await answered(fd.get('/business-day'));
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        code: 'database_busy',
        message: 'Baza podataka trenutno ne odgovara. Pokušajte ponovo za nekoliko trenutaka.',
        details: null,
      });
    } finally {
      held.release();
    }
    // The pool is usable again and nothing is left waiting.
    expect((await fd.get('/business-day')).status).toBe(200);
  }, 30_000);

  it('the background jobs give up on an exhausted pool too, so their next tick can run', async () => {
    const held = await fd.ta.testDb.pool.connect();
    try {
      // `ticking` (dispatcher) and `running` (scheduler) are cleared in finally, but only once runOnce settles.
      expect(isDatabaseBusy(await answered(fd.dispatcher.runOnce().catch((e: unknown) => e)))).toBe(true);
      expect(isDatabaseBusy(await answered(fd.app.get(NightAuditScheduler).runOnce().catch((e: unknown) => e)))).toBe(true);
    } finally {
      held.release();
    }
    expect(await fd.dispatcher.runOnce()).toEqual({ sent: 0, failed: 0, retried: 0 });
    expect(['not_due', 'disabled']).toContain(await fd.app.get(NightAuditScheduler).runOnce());
  }, 40_000);

  it('/health is 503 while the pool is exhausted and 200 after, each within a few seconds', async () => {
    const held = await fd.ta.testDb.pool.connect();
    try {
      const started = Date.now();
      const res = await answered(fd.get('/health'), 8_000);
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'unavailable', reason: 'database_unreachable' });
    } finally {
      held.release();
    }
    const ok = await fd.get('/health');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'ok' });
  }, 30_000);
});
