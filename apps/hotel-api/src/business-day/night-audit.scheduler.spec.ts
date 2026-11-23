import { NightAuditScheduler, type AutoCloseResult } from './night-audit.scheduler';

// The timer around runOnce: every minute, stops on stop() and on shutdown, and a
// run that fails (a database timeout, for one) does not freeze the next tick.

const TICK = 60_000;

describe('NightAuditScheduler timer', () => {
  let s: NightAuditScheduler;

  beforeEach(() => {
    jest.useFakeTimers();
    s = new NightAuditScheduler(null as never, () => new Date(), null as never, null as never, null as never, null as never);
  });
  afterEach(() => {
    s.stop();
    jest.useRealTimers();
  });

  it('runs every minute; starting twice does not double it', async () => {
    const run = jest.spyOn(s, 'runOnce').mockResolvedValue('not_due' as AutoCloseResult);
    s.start();
    s.start();
    await jest.advanceTimersByTimeAsync(TICK - 1);
    expect(run).toHaveBeenCalledTimes(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(TICK);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps ticking after a run that failed with a database timeout', async () => {
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const run = jest.spyOn(s, 'runOnce').mockRejectedValueOnce(timeout).mockResolvedValue('closed');
    const logged = jest.spyOn(s['log'], 'error').mockImplementation(() => undefined);
    s.start();
    await jest.advanceTimersByTimeAsync(TICK * 2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('stop() and onModuleDestroy() end the timer', async () => {
    const run = jest.spyOn(s, 'runOnce').mockResolvedValue('not_due');
    s.start();
    await jest.advanceTimersByTimeAsync(TICK);
    s.stop();
    await jest.advanceTimersByTimeAsync(TICK * 3);
    expect(run).toHaveBeenCalledTimes(1);
    s.start();
    s.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(TICK * 3);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
