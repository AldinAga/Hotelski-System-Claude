import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { RatesService } from '../src/rates/rates.service';
import { ActivationService } from '../src/licensing/activation.service';
import { CentralAdminClient } from '../src/licensing/central-admin.client';
import { LicenceService } from '../src/licensing/licence.service';
import { parseRootKeySet } from '../src/licensing/licensing.config';
import { SecretBox } from '../src/licensing/secret-box';
import type { Scope } from '../src/inventory/inventory.service';
import { createTestApp, type TestApp } from './app';
import { ensureProperty, seedUser, sessionCookieFor } from './auth-helpers';
import { startFakeCentralAdmin, type FakeCentralAdmin } from './fake-central-admin';

const NOW = new Date('2026-11-02T08:00:00Z');
const DAY_MS = 86_400_000;

describe('base price list and stay quotes (e2e)', () => {
  let fake: FakeCentralAdmin;
  let ta: TestApp;
  let app: INestApplication;
  let manager: string;
  let receptionist: string;
  let now = NOW;
  // The licence runs on the real clock (the fake central admin issues it in real time); this shifts it.
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
  const get = (path: string, cookie = manager) => request(server()).get(path).set('Cookie', cookie);

  async function createType(code: string): Promise<string> {
    const res = await post('/unit-types', { code, name: { sr: `Tip ${code}` }, capacity: 2 });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function createPlan(code = 'BAR', extra: object = {}): Promise<string> {
    const res = await post('/rate-plans', { code, name: { sr: 'Osnovna cena', en: 'Best available' }, ...extra });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  const scopeParam = (s: Scope) => `${s.kind}:${s.id}`;

  function quote(planId: string, scope: Scope, arrival: string, departure: string) {
    return ta.testDb.db.transaction(async (tx) =>
      app.get(RatesService).quote(tx, await ensureProperty(ta.testDb), planId, scope, arrival, departure),
    );
  }

  async function audit(action: string) {
    const { rows } = await ta.testDb.pool.query(
      `SELECT entity_id, before, after, actor_user_id FROM audit_log WHERE action = $1 ORDER BY id`,
      [action],
    );
    return rows;
  }

  describe('rate plans', () => {
    it('creates a plan with defaults, lists it and audits the creation', async () => {
      const res = await post('/rate-plans', { code: 'BAR', name: { sr: 'Osnovna cena' } });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        code: 'BAR',
        name: { sr: 'Osnovna cena' },
        board: 'RO',
        cancellationPolicy: null,
        discount7Pct: 0,
        discount30Pct: 0,
        active: true,
      });
      const list = await get('/rate-plans', receptionist);
      expect(list.status).toBe(200);
      expect(list.body).toEqual([res.body]);
      const rows = await audit('rate_plan.create');
      expect(rows).toHaveLength(1);
      expect(rows[0].entity_id).toBe(res.body.id);
    });

    it('updates discounts and board, audits before and after, and keeps the code unique', async () => {
      const id = await createPlan('BAR');
      await createPlan('NR');
      const res = await patch(`/rate-plans/${id}`, { discount7Pct: 10, discount30Pct: 20, board: 'BB' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ discount7Pct: 10, discount30Pct: 20, board: 'BB' });
      const rows = await audit('rate_plan.update');
      expect(rows).toHaveLength(1);
      expect(rows[0].before).toMatchObject({ discount7Pct: 0, board: 'RO' });
      expect(rows[0].after).toMatchObject({ discount7Pct: 10, board: 'BB' });

      const dup = await patch(`/rate-plans/${id}`, { code: 'NR' });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('rate_plan_code_taken');
      expect((await post('/rate-plans', { code: 'NR', name: { sr: 'x' } })).status).toBe(409);
    });

    it.each([
      ['discount over 100', { discount7Pct: 101 }, 'discount7Pct'],
      ['negative discount', { discount30Pct: -1 }, 'discount30Pct'],
      ['fractional discount', { discount7Pct: 5.5 }, 'discount7Pct'],
      ['unknown board', { board: 'AI' }, 'board'],
      ['array as cancellation policy', { cancellationPolicy: [] }, 'cancellationPolicy'],
    ])('%s: 422 validation_failed', async (_name, extra, field) => {
      const res = await post('/rate-plans', { code: 'BAR', name: { sr: 'x' }, ...extra });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'validation_failed', details: { field } });
    });

    it('an unknown plan: 404 rate_plan_not_found', async () => {
      const res = await patch('/rate-plans/00000000-0000-4000-8000-000000000000', { active: false });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('rate_plan_not_found');
      expect((await patch('/rate-plans/nije-uuid', { active: false })).body.code).toBe('rate_plan_not_found');
    });
  });

  describe('days', () => {
    it('sets a range with one request, reads it back, and a later partial update keeps the other field', async () => {
      const plan = await createPlan();
      const scope: Scope = { kind: 'unit_type', id: await createType('DBL') };

      const set = await put(`/rate-plans/${plan}/days`, { scope, from: '2026-12-01', to: '2026-12-04', priceMinor: 1_000_000 });
      expect(set.status).toBe(200);
      expect(set.body).toEqual({ days: 3 });

      const read = await get(`/rate-plans/${plan}/days?scope=${scopeParam(scope)}&from=2026-11-30&to=2026-12-05`);
      expect(read.status).toBe(200);
      expect(read.body).toEqual([
        { day: '2026-12-01', priceMinor: 1_000_000, closed: false },
        { day: '2026-12-02', priceMinor: 1_000_000, closed: false },
        { day: '2026-12-03', priceMinor: 1_000_000, closed: false },
      ]);

      // Closing one night keeps its price; re-pricing keeps it closed.
      await put(`/rate-plans/${plan}/days`, { scope, from: '2026-12-02', to: '2026-12-03', closed: true });
      await put(`/rate-plans/${plan}/days`, { scope, from: '2026-12-02', to: '2026-12-04', priceMinor: 1_200_000 });
      const after = await get(`/rate-plans/${plan}/days?scope=${scopeParam(scope)}&from=2026-12-01&to=2026-12-04`);
      expect(after.body).toEqual([
        { day: '2026-12-01', priceMinor: 1_000_000, closed: false },
        { day: '2026-12-02', priceMinor: 1_200_000, closed: true },
        { day: '2026-12-03', priceMinor: 1_200_000, closed: false },
      ]);

      // Closing a night that has no row yet creates a row without a price.
      await put(`/rate-plans/${plan}/days`, { scope, from: '2026-12-10', to: '2026-12-11', closed: true });
      const closedOnly = await get(`/rate-plans/${plan}/days?scope=${scopeParam(scope)}&from=2026-12-10&to=2026-12-11`);
      expect(closedOnly.body).toEqual([{ day: '2026-12-10', priceMinor: null, closed: true }]);

      const rows = await audit('rate_day.set');
      expect(rows).toHaveLength(4);
      expect(rows[0].entity_id).toBe(plan);
      expect(rows[0].after).toMatchObject({ scope, from: '2026-12-01', to: '2026-12-04', priceMinor: 1_000_000 });
    });

    it('a price of 0 is accepted when sent explicitly', async () => {
      const plan = await createPlan();
      const scope: Scope = { kind: 'unit_type', id: await createType('DBL') };
      expect((await put(`/rate-plans/${plan}/days`, { scope, from: '2026-12-01', to: '2026-12-02', priceMinor: 0 })).status).toBe(200);
      const read = await get(`/rate-plans/${plan}/days?scope=${scopeParam(scope)}&from=2026-12-01&to=2026-12-02`);
      expect(read.body).toEqual([{ day: '2026-12-01', priceMinor: 0, closed: false }]);
    });

    it('exactly 731 days are allowed, 732 are 422 range_too_long and write nothing', async () => {
      const plan = await createPlan();
      const scope: Scope = { kind: 'unit_type', id: await createType('DBL') };
      const base = { scope, from: '2026-12-01', priceMinor: 100 };
      const tooLong = await put(`/rate-plans/${plan}/days`, { ...base, to: '2028-12-02' }); // 732 days
      expect(tooLong.status).toBe(422);
      expect(tooLong.body.code).toBe('range_too_long');
      const none = await ta.testDb.pool.query('SELECT count(*)::int AS n FROM rate_day');
      expect(none.rows[0].n).toBe(0);

      const ok = await put(`/rate-plans/${plan}/days`, { ...base, to: '2028-12-01' }); // 731 days
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ days: 731 });

      const readTooLong = await get(`/rate-plans/${plan}/days?scope=${scopeParam(scope)}&from=2026-12-01&to=2028-12-02`);
      expect(readTooLong.status).toBe(422);
      expect(readTooLong.body.code).toBe('range_too_long');
    });

    it.each([
      ['to equals from', { from: '2026-12-01', to: '2026-12-01', priceMinor: 1 }, 'to'],
      ['to before from', { from: '2026-12-02', to: '2026-12-01', priceMinor: 1 }, 'to'],
      ['malformed date', { from: '1.12.2026', to: '2026-12-02', priceMinor: 1 }, 'from'],
      ['a date that does not exist', { from: '2026-02-30', to: '2026-03-02', priceMinor: 1 }, 'from'],
      ['neither price nor closed', { from: '2026-12-01', to: '2026-12-02' }, 'priceMinor'],
      ['negative price', { from: '2026-12-01', to: '2026-12-02', priceMinor: -1 }, 'priceMinor'],
      ['fractional price', { from: '2026-12-01', to: '2026-12-02', priceMinor: 10.5 }, 'priceMinor'],
      ['price above the safe integer range', { from: '2026-12-01', to: '2026-12-02', priceMinor: 2 ** 60 }, 'priceMinor'],
      ['price as a string', { from: '2026-12-01', to: '2026-12-02', priceMinor: '100' }, 'priceMinor'],
      ['closed that is not a boolean', { from: '2026-12-01', to: '2026-12-02', closed: 'da' }, 'closed'],
    ])('%s: 422 validation_failed', async (_name, body, field) => {
      const plan = await createPlan();
      const scope: Scope = { kind: 'unit_type', id: await createType('DBL') };
      const res = await put(`/rate-plans/${plan}/days`, { scope, ...body });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'validation_failed', details: { field } });
    });

    it('a scope that is not in this property: 404 scope_not_found, nothing written', async () => {
      const plan = await createPlan();
      const scope: Scope = { kind: 'unit_type', id: '00000000-0000-4000-8000-000000000000' };
      const res = await put(`/rate-plans/${plan}/days`, { scope, from: '2026-12-01', to: '2026-12-02', priceMinor: 1 });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('scope_not_found');
      expect((await ta.testDb.pool.query('SELECT count(*)::int AS n FROM rate_day')).rows[0].n).toBe(0);
      const read = await get(`/rate-plans/${plan}/days?scope=${scopeParam(scope)}&from=2026-12-01&to=2026-12-02`);
      expect(read.status).toBe(404);
    });

    it('a malformed scope is 422 on both PUT and GET', async () => {
      const plan = await createPlan();
      const range = { from: '2026-12-01', to: '2026-12-02', priceMinor: 1 };
      expect((await put(`/rate-plans/${plan}/days`, { scope: { kind: 'room', id: 'x' }, ...range })).status).toBe(422);
      expect((await get(`/rate-plans/${plan}/days?scope=nonsense&from=2026-12-01&to=2026-12-02`)).status).toBe(422);
    });

    it('a unit that has a type is never priced on its own: 422 scope_not_priced on PUT and GET (Ruling 19)', async () => {
      const plan = await createPlan();
      const typeId = await createType('DBL');
      const typed = await post('/units', { name: 'DBL-1', unitTypeId: typeId });
      expect(typed.status).toBe(201);
      const scope: Scope = { kind: 'unit', id: typed.body.id };
      const res = await put(`/rate-plans/${plan}/days`, { scope, from: '2026-12-01', to: '2026-12-02', priceMinor: 1 });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'scope_not_priced', details: { unitTypeId: typeId } });
      expect((await ta.testDb.pool.query('SELECT count(*)::int AS n FROM rate_day')).rows[0].n).toBe(0);
      const read = await get(`/rate-plans/${plan}/days?scope=${scopeParam(scope)}&from=2026-12-01&to=2026-12-02`);
      expect(read.status).toBe(422);
      expect(read.body.code).toBe('scope_not_priced');

      // A unit without a type is its own scope and is priced.
      const loose = await post('/units', { name: 'Apartman', unitTypeId: null });
      const looseScope: Scope = { kind: 'unit', id: loose.body.id };
      expect((await put(`/rate-plans/${plan}/days`, { scope: looseScope, from: '2026-12-01', to: '2026-12-02', priceMinor: 1 })).status).toBe(200);
      expect((await get(`/rate-plans/${plan}/days?scope=${scopeParam(looseScope)}&from=2026-12-01&to=2026-12-02`)).status).toBe(200);
    });

    it('days of an unknown plan: 404 rate_plan_not_found', async () => {
      const scope: Scope = { kind: 'unit_type', id: await createType('DBL') };
      const id = '00000000-0000-4000-8000-000000000000';
      const res = await put(`/rate-plans/${id}/days`, { scope, from: '2026-12-01', to: '2026-12-02', priceMinor: 1 });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('rate_plan_not_found');
    });
  });

  describe('RatesService.quote', () => {
    it('prices the nights [arrival, departure) with the plan discount, a night with no row is price_missing', async () => {
      const plan = await createPlan('BAR', { discount7Pct: 10 });
      const scope: Scope = { kind: 'unit_type', id: await createType('DBL') };
      await put(`/rate-plans/${plan}/days`, { scope, from: '2026-12-01', to: '2026-12-08', priceMinor: 1_000_000 });

      const ok = await quote(plan, scope, '2026-12-01', '2026-12-08');
      expect(ok).toMatchObject({ ok: true, total: { amount_minor: 6_300_000, currency_code: 'RSD' } });

      // The departure night is not priced: 2026-12-08 has no row and is not a night of the stay.
      const six = await quote(plan, scope, '2026-12-01', '2026-12-07');
      expect(six).toMatchObject({ ok: true, total: { amount_minor: 6_000_000 } });

      expect(await quote(plan, scope, '2026-12-05', '2026-12-10')).toEqual({ ok: false, reason: 'price_missing', day: '2026-12-08' });
    });

    it('a closed night: reason closed with that day; another scope has its own prices', async () => {
      const plan = await createPlan();
      const dbl: Scope = { kind: 'unit_type', id: await createType('DBL') };
      const sgl: Scope = { kind: 'unit_type', id: await createType('SGL') };
      await put(`/rate-plans/${plan}/days`, { scope: dbl, from: '2026-12-01', to: '2026-12-04', priceMinor: 500_000 });
      await put(`/rate-plans/${plan}/days`, { scope: dbl, from: '2026-12-02', to: '2026-12-03', closed: true });
      expect(await quote(plan, dbl, '2026-12-01', '2026-12-04')).toEqual({ ok: false, reason: 'closed', day: '2026-12-02' });
      expect(await quote(plan, sgl, '2026-12-01', '2026-12-02')).toEqual({ ok: false, reason: 'price_missing', day: '2026-12-01' });
    });

    it('a price of 0 quotes as free', async () => {
      const plan = await createPlan();
      const scope: Scope = { kind: 'unit_type', id: await createType('DBL') };
      await put(`/rate-plans/${plan}/days`, { scope, from: '2026-12-01', to: '2026-12-02', priceMinor: 0 });
      expect(await quote(plan, scope, '2026-12-01', '2026-12-02')).toMatchObject({ ok: true, total: { amount_minor: 0 } });
    });

    it('an inactive plan: 422 rate_plan_inactive; an unknown plan: 404 rate_plan_not_found', async () => {
      const plan = await createPlan();
      const scope: Scope = { kind: 'unit_type', id: await createType('DBL') };
      await put(`/rate-plans/${plan}/days`, { scope, from: '2026-12-01', to: '2026-12-02', priceMinor: 1 });
      await patch(`/rate-plans/${plan}`, { active: false });
      await expect(quote(plan, scope, '2026-12-01', '2026-12-02')).rejects.toMatchObject({ code: 'rate_plan_inactive', status: 422 });
      await expect(quote('00000000-0000-4000-8000-000000000000', scope, '2026-12-01', '2026-12-02')).rejects.toMatchObject({
        code: 'rate_plan_not_found',
        status: 404,
      });
    });

    it('a scope that does not exist: 404 scope_not_found instead of a wall of price_missing', async () => {
      const plan = await createPlan();
      await expect(
        quote(plan, { kind: 'unit', id: '00000000-0000-4000-8000-000000000000' }, '2026-12-01', '2026-12-02'),
      ).rejects.toMatchObject({ code: 'scope_not_found', status: 404 });
    });
  });

  describe('roles and licence', () => {
    it('a receptionist can read prices but not change them: 403 forbidden_role', async () => {
      const plan = await createPlan();
      const scope: Scope = { kind: 'unit_type', id: await createType('DBL') };
      const day = { scope, from: '2026-12-01', to: '2026-12-02', priceMinor: 1 };
      for (const res of [
        await post('/rate-plans', { code: 'X', name: { sr: 'x' } }, receptionist),
        await patch(`/rate-plans/${plan}`, { active: false }, receptionist),
        await put(`/rate-plans/${plan}/days`, day, receptionist),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('forbidden_role');
      }
      expect((await ta.testDb.pool.query('SELECT count(*)::int AS n FROM rate_day')).rows[0].n).toBe(0);
      expect((await get('/rate-plans', receptionist)).status).toBe(200);
      expect((await get(`/rate-plans/${plan}/days?scope=${scopeParam(scope)}&from=2026-12-01&to=2026-12-02`, receptionist)).status).toBe(200);
    });

    it('anonymous: 401', async () => {
      expect((await request(server()).get('/rate-plans')).status).toBe(401);
    });

    it('in safe mode PUT days is 403 safe_mode_blocked, GET still works', async () => {
      await ta.reset();
      await activate({ expiry_mode: 'safe_mode' });
      manager = await sessionCookieFor(app, (await seedUser(ta.testDb, 'manager')).id);
      const plan = await createPlan();
      const scope: Scope = { kind: 'unit_type', id: await createType('DBL') };
      await put(`/rate-plans/${plan}/days`, { scope, from: '2026-12-01', to: '2026-12-02', priceMinor: 100 });

      now = new Date(NOW.getTime() + 400 * DAY_MS);
      licenceShiftMs = 400 * DAY_MS; // past valid_until and grace_until
      manager = await sessionCookieFor(app, (await seedUser(ta.testDb, 'manager')).id);
      const blocked = await put(`/rate-plans/${plan}/days`, { scope, from: '2026-12-01', to: '2026-12-02', priceMinor: 999 });
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('safe_mode_blocked');
      expect((await post('/rate-plans', { code: 'Y', name: { sr: 'y' } })).body.code).toBe('safe_mode_blocked');
      const patched = await patch(`/rate-plans/${plan}`, { discount7Pct: 50 });
      expect(patched.status).toBe(403);
      expect(patched.body.code).toBe('safe_mode_blocked');

      const read = await get(`/rate-plans/${plan}/days?scope=${scopeParam(scope)}&from=2026-12-01&to=2026-12-02`);
      expect(read.status).toBe(200);
      expect(read.body).toEqual([{ day: '2026-12-01', priceMinor: 100, closed: false }]);
      expect((await get('/rate-plans')).status).toBe(200);
    });
  });
});
