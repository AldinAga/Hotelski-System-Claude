import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SetupService } from '../src/auth/setup.service';
import { totpGenerate } from '../src/auth/totp';
import { CentralAdminClient } from '../src/licensing/central-admin.client';
import { parseRootKeySet } from '../src/licensing/licensing.config';
import { SecretBox } from '../src/licensing/secret-box';
import { createTestApp, type TestApp } from './app';
import { PASSWORD, seedUser, type SeededUser } from './auth-helpers';
import { startFakeCentralAdmin, type FakeCentralAdmin } from './fake-central-admin';
import { DAY_MS, NOW, startFrontDesk, type FrontDesk } from './front-desk';

// The operator scripts of Task 13, run as the owner would run them: a child
// `node` process against real HTTP servers.

const run = promisify(execFile);
const ROOT = resolve(__dirname, '../../..');
const SMOKE = resolve(ROOT, 'scripts/smoke-1a.mjs');
const PUBLISH = resolve(ROOT, 'scripts/publish-manifest.mjs');
const SMOKE_1B = resolve(ROOT, 'scripts/smoke-1b.mjs');

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

  const PROPERTY = 'Vila Jasen';
  const args = (setupToken: string, code: string, property = PROPERTY) => [
    '--api',
    api,
    '--setup-token',
    setupToken,
    '--code',
    code,
    '--email',
    'smoke@hotel.test',
    '--property-name',
    property,
  ];
  const PASSWORD_ENV = { HOTEL_SMOKE_PASSWORD: 'smoke-lozinka-1a' };
  const q = async (sql: string) => (await ta.testDb.pool.query(sql)).rows;
  // The fake lives for the whole describe: count this test's activations only.
  const allActivations = () => fake.requests.filter((r) => r.path === '/v1/installations/activate').length;
  let activationsBefore = 0;
  beforeEach(() => {
    activationsBefore = allActivations();
  });
  const activations = () => allActivations() - activationsBefore;
  const lines = (out: Outcome) => out.stdout.trim().split('\n');
  const ALL_STEPS = [
    'health',
    'setup status',
    'activation with the code',
    'owner created (TOTP from totpUri)',
    'TOTP confirmed, setup closed',
    'owner signs in with password and TOTP',
    'unit type SMOKE with 2 units',
    'rate plan SMOKE priced for 30 days',
  ];

  it('a fresh installation: every step OK, exit 0, and the run really happened', async () => {
    const setupToken = (await ta.app.get(SetupService).prepareOnBoot())!;
    const code = fake.issueCode({ licence: { limits: { rooms: 20, users: 10 } } });
    const out = await node(SMOKE, args(setupToken, code), PASSWORD_ENV);

    expect(out.stdout).not.toMatch(/FAIL/);
    expect(out.code).toBe(0);
    const steps = lines(out);
    expect(steps).toHaveLength(12);
    expect(steps.every((l) => l.startsWith('OK '))).toBe(true);
    expect(steps.slice(0, ALL_STEPS.length).map((l) => l.replace(/^OK +/, ''))).toEqual(ALL_STEPS);
    // The secret never reaches the output.
    expect(out.stdout + out.stderr).not.toMatch(/otpauth|secret=/);

    expect(await q(`SELECT email, role, totp_state FROM app_user`)).toEqual([
      { email: 'smoke@hotel.test', role: 'owner', totp_state: 'confirmed' },
    ]);
    // The real name given on the command line, never a made-up default.
    expect(await q(`SELECT name FROM property`)).toEqual([{ name: PROPERTY }]);
    expect(await q(`SELECT count(*)::int AS n FROM unit`)).toEqual([{ n: 2 }]);
    expect(await q(`SELECT status FROM reservation`)).toEqual([{ status: 'cancelled' }]);
    // Cancelling gave the nights back.
    expect(await q(`SELECT coalesce(sum(sold), 0)::int AS sold FROM inventory_day`)).toEqual([{ sold: 0 }]);
  });

  it('resumes after a failure past activation: activation is skipped (the code is single-use), the rest runs', async () => {
    const setupToken = (await ta.app.get(SetupService).prepareOnBoot())!;
    const code = fake.issueCode({ licence: { limits: { rooms: 20, users: 10 } } });
    // The owner step fails: a property name longer than the API accepts.
    const first = await node(SMOKE, args(setupToken, code, 'x'.repeat(201)), PASSWORD_ENV);
    expect(first.code).toBe(1);
    expect(first.stdout).toMatch(/^OK +activation with the code$/m);
    expect(first.stdout).toMatch(/^FAIL owner created \(TOTP from totpUri\): HTTP 422/m);
    expect(activations()).toBe(1);

    // Same command again (the code is spent): activation is skipped, not refused.
    const again = await node(SMOKE, args(setupToken, code), PASSWORD_ENV);
    expect(again.stdout).not.toMatch(/FAIL/);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/^SKIP activation with the code: already activated$/m);
    expect(again.stdout).toMatch(/^OK +smoke 1a passed$/m);
    expect(activations()).toBe(1);
    expect(await q(`SELECT name FROM property`)).toEqual([{ name: PROPERTY }]);
  });

  it('after setup is done it signs in with the TOTP file instead of creating the owner, and reuses its data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smoke-resume-'));
    const file = join(dir, 'owner-totp.txt');
    try {
      const setupToken = (await ta.app.get(SetupService).prepareOnBoot())!;
      const code = fake.issueCode({ licence: { limits: { rooms: 20, users: 10 } } });
      expect((await node(SMOKE, [...args(setupToken, code), '--totp-out', file], PASSWORD_ENV)).code).toBe(0);
      // Later, in another 30 s step: the codes of the first run are behind.
      await ta.testDb.pool.query(`UPDATE app_user SET totp_last_step = totp_last_step - 10`);

      const out = await node(
        SMOKE,
        ['--api', api, '--email', 'smoke@hotel.test', '--property-name', PROPERTY, '--totp-file', file],
        PASSWORD_ENV,
      );
      expect(out.stdout).not.toMatch(/FAIL/);
      expect(out.code).toBe(0);
      const steps = lines(out);
      expect(steps.slice(0, ALL_STEPS.length)).toEqual([
        'OK   health',
        'OK   setup status',
        'SKIP activation with the code: setup is done',
        'SKIP owner created (TOTP from totpUri): setup is done',
        'SKIP TOTP confirmed, setup closed: setup is done',
        'OK   owner signs in with password and TOTP',
        'OK   unit type SMOKE with 2 units',
        'OK   rate plan SMOKE priced for 30 days',
      ]);
      expect(out.stdout + out.stderr).not.toMatch(/otpauth|secret=/);
      // Nothing duplicated; one more (cancelled) reservation.
      expect(await q(`SELECT count(*)::int AS n FROM app_user`)).toEqual([{ n: 1 }]);
      expect(await q(`SELECT count(*)::int AS n FROM unit_type`)).toEqual([{ n: 1 }]);
      expect(await q(`SELECT count(*)::int AS n FROM unit`)).toEqual([{ n: 2 }]);
      expect(await q(`SELECT count(*)::int AS n FROM rate_plan`)).toEqual([{ n: 1 }]);
      expect(await q(`SELECT status FROM reservation`)).toEqual([{ status: 'cancelled' }, { status: 'cancelled' }]);
      expect(activations()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('after setup is done, without --totp or --totp-file it stops before signing in', async () => {
    const setupToken = (await ta.app.get(SetupService).prepareOnBoot())!;
    const code = fake.issueCode({ licence: { limits: { rooms: 20, users: 10 } } });
    expect((await node(SMOKE, args(setupToken, code), PASSWORD_ENV)).code).toBe(0);
    const out = await node(SMOKE, ['--api', api, '--email', 'smoke@hotel.test', '--property-name', PROPERTY], PASSWORD_ENV);
    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(/^FAIL owner signs in with password and TOTP: setup is done; give --totp <code> or --totp-file <file>/m);
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
    const out = await node(SMOKE, args(setupToken, 'not-a-real-code'), PASSWORD_ENV);
    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(/^OK +health$/m);
    expect(out.stdout).toMatch(/^FAIL activation with the code: HTTP 4\d\d/m);
    expect(out.stdout).not.toMatch(/owner created/);
  });

  it('refuses to start without the arguments it needs; there is no default owner or property', async () => {
    const noEmail = await node(SMOKE, ['--api', api, '--property-name', PROPERTY], PASSWORD_ENV);
    expect(noEmail.code).toBe(1);
    expect(noEmail.stderr).toMatch(/--email is required/);
    const noProperty = await node(SMOKE, ['--api', api, '--email', 'smoke@hotel.test'], PASSWORD_ENV);
    expect(noProperty.code).toBe(1);
    expect(noProperty.stderr).toMatch(/--property-name is required/);
    // Setup still open: the token is needed.
    const noToken = await node(SMOKE, ['--api', api, '--email', 'smoke@hotel.test', '--property-name', PROPERTY], PASSWORD_ENV);
    expect(noToken.code).toBe(1);
    expect(noToken.stdout).toMatch(/^FAIL setup status: setup is open; --setup-token is required/m);
    expect(activations()).toBe(0);
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

// Task 14: the resumable phase 1b smoke. The API runs on a movable fake clock
// (startFrontDesk), the script in a child process on real time: so the script
// takes every date from GET /business-day, and the tests pass --totp computed
// on the fake clock (--totp-file computes on real time; that path is the
// smoke-1a one and is tested there).
describe('scripts/smoke-1b.mjs (e2e)', () => {
  const LONG = 120_000;
  let fd: FrontDesk;
  let api: string;
  let owner: SeededUser;
  let clock = NOW;

  const seedOwner = async () => {
    owner = await seedUser(fd.ta.testDb, 'owner', { email: 'vlasnik@hotel.test' });
  };
  const setClock = (at: Date) => {
    clock = at;
    fd.setNow(at);
  };
  /** A bigger move (sessions idle out after 12 h): the front-desk cookies are issued again. */
  const jump = async (at: Date) => {
    clock = at;
    await fd.travel(at);
  };
  /** Runs the smoke 60 s after the previous run (a TOTP code is single-use per 30 s step). */
  const smoke = (extra: string[] = [], o: { totp?: boolean } = {}) => {
    setClock(new Date(clock.getTime() + 60_000));
    const totp = o.totp === false ? [] : ['--totp', totpGenerate(owner.totpSecret!, clock)];
    return node(SMOKE_1B, ['--api', api, '--email', owner.email, ...totp, ...extra], { HOTEL_SMOKE_PASSWORD: PASSWORD });
  };
  const lines = (out: Outcome) => out.stdout.trim().split('\n');
  const q = <T = Record<string, unknown>>(text: string) => fd.sql<T>(text);
  const smokeReservations = () =>
    q(`SELECT s.status AS stay FROM stay s JOIN reservation r ON r.id = s.reservation_id
        JOIN guest g ON g.id = r.holder_guest_id WHERE g.last_name = 'Test 1b' ORDER BY s.arrival, r.number`);

  beforeAll(async () => {
    fd = await startFrontDesk();
    await fd.app.listen(0, '127.0.0.1');
    api = `http://127.0.0.1:${(fd.app.getHttpServer().address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    await fd.reset();
    clock = NOW;
    await seedOwner();
  });
  afterEach(async () => {
    await fd.sql(`DROP TRIGGER IF EXISTS t14_on_close ON folio`);
    await fd.sql(`DROP TRIGGER IF EXISTS t14_on_document ON folio_document`);
    await fd.sql(`DROP FUNCTION IF EXISTS t14_on_close()`);
    await fd.sql(`DROP FUNCTION IF EXISTS t14_on_document()`);
  });
  afterAll(async () => {
    await fd?.close();
  });

  const STEPS_FIRST_RUN = [
    'health',
    'sign-in',
    'licence',
    'leftovers',
    'business day',
    'unit type SMOKE',
    'rate plan SMOKE',
    'reservation',
    'extra guest',
    'check-in',
    'charge',
    'cash payment',
    'close',
    'card payment',
    'check-out',
    'receipt',
    'folio check',
    'confirmation message',
  ];
  const stepNames = (out: Outcome) =>
    lines(out)
      .filter((l) => !l.startsWith('OK   smoke 1b'))
      .map((l) => l.replace(/^(OK|SKIP|FAIL) +/, '').split(':')[0]);

  it(
    'first run with --allow-close: only OK lines, every step in order, the day is closed, one night, a receipt, a sent confirmation',
    async () => {
      const code = totpGenerate(owner.totpSecret!, new Date(clock.getTime() + 60_000));
      const timer = setInterval(() => void fd.dispatcher.runOnce().catch(() => undefined), 150);
      let out: Outcome;
      try {
        out = await smoke(['--allow-close', '--mail-to', 'gost@hotel.test']);
      } finally {
        clearInterval(timer);
      }
      expect(out.stdout).not.toMatch(/FAIL|SKIP/);
      expect(out.code).toBe(0);
      expect(lines(out).every((l) => l.startsWith('OK '))).toBe(true);
      expect(stepNames(out)).toEqual(STEPS_FIRST_RUN);
      expect(out.stdout).toMatch(/^OK +close: dan 2026-11-02, noćenja 1, no-show 0$/m);
      expect(out.stdout).toMatch(/^OK +receipt: N-2026-000001$/m);
      expect(out.stdout).toMatch(/^OK +smoke 1b je prošao$/m);
      // Neither the password, nor the TOTP secret or code, nor the guest's address reach the output.
      const all = out.stdout + out.stderr;
      for (const secret of [PASSWORD, owner.totpSecret!, code, 'gost@hotel.test', 'otpauth']) expect(all).not.toContain(secret);

      expect(await q(`SELECT day::text AS day, status FROM business_day ORDER BY day`)).toEqual([
        { day: '2026-11-02', status: 'closed' },
        { day: '2026-11-03', status: 'open' },
      ]);
      expect(await smokeReservations()).toEqual([{ stay: 'checked_out' }]);
      expect(await q(`SELECT count(*)::int AS n FROM stay_guest`)).toEqual([{ n: 2 }]);
      expect(await q(`SELECT kind, amount_minor::int AS amount, source_type FROM folio_line ORDER BY kind`)).toEqual([
        { kind: 'accommodation', amount: 500_000, source_type: 'night_audit' },
        { kind: 'service', amount: 50_000, source_type: 'manual' },
      ]);
      expect(await q(`SELECT method, amount_minor::int AS amount FROM payment ORDER BY method`)).toEqual([
        { method: 'card', amount: 500_000 },
        { method: 'cash', amount: 50_000 },
      ]);
      expect(await q(`SELECT status FROM folio`)).toEqual([{ status: 'closed' }]);
      expect(await q(`SELECT number FROM folio_document`)).toEqual([{ number: 'N-2026-000001' }]);
      expect(fd.mail.sent.map((m) => m.to)).toEqual(['gost@hotel.test']);
    },
    LONG,
  );

  it(
    'a second run on the same day skips the close (the business day is already tomorrow) and still ends in a closed folio with one night',
    async () => {
      expect((await smoke(['--allow-close'])).code).toBe(0);
      const out = await smoke(['--allow-close']);
      expect(out.stdout).not.toMatch(/FAIL/);
      expect(out.code).toBe(0);
      expect(out.stdout).toMatch(/^SKIP close: poslovni dan je već sutrašnji$/m);
      expect(out.stdout).toMatch(/^OK +business day: 2026-11-03$/m);
      expect(out.stdout).toMatch(/^OK +receipt: N-2026-000002$/m);
      expect(await q(`SELECT day::text AS day, status FROM business_day ORDER BY day`)).toEqual([
        { day: '2026-11-02', status: 'closed' },
        { day: '2026-11-03', status: 'open' },
      ]);
      expect(await smokeReservations()).toEqual([{ stay: 'checked_out' }, { stay: 'checked_out' }]);
      // One night per stay, whichever way it was posted.
      expect(await q(`SELECT source_type, count(*)::int AS n FROM folio_line WHERE kind = 'accommodation' GROUP BY source_type ORDER BY 1`)).toEqual([
        { source_type: 'check_out', n: 1 },
        { source_type: 'night_audit', n: 1 },
      ]);
    },
    LONG,
  );

  it(
    'without --allow-close nothing is closed: the close is skipped, check-out on the arrival day posts the one night',
    async () => {
      const out = await smoke();
      expect(out.stdout).not.toMatch(/FAIL/);
      expect(out.code).toBe(0);
      expect(out.stdout).toMatch(/^SKIP close: bez --allow-close dan se ne zatvara; odjava knjiži noć$/m);
      expect(await q(`SELECT day::text AS day, status FROM business_day ORDER BY day`)).toEqual([{ day: '2026-11-02', status: 'open' }]);
      expect(await q(`SELECT kind, source_type FROM folio_line WHERE kind = 'accommodation'`)).toEqual([
        { kind: 'accommodation', source_type: 'check_out' },
      ]);
      expect(await q(`SELECT status FROM folio`)).toEqual([{ status: 'closed' }]);
      expect(await q(`SELECT number FROM folio_document`)).toEqual([{ number: 'N-2026-000001' }]);
    },
    LONG,
  );

  it(
    'a business day that lags behind the calendar is not closed without --allow-close: FAIL, and nothing is written',
    async () => {
      expect((await smoke()).code).toBe(0); // opens 2026-11-02 and leaves it open
      await jump(new Date('2026-11-04T08:00:00Z'));
      const before = await smokeReservations();
      const out = await smoke();
      expect(out.code).toBe(1);
      expect(out.stdout).toMatch(/^FAIL business day: poslovni dan 2026-11-02 kasni; pokrenite sa --allow-close$/m);
      expect(out.stdout).not.toMatch(/unit type SMOKE/);
      expect(await q(`SELECT count(*)::int AS n FROM business_day WHERE status = 'closed'`)).toEqual([{ n: 0 }]);
      expect(await smokeReservations()).toEqual(before);
    },
    LONG,
  );

  it(
    'with --allow-close a lagging day is closed day by day, each close reports its nights and no-shows (real data), then the run goes on',
    async () => {
      const t = await fd.pricedType('FD', 1);
      expect((await smoke()).code).toBe(0); // opens 2026-11-02
      await fd.bookStay(t, '2026-11-02', '2026-11-03'); // expected, never arrives
      await jump(new Date('2026-11-04T08:00:00Z'));
      const out = await smoke(['--allow-close']);
      expect(out.stdout).not.toMatch(/FAIL/);
      expect(out.code).toBe(0);
      expect(out.stdout).toMatch(/^OK +close: dan 2026-11-02, noćenja \d+, no-show 1$/m);
      expect(out.stdout).toMatch(/^OK +close: dan 2026-11-03, noćenja 0, no-show 0$/m);
      expect(out.stdout).toMatch(/^OK +business day: 2026-11-04$/m);
      expect(await q(`SELECT status FROM stay WHERE status = 'no_show'`)).toEqual([{ status: 'no_show' }]);
      expect(await q(`SELECT day::text AS day FROM business_day WHERE status = 'closed' ORDER BY day`)).toEqual([
        { day: '2026-11-02' },
        { day: '2026-11-03' },
        { day: '2026-11-04' },
      ]);
    },
    LONG,
  );

  it(
    'a guest who should have left blocks the close: the FAIL names the reservation and the run stops',
    async () => {
      const t = await fd.pricedType('FD', 1);
      const stay = await fd.inHouse({ ...t, unitId: t.unitIds[0] }, '2026-11-02', '2026-11-03');
      const [{ number }] = await q<{ number: string }>(`SELECT number FROM reservation WHERE id = '${stay.reservationId}'`);
      await jump(new Date('2026-11-04T08:00:00Z'));
      const out = await smoke(['--allow-close']);
      expect(out.code).toBe(1);
      expect(out.stdout).toMatch(/^OK +close: dan 2026-11-02, /m);
      expect(out.stdout).toContain(`FAIL business day: dan 2026-11-03 se ne može zatvoriti`);
      expect(out.stdout).toContain(number);
      expect(out.stdout).not.toMatch(/unit type SMOKE/);
      expect(await smokeReservations()).toEqual([]);
    },
    LONG,
  );

  it(
    'guests of Smoke Test 1b left in the house by a failed run are settled and checked out first: a debt is paid by card, a credit refunded',
    async () => {
      const debtType = await fd.pricedType('FD', 1);
      const creditType = await fd.pricedType('FE', 1);
      const holder = { firstName: 'Smoke', lastName: 'Test 1b' };
      const inHouse = async (t: { typeId: string; planId: string; unitIds: string[] }) => {
        const b = await fd.bookStay({ typeId: t.typeId, planId: t.planId, unitId: t.unitIds[0] }, '2026-11-02', '2026-11-03', { holder });
        const res = await fd.post(`/stays/${b.stayId}/check-in`, { version: b.version });
        expect(res.status).toBe(200);
        return b.stayId;
      };
      const debt = await inHouse(debtType);
      const credit = await inHouse(creditType);
      expect((await fd.post(`/stays/${debt}/folio/charges`, { kind: 'service', description: 'Ostatak', amountMinor: 70_000, key: 'left-charge-0001' })).status).toBe(201);
      expect((await fd.post(`/stays/${credit}/folio/payments`, { method: 'cash', amountMinor: 2_000_000, key: 'left-credit-0001' })).status).toBe(201);

      const out = await smoke(['--allow-close']);
      expect(out.stdout).not.toMatch(/FAIL/);
      expect(out.code).toBe(0);
      expect(out.stdout).toMatch(/^OK +leftovers: izmireno i odjavljeno 2$/m);
      expect(await q(`SELECT status FROM stay WHERE id IN ('${debt}', '${credit}')`)).toEqual([{ status: 'checked_out' }, { status: 'checked_out' }]);
      expect(
        await q(`SELECT p.method, p.amount_minor::int AS amount FROM payment p JOIN folio f ON f.id = p.folio_id
                  WHERE f.stay_id = '${debt}' AND p.method = 'card'`),
      ).toEqual([{ method: 'card', amount: 1_070_000 }]);
      expect(
        await q(`SELECT p.method, p.amount_minor::int AS amount FROM payment p JOIN folio f ON f.id = p.folio_id
                  WHERE f.stay_id = '${credit}' AND p.amount_minor < 0`),
      ).toEqual([{ method: 'cash', amount: -1_000_000 }]);
      expect(await q(`SELECT status FROM folio WHERE stay_id IN ('${debt}', '${credit}')`)).toEqual([{ status: 'closed' }, { status: 'closed' }]);
    },
    LONG,
  );

  it(
    'a reservation left expected by a failed run for the open day is taken up again instead of booking another',
    async () => {
      expect((await smoke(['--allow-close'])).code).toBe(0); // creates SMOKE, closes 2026-11-02; the day is now 2026-11-03
      const [{ unit, plan }] = await q<{ unit: string; plan: string }>(
        `SELECT (SELECT id FROM unit WHERE name = 'S-1') AS unit, (SELECT id FROM rate_plan WHERE code = 'SMOKE') AS plan`,
      );
      await fd.bookStay({ typeId: '', planId: plan, unitId: unit }, '2026-11-03', '2026-11-04', {
        holder: { firstName: 'Smoke', lastName: 'Test 1b' },
      });
      const out = await smoke(['--allow-close']);
      expect(out.stdout).not.toMatch(/FAIL/);
      expect(out.code).toBe(0);
      expect(out.stdout).toMatch(/^OK +reservation: .*nastavlja se/m);
      expect(await smokeReservations()).toEqual([{ stay: 'checked_out' }, { stay: 'checked_out' }]);
    },
    LONG,
  );

  it(
    'a confirmation that is not sent yet is shown with its status instead of failing the run',
    async () => {
      const out = await smoke(['--allow-close', '--mail-to', 'gost@hotel.test', '--mail-wait', '1']);
      expect(out.stdout).not.toMatch(/FAIL/);
      expect(out.code).toBe(0);
      expect(out.stdout).toMatch(/^SKIP confirmation message: .*pending/m);
      expect(out.stdout).toMatch(/^OK +smoke 1b je prošao$/m);
      expect(out.stdout + out.stderr).not.toContain('gost@hotel.test');
    },
    LONG,
  );

  describe('licence', () => {
    it('without the hotel.folio module it stops at the licence step', async () => {
      await fd.reset({ modules: ['hotel.core'] });
      await seedOwner();
      const out = await smoke(['--allow-close']);
      expect(out.code).toBe(1);
      expect(out.stdout).toMatch(/^FAIL licence: licenca nema modul hotel\.folio$/m);
      expect(out.stdout).not.toMatch(/leftovers/);
    }, LONG);

    it('an expired licence is refused (the smoke needs VALID or GRACE)', async () => {
      fd.shiftLicence(400 * DAY_MS);
      const out = await smoke(['--allow-close']);
      expect(out.code).toBe(1);
      expect(out.stdout).toMatch(/^FAIL licence: licenca je EXPIRED; smoke traži VALID ili GRACE$/m);
    }, LONG);
  });

  describe('checks on what the run leaves behind', () => {
    // Corrupt data made on purpose, inside the test database: the API's own
    // invariants (check-out needs balance 0, one accommodation line per night)
    // make these branches unreachable through the API.
    const trigger = async (sql: string) => {
      await fd.sql(sql);
    };

    it('a receipt with something still due fails on dueMinor', async () => {
      await trigger(`
        CREATE FUNCTION t14_on_close() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO folio_line (property_id, folio_id, kind, description, amount_minor, business_date, source_type)
          VALUES (NEW.property_id, NEW.id, 'service', 'trigger', 100, current_date, 'manual');
          RETURN NEW;
        END $$`);
      await trigger(`CREATE TRIGGER t14_on_close AFTER UPDATE ON folio FOR EACH ROW
        WHEN (OLD.status = 'open' AND NEW.status = 'closed') EXECUTE FUNCTION t14_on_close()`);
      const out = await smoke(['--allow-close']);
      expect(out.code).toBe(1);
      expect(out.stdout).toMatch(/^FAIL receipt: dueMinor je 100 \(očekivano 0\)$/m);
    }, LONG);

    it('a document without the "not a fiscal receipt" notice fails the receipt step', async () => {
      await trigger(`
        CREATE FUNCTION t14_on_document() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          NEW.content := jsonb_set(NEW.content, '{notice}', '"Fiskalni račun"');
          RETURN NEW;
        END $$`);
      await trigger(`CREATE TRIGGER t14_on_document BEFORE INSERT ON folio_document FOR EACH ROW EXECUTE FUNCTION t14_on_document()`);
      const out = await smoke(['--allow-close']);
      expect(out.code).toBe(1);
      expect(out.stdout).toMatch(/^FAIL receipt: dokument nema oznaku "Ovo nije fiskalni račun\."$/m);
    }, LONG);

    it('a second accommodation line fails the "exactly one night" check', async () => {
      await trigger(`
        CREATE FUNCTION t14_on_close() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO folio_line (property_id, folio_id, kind, description, amount_minor, night, business_date, source_type)
          VALUES (NEW.property_id, NEW.id, 'accommodation', 'trigger', 100, DATE '2030-01-01', current_date, 'manual');
          INSERT INTO payment (property_id, folio_id, method, amount_minor, business_date, idempotency_key, request_hash)
          VALUES (NEW.property_id, NEW.id, 'cash', 100, current_date, 't14-' || gen_random_uuid()::text, 'x');
          RETURN NEW;
        END $$`);
      await trigger(`CREATE TRIGGER t14_on_close AFTER UPDATE ON folio FOR EACH ROW
        WHEN (OLD.status = 'open' AND NEW.status = 'closed') EXECUTE FUNCTION t14_on_close()`);
      const out = await smoke(['--allow-close']);
      expect(out.code).toBe(1);
      expect(out.stdout).toMatch(/^FAIL folio check: stavki smeštaja je 2 \(očekivano 1\)$/m);
    }, LONG);

    it('a folio with a balance after the receipt fails the folio check', async () => {
      await trigger(`
        CREATE FUNCTION t14_on_document() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO folio_line (property_id, folio_id, kind, description, amount_minor, business_date, source_type)
          VALUES (NEW.property_id, NEW.folio_id, 'service', 'trigger', 100, current_date, 'manual');
          RETURN NEW;
        END $$`);
      await trigger(`CREATE TRIGGER t14_on_document AFTER INSERT ON folio_document FOR EACH ROW EXECUTE FUNCTION t14_on_document()`);
      const out = await smoke(['--allow-close']);
      expect(out.code).toBe(1);
      expect(out.stdout).toMatch(/^FAIL folio check: saldo je 100, očekivano 0$/m);
    }, LONG);

    it('a folio that is not closed fails the folio check', async () => {
      await trigger(`
        CREATE FUNCTION t14_on_document() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE folio SET status = 'open', closed_at = NULL WHERE id = NEW.folio_id;
          RETURN NEW;
        END $$`);
      await trigger(`CREATE TRIGGER t14_on_document AFTER INSERT ON folio_document FOR EACH ROW EXECUTE FUNCTION t14_on_document()`);
      const out = await smoke(['--allow-close']);
      expect(out.code).toBe(1);
      expect(out.stdout).toMatch(/^FAIL folio check: folio nije zatvoren \(status open\)$/m);
    }, LONG);
  });

  describe('arguments', () => {
    it('--help says plainly, in Serbian, what --allow-close does to real data', async () => {
      const out = await node(SMOKE_1B, ['--help']);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('--allow-close');
      expect(out.stdout).toMatch(/trajno/);
      expect(out.stdout).toMatch(/no-show/);
      expect(out.stdout).toMatch(/potvrđen/);
    });

    it('refuses to start without --api, --email or a password; without a TOTP it stops at sign-in', async () => {
      const noEmail = await node(SMOKE_1B, ['--api', api], { HOTEL_SMOKE_PASSWORD: PASSWORD });
      expect(noEmail.code).toBe(1);
      expect(noEmail.stderr).toMatch(/--email je obavezan/);
      const noPassword = await node(SMOKE_1B, ['--api', api, '--email', owner.email]);
      expect(noPassword.code).toBe(1);
      expect(noPassword.stderr).toMatch(/HOTEL_SMOKE_PASSWORD/);
      const noTotp = await smoke([], { totp: false });
      expect(noTotp.code).toBe(1);
      expect(noTotp.stdout).toMatch(/^FAIL sign-in: dajte --totp <kod> ili --totp-file <fajl>/m);
    }, LONG);
  });
});

describe('scripts/smoke-1b.mjs with Turnstile switched on (e2e)', () => {
  let ta: TestApp;
  let api: string;

  beforeAll(async () => {
    ta = await createTestApp({
      turnstile: { siteKey: 'site-key-1b', secretKey: 'secret-key-1b', verifyUrl: 'http://127.0.0.1:9', timeoutMs: 400, hostnames: null },
    });
    await ta.app.listen(0, '127.0.0.1');
    api = `http://127.0.0.1:${(ta.app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await ta?.app.close();
  });

  it('refuses at sign-in: the smoke sends no Turnstile token', async () => {
    await ta.reset();
    const owner = await seedUser(ta.testDb, 'owner');
    const out = await node(
      SMOKE_1B,
      ['--api', api, '--email', owner.email, '--totp', totpGenerate(owner.totpSecret!, new Date())],
      { HOTEL_SMOKE_PASSWORD: PASSWORD },
    );
    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(/^OK +health$/m);
    expect(out.stdout).toMatch(/^FAIL sign-in: Turnstile je uključen; smoke radi samo bez TURNSTILE_\* ključeva$/m);
    expect(out.stdout).not.toMatch(/licence/);
  }, 60_000);
});
