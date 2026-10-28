import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bootOrDegrade, redactSecrets } from './boot';

const DB_URL = 'postgres://hotel:s3cret-db-pass@hotel-postgres-claude:5432/hotel';
const SECRET_KEY = 'q7J2vN0xY4mB8kZ1tR6wE3uI9oP5aS2dF7gH0jK4lZc';
const ENV = { DATABASE_URL: DB_URL, HOTEL_SECRET_KEY: SECRET_KEY, HOTEL_API_PORT: '4200' };

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

describe('bootOrDegrade', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    server = null;
  });

  it('keeps answering 503 on /health and every other path when bootstrap rejects', async () => {
    const lines: string[] = [];
    server = await bootOrDegrade(
      () => Promise.reject(new Error(`migration failed on ${DB_URL} (password s3cret-db-pass, key ${SECRET_KEY})`)),
      { port: 0, log: (line) => lines.push(line), env: ENV },
    );

    expect(server).not.toBeNull();
    const base = `http://127.0.0.1:${portOf(server!)}`;
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ status: 'unavailable', reason: 'bootstrap_failed' });
    expect((await fetch(`${base}/reservations`)).status).toBe(503);

    const log = lines.join('\n');
    expect(log).toContain('hotel-api did not start');
    expect(log).toContain('migration failed on [redacted]');
    expect(log).not.toContain('s3cret-db-pass');
    expect(log).not.toContain(SECRET_KEY);
  });

  it('opens no port of its own when bootstrap succeeds', async () => {
    const lines: string[] = [];
    const bootstrap = jest.fn(() => Promise.resolve());
    server = await bootOrDegrade(bootstrap, { port: 0, log: (line) => lines.push(line), env: ENV });
    expect(server).toBeNull();
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([]);
  });
});

describe('redactSecrets', () => {
  it('hides secret env values, and the password of a URL on its own', () => {
    const text = `a ${DB_URL} b s3cret-db-pass c ${SECRET_KEY} d 4200`;
    expect(redactSecrets(text, ENV)).toBe('a [redacted] b [redacted] c [redacted] d 4200');
  });

  it('leaves values of non-secret variables and very short values alone', () => {
    expect(redactSecrets('port 4200, key abc', { HOTEL_API_PORT: '4200', HOTEL_SECRET_KEY: 'abc' })).toBe(
      'port 4200, key abc',
    );
  });
});
