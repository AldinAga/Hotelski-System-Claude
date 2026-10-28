import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SetupService } from '../src/auth/setup.service';
import { CentralAdminClient } from '../src/licensing/central-admin.client';
import { parseRootKeySet } from '../src/licensing/licensing.config';
import { SecretBox } from '../src/licensing/secret-box';
import { createTestApp, type TestApp } from './app';
import { startFakeCentralAdmin, type FakeCentralAdmin } from './fake-central-admin';

// The operator scripts of Task 13, run as the owner would run them: a child
// `node` process against real HTTP servers.

const run = promisify(execFile);
const ROOT = resolve(__dirname, '../../..');
const SMOKE = resolve(ROOT, 'scripts/smoke-1a.mjs');
const PUBLISH = resolve(ROOT, 'scripts/publish-manifest.mjs');

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function node(script: string, args: string[], env: Record<string, string> = {}): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH ?? '', ...env },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('scripts/smoke-1a.mjs (e2e)', () => {
  let fake: FakeCentralAdmin;
  let ta: TestApp;
  let api: string;

  beforeAll(async () => {
    fake = await startFakeCentralAdmin();
    ta = await createTestApp({
      licensing: {
        client: new CentralAdminClient({ baseUrl: fake.url, allowHttp: true }),
        rootKeySet: parseRootKeySet(JSON.stringify(fake.rootKeySet)),
        secretBox: new SecretBox(randomBytes(32)),
      },
    });
    await ta.app.listen(0, '127.0.0.1');
    api = `http://127.0.0.1:${(ta.app.getHttpServer().address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    await ta.reset();
  });
  afterAll(async () => {
    await ta?.app.close();
    await fake?.close();
  });

  const args = (setupToken: string, code: string) => [
    '--api',
    api,
    '--setup-token',
    setupToken,
    '--code',
    code,
    '--email',
    'smoke@hotel.test',
  ];

  it('a fresh installation: every step OK, exit 0, and the run really happened', async () => {
    const setupToken = (await ta.app.get(SetupService).prepareOnBoot())!;
    const code = fake.issueCode({ licence: { limits: { rooms: 20, users: 10 } } });
    const out = await node(SMOKE, args(setupToken, code), { HOTEL_SMOKE_PASSWORD: 'smoke-lozinka-1a' });

    expect(out.stdout).not.toMatch(/FAIL/);
    expect(out.code).toBe(0);
    const steps = out.stdout.trim().split('\n');
    expect(steps).toHaveLength(11);
    expect(steps.every((l) => l.startsWith('OK '))).toBe(true);
    // The secret never reaches the output.
    expect(out.stdout + out.stderr).not.toMatch(/otpauth|secret=/);

    const q = async (sql: string) => (await ta.testDb.pool.query(sql)).rows;
    expect(await q(`SELECT email, role, totp_state FROM app_user`)).toEqual([
      { email: 'smoke@hotel.test', role: 'owner', totp_state: 'confirmed' },
    ]);
    expect(await q(`SELECT count(*)::int AS n FROM unit`)).toEqual([{ n: 2 }]);
    expect(await q(`SELECT status FROM reservation`)).toEqual([{ status: 'cancelled' }]);
    // Cancelling gave the nights back.
    expect(await q(`SELECT coalesce(sum(sold), 0)::int AS sold FROM inventory_day`)).toEqual([{ sold: 0 }]);
  });

  it('--totp-out narrows a file that already exists to mode 600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smoke-totp-'));
    const file = join(dir, 'owner-totp.txt');
    try {
      writeFileSync(file, 'old\n', { mode: 0o644 });
      chmodSync(file, 0o644);
      expect(statSync(file).mode & 0o777).toBe(0o644);

      const setupToken = (await ta.app.get(SetupService).prepareOnBoot())!;
      const code = fake.issueCode({ licence: { limits: { rooms: 20, users: 10 } } });
      const out = await node(SMOKE, [...args(setupToken, code), '--totp-out', file], {
        HOTEL_SMOKE_PASSWORD: 'smoke-lozinka-1a',
      });

      expect(out.code).toBe(0);
      expect(readFileSync(file, 'utf8')).toMatch(/^otpauth:\/\/totp\//);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a step that fails stops the run with FAIL and exit 1', async () => {
    const setupToken = (await ta.app.get(SetupService).prepareOnBoot())!;
    const out = await node(SMOKE, args(setupToken, 'not-a-real-code'), { HOTEL_SMOKE_PASSWORD: 'smoke-lozinka-1a' });
    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(/^OK +health$/m);
    expect(out.stdout).toMatch(/^FAIL activation with the code: HTTP 4\d\d/m);
    expect(out.stdout).not.toMatch(/owner created/);
  });

  it('refuses to start without the arguments it needs', async () => {
    const out = await node(SMOKE, ['--api', api]);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/--setup-token is required/);
  });
});

describe('scripts/publish-manifest.mjs (e2e)', () => {
  let server: Server;
  let url: string;
  let received: Array<{ method: string; path: string; auth?: string; body: string }>;
  let answer: { status: number; body: unknown };
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'product/manifest.json'), 'utf8')) as { version: string };

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, body });
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => {
    received = [];
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  const TOKEN = 'pub_test_token_123456';
  const env = () => ({ CENTRAL_ADMIN_URL: url, HOTEL_PUBLISHER_TOKEN: TOKEN });

  it('POSTs product/manifest.json to /v1/products/hotel/manifests with the bearer token', async () => {
    answer = { status: 201, body: { version: '0.1.0', moduleCount: 18, limitTypeCount: 8, deprecatedModules: [], deprecatedLimitTypes: [] } };
    const out = await node(PUBLISH, [], env());
    expect(out.code).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: 'POST', path: '/v1/products/hotel/manifests', auth: `Bearer ${TOKEN}` });
    expect(JSON.parse(received[0].body)).toEqual(manifest);
    expect(out.stdout).toMatch(/Objavljen manifest hotel 0\.1\.0: 18 modula, 8 tipova limita/);
    expect(out.stdout + out.stderr).not.toContain(TOKEN);
  });

  it('prints each problem of a refused manifest and exits 1', async () => {
    answer = {
      status: 422,
      body: {
        code: 'manifest_invalid',
        message: 'Manifest nije ispravan: Modul "hotel.x" zavisi od modula "hotel.y" koji ne postoji u manifestu. Polje "expiry_modes" mora sadržati podrazumevani režim isteka proizvoda "hard_lock".',
      },
    };
    const out = await node(PUBLISH, [], env());
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/HTTP 422, manifest_invalid/);
    expect(out.stderr).toMatch(/^ {2}- Modul "hotel\.x" zavisi od modula "hotel\.y" koji ne postoji u manifestu\.$/m);
    expect(out.stderr).toMatch(/^ {2}- Polje "expiry_modes" mora sadržati .*"hard_lock"\.$/m);
  });

  it('prints a problems list when the Admin Panel sends one', async () => {
    answer = { status: 422, body: { code: 'manifest_invalid', message: 'x', problems: ['Prvi problem.', 'Drugi problem.'] } };
    const out = await node(PUBLISH, [], env());
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/^ {2}- Prvi problem\.$/m);
    expect(out.stderr).toMatch(/^ {2}- Drugi problem\.$/m);
  });

  it('an already published version is not an error', async () => {
    answer = { status: 409, body: { code: 'manifest_version_exists', message: 'već' } };
    const out = await node(PUBLISH, [], env());
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/već objavljen/);
  });

  it('a wrong token: exit 1, the token is not echoed', async () => {
    answer = { status: 401, body: { code: 'unauthorized', message: `Token ${TOKEN} nije važeći.` } };
    const out = await node(PUBLISH, [], env());
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/HTTP 401/);
    expect(out.stdout + out.stderr).not.toContain(TOKEN);
  });

  it('without a token it does not call the Admin Panel at all', async () => {
    const out = await node(PUBLISH, [], { CENTRAL_ADMIN_URL: url });
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/HOTEL_PUBLISHER_TOKEN nije postavljen/);
    expect(received).toEqual([]);
  });
});
