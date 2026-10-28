import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ActivationService } from '../src/licensing/activation.service';
import { CentralAdminClient } from '../src/licensing/central-admin.client';
import { LicenceService } from '../src/licensing/licence.service';
import { parseRootKeySet } from '../src/licensing/licensing.config';
import { SecretBox } from '../src/licensing/secret-box';
import { createTestApp, type TestApp } from './app';
import { seedUser, sessionCookieFor } from './auth-helpers';
import { startFakeCentralAdmin, type FakeCentralAdmin } from './fake-central-admin';

// 09:00 in Belgrade on 2 Nov 2026: "today" for the property is 2026-11-02.
const NOW = new Date('2026-11-02T08:00:00Z');
const DAY_MS = 86_400_000;

describe('front-desk calendar (e2e)', () => {
  let fake: FakeCentralAdmin;
  let ta: TestApp;
  let app: INestApplication;
  let manager: string;
  let receptionist: string;
  let now = NOW;
  let licenceShiftMs = 0;

  beforeAll(async () => {
    fake = await startFakeCentralAdmin();
    ta = await createTestApp({
      clock: () => now,
      licensing: {
        client: new CentralAdminClient({ baseUrl: fake.url, allowHttp: true }),
        rootKeySet: parseRootKeySet(JSON.stringify(fake.rootKeySet)),
        secretBox: new SecretBox(randomBytes(32)),
        now: () => new Date(Date.now() + licenceShiftMs),
      },
    });
    app = ta.app;
  });
  beforeEach(async () => {
    now = NOW;
    licenceShiftMs = 0;
    await ta.reset();
    await activate({});
    manager = await sessionCookieFor(app, (await seedUser(ta.testDb, 'manager')).id);
    receptionist = await sessionCookieFor(app, (await seedUser(ta.testDb, 'receptionist')).id);
  });
  afterAll(async () => {
    await app.close();
    await fake.close();
  });

  async function activate(licence: Record<string, unknown>): Promise<void> {
    await app.get(ActivationService).activate(fake.issueCode({ licence: { limits: { rooms: 20, users: 10 }, ...licence } }));
    await app.get(LicenceService).reload();
  }

  const server = () => app.getHttpServer();
  const post = (path: string, body: object, cookie = manager) =>
    request(server()).post(path).set('Cookie', cookie).send(body);
  const patch = (path: string, body: object, cookie = manager) =>
    request(server()).patch(path).set('Cookie', cookie).send(body);
  const put = (path: string, body: object, cookie = manager) =>
    request(server()).put(path).set('Cookie', cookie).send(body);
  const get = (path: string, cookie = receptionist) => request(server()).get(path).set('Cookie', cookie);

  async function createType(code: string): Promise<string> {
    const res = await post('/unit-types', { code, name: { sr: `Tip ${code}` }, capacity: 3 });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function createUnit(name: string, unitTypeId: string | null): Promise<string> {
    const res = await post('/units', { name, unitTypeId });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function createPlan(): Promise<string> {
    const res = await post('/rate-plans', { code: 'BAR', name: { sr: 'Osnovna cena' } });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  /** A type with `units` units, priced for the whole test horizon. */
  async function pricedType(code: string, units: number, plan: string) {
    const typeId = await createType(code);
    const unitIds: string[] = [];
    for (let i = 1; i <= units; i++) unitIds.push(await createUnit(`${code}-${i}`, typeId));
    const res = await put(`/rate-plans/${plan}/days`, {
      scope: { kind: 'unit_type', id: typeId },
      from: '2026-11-01',
      to: '2028-03-01',
      priceMinor: 1_000_000,
    });
    expect(res.status).toBe(200);
    return { typeId, unitIds };
  }

  const holder = { firstName: 'Petar', lastName: 'Petrović', email: 'petar@example.com' };

  async function book(
    plan: string,
    target: { unitTypeId?: string; unitId?: string },
    arrival: string,
    departure: string,
  ) {
    const res = await post(
      '/reservations',
      { source: 'front_desk', holder, stays: [{ ...target, arrival, departure, adults: 2, ratePlanId: plan }] },
      receptionist,
    );
    expect(res.status).toBe(201);
    return res.body as { reservationId: string; number: string };
  }

  async function count(table: 'inventory_day' | 'audit_log'): Promise<number> {
    const { rows } = await ta.testDb.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0].n;
  }

  const calendar = (from: string, to: string, cookie = receptionist) => get(`/calendar?from=${from}&to=${to}`, cookie);

  it('a stay across the range boundary is in the range with its real dates (not clipped)', async () => {
    const plan = await createPlan();
    const dbl = await pricedType('DBL', 2, plan);
    const r = await book(plan, { unitId: dbl.unitIds[0] }, '2026-11-10', '2026-11-20');

    const res = await calendar('2026-11-12', '2026-11-15');
    expect(res.status).toBe(200);
    expect(res.body.days).toEqual(['2026-11-12', '2026-11-13', '2026-11-14']);
    const row = res.body.units.find((u: { id: string }) => u.id === dbl.unitIds[0]);
    expect(row.bars).toEqual([
      expect.objectContaining({
        kind: 'stay',
        reservationId: r.reservationId,
        number: r.number,
        guest: 'Petar Petrović',
        arrival: '2026-11-10',
        departure: '2026-11-20',
        status: 'expected',
      }),
    ]);
    expect(row.bars[0].stayId).toEqual(expect.any(String));
    // A stay arriving on the first day of the range says so (the screen draws no "continues" edge).
    const r2 = await book(plan, { unitId: dbl.unitIds[1] }, '2026-11-12', '2026-11-14');
    const again = await calendar('2026-11-12', '2026-11-15');
    expect(again.body.units.find((u: { id: string }) => u.id === dbl.unitIds[1]).bars).toEqual([
      expect.objectContaining({ reservationId: r2.reservationId, arrival: '2026-11-12', departure: '2026-11-14' }),
    ]);
    // A stay that ends the day the range starts is not in it (departure is exclusive).
    const after = await calendar('2026-11-20', '2026-11-22');
    expect(after.body.units.find((u: { id: string }) => u.id === dbl.unitIds[0]).bars).toEqual([]);
  });

  it('an unassigned stay is in unassigned, not in units, with its real dates and the reservation version', async () => {
    const plan = await createPlan();
    const dbl = await pricedType('DBL', 2, plan);
    const r = await book(plan, { unitTypeId: dbl.typeId }, '2026-11-10', '2026-11-20');

    const res = await calendar('2026-11-12', '2026-11-15');
    expect(res.body.unassigned).toEqual([
      {
        stayId: expect.any(String),
        reservationId: r.reservationId,
        number: r.number,
        guest: 'Petar Petrović',
        unitTypeId: dbl.typeId,
        arrival: '2026-11-10',
        departure: '2026-11-20',
        version: 1,
      },
    ]);
    for (const u of res.body.units) expect(u.bars).toEqual([]);

    // The version follows the reservation: a stale screen posts an old one and gets version_conflict.
    const stay = res.body.unassigned[0];
    expect((await post(`/stays/${stay.stayId}/assign-unit`, { unitId: dbl.unitIds[1], version: stay.version }, receptionist)).status).toBe(200);
    const stale = await post(`/stays/${stay.stayId}/assign-unit`, { unitId: dbl.unitIds[0], version: stay.version }, receptionist);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('free for a day without an inventory_day row is the number of active units of the type', async () => {
    const plan = await createPlan();
    const dbl = await pricedType('DBL', 3, plan);
    const inactive = await createUnit('DBL-old', dbl.typeId);
    expect((await patch(`/units/${inactive}`, { active: false })).status).toBe(200);
    const solo = await createUnit('Studio', null);
    const soloOff = await createUnit('Studio-off', null);
    expect((await patch(`/units/${soloOff}`, { active: false })).status).toBe(200);
    expect(await count('inventory_day')).toBe(0);

    const res = await calendar('2026-11-10', '2026-11-13');
    expect(res.status).toBe(200);
    const typed = res.body.availability.find((a: { scope: { id: string } }) => a.scope.id === dbl.typeId);
    expect(typed).toEqual({ scope: { kind: 'unit_type', id: dbl.typeId }, label: 'Tip DBL', free: [3, 3, 3] });
    const untyped = res.body.availability.find((a: { scope: { id: string } }) => a.scope.id === solo);
    expect(untyped).toEqual({ scope: { kind: 'unit', id: solo }, label: 'Studio', free: [1, 1, 1] });
    expect(res.body.availability.some((a: { scope: { id: string } }) => a.scope.id === soloOff)).toBe(false);
    // Inactive units are not rows of the calendar.
    const ids = res.body.units.map((u: { id: string }) => u.id);
    expect(ids).toEqual(expect.arrayContaining([...dbl.unitIds, solo]));
    expect(ids).not.toContain(inactive);
    expect(ids).not.toContain(soloOff);
    expect(res.body.units.find((u: { id: string }) => u.id === solo)).toEqual(
      expect.objectContaining({ name: 'Studio', unitTypeId: null, cleanliness: 'clean', bars: [] }),
    );
  });

  it('free counts sold and blocked nights from the ledger and leaves other days at the total', async () => {
    const plan = await createPlan();
    const dbl = await pricedType('DBL', 3, plan);
    await book(plan, { unitTypeId: dbl.typeId }, '2026-11-10', '2026-11-12');
    await book(plan, { unitTypeId: dbl.typeId }, '2026-11-11', '2026-11-13');
    expect((await post(`/units/${dbl.unitIds[2]}/blocks`, { from: '2026-11-11', to: '2026-11-12', reason: 'maintenance' })).status).toBe(201);

    const res = await calendar('2026-11-09', '2026-11-14');
    const typed = res.body.availability.find((a: { scope: { id: string } }) => a.scope.id === dbl.typeId);
    // 09: no row (3); 10: 1 sold; 11: 2 sold + 1 blocked; 12: 1 sold; 13: no row (3).
    expect(typed.free).toEqual([3, 2, 0, 2, 3]);
  });

  it('a block shows as a bar with its real dates; a cancelled stay is not shown', async () => {
    const plan = await createPlan();
    const dbl = await pricedType('DBL', 2, plan);
    const blk = await post(`/units/${dbl.unitIds[0]}/blocks`, { from: '2026-11-05', to: '2026-11-12', reason: 'owner_use' });
    expect(blk.status).toBe(201);
    const r = await book(plan, { unitId: dbl.unitIds[1] }, '2026-11-10', '2026-11-12');
    expect((await post(`/reservations/${r.reservationId}/cancel`, { version: 1 }, receptionist)).status).toBe(200);

    const res = await calendar('2026-11-08', '2026-11-11');
    const blocked = res.body.units.find((u: { id: string }) => u.id === dbl.unitIds[0]);
    expect(blocked.bars).toEqual([
      { kind: 'block', blockId: blk.body.id, from: '2026-11-05', to: '2026-11-12', reason: 'owner_use' },
    ]);
    const other = res.body.units.find((u: { id: string }) => u.id === dbl.unitIds[1]);
    expect(other.bars).toEqual([]);
    expect(res.body.unassigned).toEqual([]);
  });

  describe('range', () => {
    it('62 days is fine, 63 days is 422', async () => {
      expect((await calendar('2026-11-02', '2027-01-03')).status).toBe(200);
      const res = await calendar('2026-11-02', '2027-01-04');
      expect(res.status).toBe(422);
    });

    it('missing, malformed or empty ranges are 422', async () => {
      for (const path of [
        '/calendar',
        '/calendar?from=2026-11-02',
        '/calendar?from=2026-11-xx&to=2026-11-05',
        '/calendar?from=2026-02-30&to=2026-03-05',
        '/calendar?from=2026-11-05&to=2026-11-05',
        '/calendar?from=2026-11-05&to=2026-11-02',
      ]) {
        const res = await get(path);
        expect([path, res.status]).toEqual([path, 422]);
      }
    });
  });

  it('GET writes nothing: no inventory_day and no audit rows', async () => {
    const plan = await createPlan();
    const dbl = await pricedType('DBL', 2, plan);
    await createUnit('Studio', null);
    await book(plan, { unitTypeId: dbl.typeId }, '2026-11-10', '2026-11-12');
    const days = await count('inventory_day');
    const audit = await count('audit_log');
    expect(days).toBeGreaterThan(0);

    // Far from the booked nights: the days have no row and must stay without.
    const res = await calendar('2027-03-01', '2027-04-01');
    expect(res.status).toBe(200);
    expect(await count('inventory_day')).toBe(days);
    expect(await count('audit_log')).toBe(audit);
  });

  describe('access', () => {
    it('every signed-in role reads it; anonymous is 401', async () => {
      const hk = await sessionCookieFor(app, (await seedUser(ta.testDb, 'housekeeping')).id);
      for (const cookie of [manager, receptionist, hk]) {
        expect((await calendar('2026-11-02', '2026-11-05', cookie)).status).toBe(200);
      }
      expect((await request(server()).get('/calendar?from=2026-11-02&to=2026-11-05')).status).toBe(401);
    });

    it('works in safe mode', async () => {
      await ta.reset();
      await activate({ expiry_mode: 'safe_mode' });
      // Past valid_until and grace_until on both clocks.
      now = new Date(NOW.getTime() + 400 * DAY_MS);
      licenceShiftMs = 400 * DAY_MS;
      manager = await sessionCookieFor(app, (await seedUser(ta.testDb, 'manager')).id);
      receptionist = await sessionCookieFor(app, (await seedUser(ta.testDb, 'receptionist')).id);
      const blocked = await post('/units', { name: 'X', unitTypeId: null });
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('safe_mode_blocked');
      const res = await calendar('2026-11-02', '2026-11-05');
      expect(res.status).toBe(200);
    });
  });
});
