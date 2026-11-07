import { BusinessDayService } from '../src/business-day/business-day.service';
import { PropertyContext } from '../src/common/property-context';
import { startFrontDesk, type FrontDesk } from './front-desk';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('business day (e2e)', () => {
  let fd: FrontDesk;
  let svc: BusinessDayService;
  let pid: string;

  beforeAll(async () => {
    fd = await startFrontDesk();
  });
  beforeEach(async () => {
    await fd.reset();
    svc = fd.app.get(BusinessDayService);
    pid = await fd.app.get(PropertyContext).id();
  });
  afterAll(() => fd.close());

  const open = (mode: 'share' | 'update') => fd.ta.testDb.db.transaction((tx) => svc.lockOpen(tx, pid, mode));

  it('GET /business-day without a row answers today and writes nothing', async () => {
    const res = await fd.get('/business-day');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ day: '2026-11-02', today: '2026-11-02', started: false, lagDays: 0 });
    expect(res.body).toMatchObject({ lastClosed: null, lastAutoError: null });
    expect(await fd.sql('SELECT 1 FROM business_day')).toHaveLength(0);
  });

  it('ten concurrent first writes open today exactly once', async () => {
    const days = await Promise.all(Array.from({ length: 10 }, () => open('share')));
    expect(new Set(days)).toEqual(new Set(['2026-11-02']));
    expect(await fd.sql(`SELECT day::text AS day, status FROM business_day`)).toEqual([
      { day: '2026-11-02', status: 'open' },
    ]);
  });

  it("the first write opens the property's today from the application clock, in the property's timezone", async () => {
    // 23:30 UTC on 11-02 is 00:30 on 11-03 in Belgrade; the database's own now() is neither.
    const late = new Date('2026-11-02T23:30:00Z');
    fd.setNow(late);
    expect(await open('update')).toBe('2026-11-03');
    const rows = await fd.sql<{ day: string; opened_at: Date }>(`SELECT day::text AS day, opened_at FROM business_day`);
    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe('2026-11-03');
    expect(new Date(rows[0].opened_at).toISOString()).toBe(late.toISOString());
    // Through the service: 15.5 h later the harness sessions have expired (they run on CLOCK too).
    expect(await svc.view()).toMatchObject({ day: '2026-11-03', today: '2026-11-03', started: true, lagDays: 0 });
  });

  it('an older open day is the one locked; GET shows the lag; a second open day is refused by the database', async () => {
    await fd.sql(`INSERT INTO business_day (property_id, day, status) VALUES ($1, '2026-11-01', 'open')`, [pid]);
    expect(await open('share')).toBe('2026-11-01');
    expect(await fd.sql('SELECT day::text AS day FROM business_day')).toEqual([{ day: '2026-11-01' }]);
    const res = await fd.get('/business-day');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ day: '2026-11-01', today: '2026-11-02', started: true, lagDays: 1 });
    await expect(
      fd.sql(`INSERT INTO business_day (property_id, day, status) VALUES ($1, '2026-11-02', 'open')`, [pid]),
    ).rejects.toThrow(/business_day_one_open/);
  });

  it('GET /business-day shows the latest closed day and the open day\'s last auto-close error', async () => {
    await fd.sql(
      `INSERT INTO business_day (property_id, day, status, closed_at, close_mode, report) VALUES
         ($1, '2026-10-31', 'closed', '2026-11-01T01:00:00Z', 'manual', '{}'),
         ($1, '2026-11-01', 'closed', '2026-11-02T02:00:00Z', 'auto', '{}')`,
      [pid],
    );
    await fd.sql(
      `INSERT INTO business_day (property_id, day, status, last_auto_error)
       VALUES ($1, '2026-11-02', 'open', '{"at":"2026-11-02T02:00:00.000Z","code":"folio_failed","details":{"stays":2}}')`,
      [pid],
    );
    const res = await fd.get('/business-day', fd.manager);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      day: '2026-11-02',
      today: '2026-11-02',
      started: true,
      lagDays: 0,
      lastClosed: { day: '2026-11-01', closedAt: '2026-11-02T02:00:00.000Z', mode: 'auto' },
      lastAutoError: { at: '2026-11-02T02:00:00.000Z', code: 'folio_failed', details: { stays: 2 } },
    });
  });

  it('an update lock waits for a share lock on the same open day', async () => {
    await open('share'); // the row exists and is committed: the wait below is the row lock, not the insert
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let taken!: () => void;
    const sharedTaken = new Promise<void>((r) => (taken = r));
    const a = fd.ta.testDb.db.transaction(async (tx) => {
      await svc.lockOpen(tx, pid, 'share');
      taken();
      await held;
    });
    await sharedTaken;
    let bDone = false;
    const b = fd.ta.testDb.db.transaction(async (tx) => {
      await svc.lockOpen(tx, pid, 'update');
      bDone = true;
    });
    let waited = false;
    try {
      await delay(300);
      waited = !bDone;
    } finally {
      // Released even when the check fails: a held transaction would block every later reset.
      release();
      await Promise.all([a, b]);
    }
    expect(waited).toBe(true);
    expect(bDone).toBe(true);
  });

  it('two share locks do not wait for each other', async () => {
    await open('share');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let taken!: () => void;
    const sharedTaken = new Promise<void>((r) => (taken = r));
    const a = fd.ta.testDb.db.transaction(async (tx) => {
      await svc.lockOpen(tx, pid, 'share');
      taken();
      await held;
    });
    await sharedTaken;
    // A race, not a plain await: if the second lock waited for the first, the test still
    // releases the first and fails on the result instead of hanging.
    const second = open('share');
    const first = await Promise.race([second.then(() => 'second share lock'), delay(250).then(() => 'timeout')]);
    release();
    await Promise.all([a, second]);
    expect(first).toBe('second share lock');
  });

  it('settings: defaults without a row; PUT stores them; a bad time or rate is 422 naming the field', async () => {
    expect((await fd.get('/settings/business', fd.manager)).body).toEqual({
      autoCloseTime: null,
      noShowCharge: 'none',
      accommodationVatBp: null,
      vatRatesBp: [],
    });
    const ok = await fd.put('/settings/business', {
      autoCloseTime: '03:30',
      noShowCharge: 'first_night',
      accommodationVatBp: 1000,
      vatRatesBp: [0, 1000, 2000],
    });
    expect(ok.status).toBe(200);
    expect((await fd.get('/settings/business', fd.manager)).body.autoCloseTime).toBe('03:30');
    for (const [field, value] of [
      ['autoCloseTime', '24:00'],
      ['accommodationVatBp', 10001],
      ['vatRatesBp', [1000, 1000]],
    ] as const) {
      const res = await fd.put('/settings/business', { [field]: value });
      expect(res.status).toBe(422);
      expect(res.body.details).toEqual({ field });
    }
  });

  it('settings: GET writes nothing; PUT answers the stored settings, keeps absent fields, null clears, and is audited', async () => {
    expect((await fd.get('/settings/business', fd.owner)).status).toBe(200);
    expect(await fd.sql('SELECT 1 FROM property_settings')).toHaveLength(0);

    const full = { autoCloseTime: '03:30', noShowCharge: 'first_night', accommodationVatBp: 1000, vatRatesBp: [2000, 0, 1000] };
    const first = await fd.put('/settings/business', full);
    expect(first.status).toBe(200);
    expect(first.body).toEqual(full);

    const partial = await fd.put('/settings/business', { accommodationVatBp: null, autoCloseTime: '23:59' }, fd.owner);
    expect(partial.status).toBe(200);
    const expected = { autoCloseTime: '23:59', noShowCharge: 'first_night', accommodationVatBp: null, vatRatesBp: [2000, 0, 1000] };
    expect(partial.body).toEqual(expected);
    expect((await fd.get('/settings/business', fd.manager)).body).toEqual(expected);

    const cleared = await fd.put('/settings/business', { autoCloseTime: null, vatRatesBp: [] });
    expect(cleared.body).toEqual({ autoCloseTime: null, noShowCharge: 'first_night', accommodationVatBp: null, vatRatesBp: [] });
    expect(await fd.sql('SELECT 1 FROM property_settings')).toHaveLength(1);

    const audit = await fd.sql<{ actor_user_id: string; entity: string; entity_id: string; before: unknown; after: unknown }>(
      `SELECT actor_user_id, entity, entity_id, before, after FROM audit_log WHERE action = 'settings.update' ORDER BY id`,
    );
    expect(audit).toHaveLength(3);
    expect(audit[0]).toMatchObject({
      actor_user_id: fd.managerId,
      entity: 'property_settings',
      entity_id: pid,
      before: { autoCloseTime: null, noShowCharge: 'none', accommodationVatBp: null, vatRatesBp: [] },
      after: full,
    });
    expect(audit[1]).toMatchObject({ before: full, after: expected });
  });

  it('settings: every rule is 422 naming the field and changes nothing', async () => {
    const cases: Array<[string, unknown]> = [
      ['autoCloseTime', '3:30'],
      ['autoCloseTime', '12:60'],
      ['autoCloseTime', 330],
      ['noShowCharge', 'all_nights'],
      ['noShowCharge', null],
      ['accommodationVatBp', -1],
      ['accommodationVatBp', 1.5],
      ['accommodationVatBp', '1000'],
      ['vatRatesBp', [0, 500, 1000, 1500, 2000, 2500]],
      ['vatRatesBp', [10001]],
      ['vatRatesBp', [-1]],
      ['vatRatesBp', [1.5]],
      ['vatRatesBp', ['1000']],
      ['vatRatesBp', 1000],
      ['vatRatesBp', null],
    ];
    // Collected, then compared once: a failure shows every case that passed wrongly, not only the first.
    const seen = [];
    for (const [field, value] of cases) {
      const res = await fd.put('/settings/business', { [field]: value });
      seen.push({ field, value, status: res.status, details: res.body.details });
    }
    expect(seen).toEqual(cases.map(([field, value]) => ({ field, value, status: 422, details: { field } })));
    // The edges pass: five distinct rates, 0 and 10000, 00:00.
    const edges = await fd.put('/settings/business', {
      autoCloseTime: '00:00',
      accommodationVatBp: 10000,
      vatRatesBp: [0, 1, 2, 3, 10000],
    });
    expect(edges.status).toBe(200);
    expect(await fd.sql(`SELECT 1 FROM audit_log WHERE action = 'settings.update'`)).toHaveLength(1);
  });

  it('roles: housekeeping cannot see the business day; a receptionist cannot see settings', async () => {
    expect((await fd.get('/business-day', fd.owner)).status).toBe(200);
    expect((await fd.get('/business-day', fd.manager)).status).toBe(200);
    const hk = await fd.get('/business-day', fd.housekeeping);
    expect(hk.status).toBe(403);
    expect(hk.body.code).toBe('forbidden_role');
    const rec = await fd.get('/settings/business', fd.receptionist);
    expect(rec.status).toBe(403);
    expect(rec.body.code).toBe('forbidden_role');
  });

  it('a receptionist cannot change settings; in safe mode GET works and PUT is safe_mode_blocked', async () => {
    expect((await fd.put('/settings/business', { noShowCharge: 'none' }, fd.receptionist)).body.code).toBe('forbidden_role');
    fd.shiftLicence(400 * 86_400_000);
    expect((await fd.get('/business-day')).status).toBe(200);
    expect((await fd.get('/settings/business', fd.manager)).status).toBe(200);
    const res = await fd.put('/settings/business', { noShowCharge: 'none' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('safe_mode_blocked');
    expect(await fd.sql('SELECT 1 FROM property_settings')).toHaveLength(0);
  });
});
