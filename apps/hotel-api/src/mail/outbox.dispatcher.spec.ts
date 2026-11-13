import { NoopMailTransport } from './mail-transport';
import { OutboxDispatcher, TICK_MS, type DispatchResult } from './outbox.dispatcher';

// The timer around runOnce: every 15 seconds, never two runs side by side,
// stops on stop(), and does not keep the process alive.

const NONE: DispatchResult = { sent: 0, failed: 0, retried: 0 };

describe('OutboxDispatcher timer', () => {
  let d: OutboxDispatcher;

  beforeEach(() => {
    jest.useFakeTimers();
    d = new OutboxDispatcher(null as never, () => new Date(), new NoopMailTransport(), '');
  });
  afterEach(() => {
    d.stop();
    jest.useRealTimers();
  });

  it('runs every 15 seconds; starting twice does not double it', async () => {
    const run = jest.spyOn(d, 'runOnce').mockResolvedValue(NONE);
    d.start();
    d.start();
    await jest.advanceTimersByTimeAsync(TICK_MS - 1);
    expect(run).toHaveBeenCalledTimes(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(TICK_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not start a run while the previous one is still going', async () => {
    let finish!: (r: DispatchResult) => void;
    const run = jest.spyOn(d, 'runOnce').mockImplementation(() => new Promise<DispatchResult>((r) => (finish = r)));
    d.start();
    await jest.advanceTimersByTimeAsync(TICK_MS * 3);
    expect(run).toHaveBeenCalledTimes(1);
    finish(NONE);
    await jest.advanceTimersByTimeAsync(TICK_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps ticking after a failed run', async () => {
    const run = jest.spyOn(d, 'runOnce').mockRejectedValue(new Error('database is gone'));
    const logged = jest.spyOn(d['log'], 'error').mockImplementation(() => undefined);
    d.start();
    await jest.advanceTimersByTimeAsync(TICK_MS * 2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledTimes(2);
    expect(logged.mock.calls[0][0]).toBe('outbox run failed: Error');
  });

  it('stop() ends the timer, and a stopped dispatcher can start again', async () => {
    const run = jest.spyOn(d, 'runOnce').mockResolvedValue(NONE);
    d.start();
    await jest.advanceTimersByTimeAsync(TICK_MS);
    d.stop();
    await jest.advanceTimersByTimeAsync(TICK_MS * 3);
    expect(run).toHaveBeenCalledTimes(1);
    d.start();
    await jest.advanceTimersByTimeAsync(TICK_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('onModuleDestroy stops the timer', async () => {
    const run = jest.spyOn(d, 'runOnce').mockResolvedValue(NONE);
    d.start();
    d.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(TICK_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });

  it('the timer does not keep the process alive (unref)', () => {
    jest.spyOn(d, 'runOnce').mockResolvedValue(NONE);
    d.start();
    const timer = d['timer'] as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
  });
});
