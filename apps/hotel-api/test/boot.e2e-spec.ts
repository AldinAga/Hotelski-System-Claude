import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

// Runs the built dist/main.js (ci.sh builds before it tests) with a broken
// configuration and checks that the process stays alive answering 503 instead
// of exiting, which under `restart: unless-stopped` would be a crash loop.
const MAIN = resolve(__dirname, '../dist/main.js');

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function waitForStatus(url: string, child: ChildProcess, timeoutMs: number): Promise<number> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`hotel-api exited (code ${child.exitCode}, signal ${child.signalCode})`);
    }
    try {
      return (await fetch(url)).status;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`no answer from ${url} within ${timeoutMs} ms`);
}

describe('hotel-api with a broken configuration', () => {
  let child: ChildProcess | null = null;
  let output = '';

  beforeAll(() => {
    if (!existsSync(MAIN)) throw new Error(`${MAIN} is missing; build hotel-api first`);
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((done) => child!.once('exit', done));
      child.kill('SIGKILL');
      await exited;
    }
    child = null;
    output = '';
  });

  async function start(env: Record<string, string | undefined>): Promise<string> {
    const port = await freePort();
    child = spawn(process.execPath, [MAIN], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, CENTRAL_ADMIN_URL: undefined, ...env, HOTEL_API_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (b: Buffer) => (output += b.toString()));
    child.stderr!.on('data', (b: Buffer) => (output += b.toString()));
    return `http://127.0.0.1:${port}`;
  }

  async function expectDegraded(base: string, secret: string): Promise<void> {
    expect(await waitForStatus(`${base}/health`, child!, 45_000)).toBe(503);
    expect((await fetch(`${base}/setup/status`)).status).toBe(503);
    await sleep(1_000);
    expect(child!.exitCode).toBeNull();
    expect(child!.signalCode).toBeNull();
    expect(output).toContain('hotel-api did not start');
    expect(output).not.toContain(secret);
  }

  it('stays up with /health 503 when HOTEL_ROOT_KEYSET is malformed', async () => {
    const keyset = 'bm90LWEta2V5c2V0LWF0LWFsbA';
    // A well-formed DATABASE_URL (never reached: the key set fails first), so
    // the only fault is the key set, whatever the runner's environment holds.
    const base = await start({ HOTEL_ROOT_KEYSET: keyset, DATABASE_URL: 'postgres://hotel:x@127.0.0.1:1/hotel' });
    await expectDegraded(base, keyset);
    expect(output).toContain('HOTEL_ROOT_KEYSET is not a valid key set');
  }, 60_000);

  it('stays up with /health 503 when the database is unreachable', async () => {
    const pass = 'unreachable-db-s3cret';
    const base = await start({ DATABASE_URL: `postgres://hotel:${pass}@127.0.0.1:1/hotel`, HOTEL_ROOT_KEYSET: undefined });
    await expectDegraded(base, pass);
  }, 60_000);
});
