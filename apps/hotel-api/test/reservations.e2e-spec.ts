import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import { DomainError } from '../src/common/domain-error';
import { PropertyContext } from '../src/common/property-context';
import { INVENTORY_SCOPE_LOCK_NS, scopeOrder, type Scope } from '../src/inventory/inventory.service';
import { ActivationService } from '../src/licensing/activation.service';
import { CentralAdminClient } from '../src/licensing/central-admin.client';
import { LicenceService } from '../src/licensing/licence.service';
import { parseRootKeySet } from '../src/licensing/licensing.config';
import { SecretBox } from '../src/licensing/secret-box';
import { ReservationsService, type BookInput } from '../src/reservations/reservations.service';
import { createTestApp, type TestApp } from './app';
import { seedUser, sessionCookieFor } from './auth-helpers';
import { startFakeCentralAdmin, type FakeCentralAdmin } from './fake-central-admin';

// 09:00 in Belgrade on 2 Nov 2026: "today" for the property is 2026-11-02.
const NOW = new Date('2026-11-02T08:00:00Z');
const DAY_MS = 86_400_000;
const WAIT_MS = 5_000;

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

describe('reservations (e2e)', () => {
  let fake: FakeCentralAdmin;
  let ta: TestApp;
  let app: INestApplication;
  let manager: string;
  let managerId: string;
  let receptionist: string;
  let now = NOW;
  let licenceShiftMs = 0;
  // Connections outside the app's pool, for holding locks and reading pg_locks
  // while the app's connections are all busy booking.
  let side: Pool;

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
    side = new Pool({ connectionString: ta.testDb.connectionString, max: 3 });
  });
  beforeEach(async () => {
    now = NOW;
    licenceShiftMs = 0;
    await ta.reset();
    await activate({});
    const m = await seedUser(ta.testDb, 'manager');
    managerId = m.id;
    manager = await sessionCookieFor(app, m.id);
    receptionist = await sessionCookieFor(app, (await seedUser(ta.testDb, 'receptionist')).id);
  });
  afterAll(async () => {
    await side.end();
    await app.close();
    await fake.close();
  });

  async function activate(licence: Record<string, unknown>): Promise<void> {
    await app.get(ActivationService).activate(fake.issueCode({ licence: { limits: { rooms: 20, users: 10 }, ...licence } }));
    await app.get(LicenceService).reload();
  }

  const server = () => app.getHttpServer();
  const post = (path: string, body: object, cookie = receptionist) =>
    request(server()).post(path).set('Cookie', cookie).send(body);
  const patch = (path: string, body: object, cookie = manager) =>
    request(server()).patch(path).set('Cookie', cookie).send(body);
  const put = (path: string, body: object, cookie = manager) =>
    request(server()).put(path).set('Cookie', cookie).send(body);
  const get = (path: string, cookie = receptionist) => request(server()).get(path).set('Cookie', cookie);

  async function createType(code: string): Promise<string> {
    const res = await post('/unit-types', { code, name: { sr: `Tip ${code}` }, capacity: 3 }, manager);
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function createUnit(name: string, unitTypeId: string | null): Promise<string> {
    const res = await post('/units', { name, unitTypeId }, manager);
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function createPlan(code = 'BAR', extra: object = {}): Promise<string> {
    const res = await post('/rate-plans', { code, name: { sr: 'Osnovna cena' }, ...extra }, manager);
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function price(plan: string, scope: Scope, from: string, to: string, priceMinor: number): Promise<void> {
    const res = await put(`/rate-plans/${plan}/days`, { scope, from, to, priceMinor });
    expect(res.status).toBe(200);
  }

  const typeScope = (id: string): Scope => ({ kind: 'unit_type', id });

  /** A type with `units` units, priced on `plan` for all of Nov 2026 to Feb 2028. */
  async function pricedType(code: string, units: number, plan: string, priceMinor = 1_000_000) {
    const typeId = await createType(code);
    const unitIds: string[] = [];
    for (let i = 1; i <= units; i++) unitIds.push(await createUnit(`${code}-${i}`, typeId));
    await price(plan, typeScope(typeId), '2026-11-01', '2028-03-01', priceMinor);
    return { typeId, unitIds, scope: typeScope(typeId) };
  }

  const holder = { firstName: 'Petar', lastName: 'Petrović', email: 'petar@example.com' };

  function stay(ratePlanId: string, target: { unitTypeId?: string; unitId?: string }, arrival: string, departure: string) {
    return { ...target, arrival, departure, adults: 2, ratePlanId };
  }

  function book(stays: object[], extra: object = {}, cookie = receptionist) {
    return post('/reservations', { source: 'front_desk', holder, stays, ...extra }, cookie);
  }

  async function ledger(scope: Scope) {
    const { rows } = await ta.testDb.pool.query<{ day: string; total: number; sold: number; blocked: number }>(
      `SELECT day::text AS day, total, sold, blocked FROM inventory_day
        WHERE scope_kind = $1 AND scope_id = $2 ORDER BY day`,
      [scope.kind, scope.id],
    );
    return rows;
  }

  const soldOf = async (scope: Scope) => (await ledger(scope)).map((d) => [d.day, d.sold]);

  async function count(table: string): Promise<number> {
    if (!/^[a-z_]+$/.test(table)) throw new Error(table);
    return (await ta.testDb.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  }

  async function audit(action: string) {
    const { rows } = await ta.testDb.pool.query(
      `SELECT entity_id, before, after, actor_user_id FROM audit_log WHERE action = $1 ORDER BY id`,
      [action],
    );
    return rows;
  }

  describe('book', () => {
    it('two stays in one reservation: sold +1 in both scopes, a price snapshot per night, audited', async () => {
      const plan = await createPlan('BAR', { discount7Pct: 10 });
      const dbl = await pricedType('DBL', 2, plan, 1_000_000);
      const sgl = await pricedType('SGL', 1, plan, 600_000);

      const res = await book([
        stay(plan, { unitTypeId: dbl.typeId }, '2027-01-10', '2027-01-12'),
        stay(plan, { unitId: sgl.unitIds[0] }, '2027-01-11', '2027-01-13'),
      ]);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ reservationId: expect.any(String), number: 'R-2027-000001' });

      expect(await soldOf(dbl.scope)).toEqual([
        ['2027-01-10', 1],
        ['2027-01-11', 1],
      ]);
      expect(await soldOf(sgl.scope)).toEqual([
        ['2027-01-11', 1],
        ['2027-01-12', 1],
      ]);

      // A later price change does not touch what was agreed.
      await price(plan, dbl.scope, '2027-01-10', '2027-01-12', 9_999_999);
      const view = await get(`/reservations/${res.body.reservationId}`);
      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({
        id: res.body.reservationId,
        number: 'R-2027-000001',
        status: 'confirmed',
        source: 'front_desk',
        version: 1,
        holder: { firstName: 'Petar', lastName: 'Petrović', email: 'petar@example.com', language: 'sr' },
        totalMinor: 3_200_000,
      });
      const stays = view.body.stays as Array<Record<string, unknown>>;
      expect(stays).toHaveLength(2);
      expect(stays[0]).toMatchObject({
        unitTypeId: dbl.typeId,
        unitId: null,
        arrival: '2027-01-10',
        departure: '2027-01-12',
        status: 'expected',
        totalMinor: 2_000_000,
        nights: [
          { day: '2027-01-10', priceMinor: 1_000_000 },
          { day: '2027-01-11', priceMinor: 1_000_000 },
        ],
      });
      // Booked by unit: the stay keeps the unit and the unit's type.
      expect(stays[1]).toMatchObject({ unitTypeId: sgl.typeId, unitId: sgl.unitIds[0], totalMinor: 1_200_000 });

      const rows = await audit('reservation.create');
      expect(rows).toHaveLength(1);
      expect(rows[0].entity_id).toBe(res.body.reservationId);
      expect(rows[0].after).toMatchObject({ number: 'R-2027-000001' });
    });

    it('the plan discount is in the snapshot: 7 nights at 10% off', async () => {
      const plan = await createPlan('BAR', { discount7Pct: 10 });
      const dbl = await pricedType('DBL', 1, plan, 1_000_000);
      const res = await book([stay(plan, { unitTypeId: dbl.typeId }, '2026-12-01', '2026-12-08')]);
      expect(res.status).toBe(201);
      const { rows } = await ta.testDb.pool.query(`SELECT DISTINCT price_minor::int AS p FROM stay_night`);
      expect(rows).toEqual([{ p: 900_000 }]);
    });

    it('a night without a price: 422 price_missing naming the day; nothing written (no sold, no number)', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 2, plan);
      const sgl = await pricedType('SGL', 1, plan);
      // SGL has no price for 2027-01-12.
      await ta.testDb.pool.query(`DELETE FROM rate_day WHERE scope_id = $1 AND day = '2027-01-12'`, [sgl.typeId]);

      const res = await book([
        stay(plan, { unitTypeId: dbl.typeId }, '2027-01-10', '2027-01-14'),
        stay(plan, { unitTypeId: sgl.typeId }, '2027-01-10', '2027-01-14'),
      ]);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'price_missing', details: { day: '2027-01-12', stay: 1 } });

      for (const scope of [dbl.scope, sgl.scope]) {
        expect((await ledger(scope)).every((d) => d.sold === 0)).toBe(true);
      }
      for (const table of ['reservation', 'stay', 'stay_night', 'guest', 'reservation_counter']) {
        expect(await count(table)).toBe(0);
      }
      expect(await audit('reservation.create')).toEqual([]);

      // The number was not used up.
      const next = await book([stay(plan, { unitTypeId: dbl.typeId }, '2027-01-10', '2027-01-12')]);
      expect(next.body.number).toBe('R-2027-000001');
    });

    it('a closed night: 422 closed naming the day', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 1, plan);
      await put(`/rate-plans/${plan}/days`, { scope: dbl.scope, from: '2026-12-03', to: '2026-12-04', closed: true });
      const res = await book([stay(plan, { unitTypeId: dbl.typeId }, '2026-12-01', '2026-12-05')]);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'closed', details: { day: '2026-12-03' } });
      expect(await count('stay')).toBe(0);
    });

    it('no unit left of the type: 409 no_availability naming the night', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 1, plan);
      expect((await book([stay(plan, { unitTypeId: dbl.typeId }, '2026-12-01', '2026-12-03')])).status).toBe(201);
      const res = await book([stay(plan, { unitTypeId: dbl.typeId }, '2026-12-02', '2026-12-04')]);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'no_availability', details: { day: '2026-12-02' } });
    });

    it('unit already taken for an overlapping stay: 409 unit_taken, even with a free unit of the type left', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 2, plan);
      const [u1] = dbl.unitIds;
      expect((await book([stay(plan, { unitId: u1 }, '2026-12-01', '2026-12-04')])).status).toBe(201);

      const res = await book([stay(plan, { unitId: u1 }, '2026-12-03', '2026-12-05')]);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('unit_taken');
      // The type still had a unit free, so only the unit's own constraint refused it; nothing
      // kept (not even the ledger row for 2026-12-04 the failed booking created).
      expect(await soldOf(dbl.scope)).toEqual([
        ['2026-12-01', 1],
        ['2026-12-02', 1],
        ['2026-12-03', 1],
      ]);
      expect(await count('reservation')).toBe(1);

      // Back to back is fine: departure day is not a night.
      expect((await book([stay(plan, { unitId: u1 }, '2026-12-04', '2026-12-06')])).status).toBe(201);
    });

    it('unit blocked over the stay: 409 unit_blocked; the other unit of the type can still be booked', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 2, plan);
      const [u1, u2] = dbl.unitIds;
      const block = await post(`/units/${u1}/blocks`, { from: '2026-12-02', to: '2026-12-03', reason: 'maintenance' }, manager);
      expect(block.status).toBe(201);

      const res = await book([stay(plan, { unitId: u1 }, '2026-12-01', '2026-12-04')]);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'unit_blocked', details: { unitId: u1 } });
      expect(await count('stay')).toBe(0);
      expect((await book([stay(plan, { unitId: u2 }, '2026-12-01', '2026-12-04')])).status).toBe(201);
    });

    it('unit and unit type that do not match, an unknown unit, an inactive unit', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 1, plan);
      const sgl = await pricedType('SGL', 2, plan);
      const mismatch = await book([stay(plan, { unitId: dbl.unitIds[0], unitTypeId: sgl.typeId }, '2026-12-01', '2026-12-02')]);
      expect(mismatch.status).toBe(422);
      expect(mismatch.body.code).toBe('unit_type_mismatch');

      const unknown = await book([stay(plan, { unitId: '00000000-0000-4000-8000-000000000000' }, '2026-12-01', '2026-12-02')]);
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('unit_not_found');

      expect((await patch(`/units/${sgl.unitIds[1]}`, { active: false })).status).toBe(200);
      const inactive = await book([stay(plan, { unitId: sgl.unitIds[1] }, '2026-12-01', '2026-12-02')]);
      expect(inactive.status).toBe(409);
      expect(inactive.body.code).toBe('unit_inactive');
    });

    // Review focus 3: the stay rules come from the reservation layer, before the
    // quote (which would otherwise answer price_missing or range errors on from/to).
    it.each([
      ['departure not after arrival', '2026-12-05', '2026-12-05', 'departure_not_after_arrival', 'departure'],
      ['arrival in the past', '2026-11-01', '2026-11-04', 'arrival_in_past', 'arrival'],
      ['366 nights', '2026-12-01', '2027-12-02', 'too_long', 'departure'],
      ['a date that does not exist', '2026-02-30', '2026-12-02', 'bad_date', 'arrival'],
    ])('%s: 422 %s on the stay field, nothing written', async (_name, arrival, departure, code, field) => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 1, plan);
      const res = await book([stay(plan, { unitTypeId: dbl.typeId }, arrival, departure)]);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code, details: { field, stay: 0 } });
      expect(await count('reservation')).toBe(0);
      expect(await count('inventory_day')).toBe(0);
    });

    it('365 nights is a valid stay', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 1, plan);
      const res = await book([stay(plan, { unitTypeId: dbl.typeId }, '2026-12-01', '2027-12-01')]);
      expect(res.status).toBe(201);
      expect(await count('stay_night')).toBe(365);
    });

    it.each([
      ['no stays', { stays: [] }, 'stays'],
      ['an unknown source', { source: 'fax' }, 'source'],
      ['a holder without a last name', { holder: { firstName: 'Ana' } }, 'holder.lastName'],
      ['externalId without a channel', { externalId: 'X-1' }, 'channel'],
    ])('%s: 422 validation_failed', async (_name, extra, field) => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 1, plan);
      const res = await book([stay(plan, { unitTypeId: dbl.typeId }, '2026-12-01', '2026-12-02')], extra);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'validation_failed', details: { field } });
    });

    it('a stay with neither unit nor type, or zero adults: 422 validation_failed', async () => {
      const plan = await createPlan();
      const none = await book([{ arrival: '2026-12-01', departure: '2026-12-02', adults: 2, ratePlanId: plan }]);
      expect(none.body).toMatchObject({ code: 'validation_failed', details: { field: 'stays[0].unitTypeId' } });
      const dbl = await pricedType('DBL', 1, plan);
      const zero = await book([{ ...stay(plan, { unitTypeId: dbl.typeId }, '2026-12-01', '2026-12-02'), adults: 0 }]);
      expect(zero.body).toMatchObject({ code: 'validation_failed', details: { field: 'stays[0].adults' } });
    });

    it('the same channel + externalId twice: one reservation, the second call returns it', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 2, plan);
      const body = [stay(plan, { unitTypeId: dbl.typeId }, '2026-12-01', '2026-12-03')];
      const ids = { source: 'website', channel: 'web', externalId: 'W-1001' };
      const first = await book(body, ids);
      const second = await book(body, ids);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
      expect(await count('reservation')).toBe(1);
      expect(await soldOf(dbl.scope)).toEqual([
        ['2026-12-01', 1],
        ['2026-12-02', 1],
      ]);
      // Another channel with the same id is a different reservation.
      const other = await book(body, { ...ids, channel: 'booking' });
      expect(other.body.reservationId).not.toBe(first.body.reservationId);
    });

    it('numbers run per year of the first stay arrival: R-2027-000001, R-2027-000002, R-2026-000001', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 3, plan);
      const n = async (arrival: string, departure: string) =>
        (await book([stay(plan, { unitTypeId: dbl.typeId }, arrival, departure)])).body.number;
      expect(await n('2027-01-05', '2027-01-06')).toBe('R-2027-000001');
      expect(await n('2027-02-05', '2027-02-06')).toBe('R-2027-000002');
      expect(await n('2026-12-30', '2027-01-02')).toBe('R-2026-000001');
    });
  });

  describe('blocks against stays', () => {
    it('a block over an existing stay of the unit: 409 unit_occupied; next to it is fine', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 2, plan);
      const [u1] = dbl.unitIds;
      expect((await book([stay(plan, { unitId: u1 }, '2026-12-01', '2026-12-04')])).status).toBe(201);

      const res = await post(`/units/${u1}/blocks`, { from: '2026-12-03', to: '2026-12-06', reason: 'maintenance' }, manager);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('unit_occupied');
      expect((await ledger(dbl.scope)).every((d) => d.blocked === 0)).toBe(true);

      const after = await post(`/units/${u1}/blocks`, { from: '2026-12-04', to: '2026-12-06', reason: 'maintenance' }, manager);
      expect(after.status).toBe(201);
    });
  });

  describe('cancel', () => {
    it('gives sold back, frees the unit for a new reservation, bumps the version and is audited', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 2, plan);
      const [u1] = dbl.unitIds;
      const booked = await book([stay(plan, { unitId: u1 }, '2026-12-01', '2026-12-03')]);
      const id = booked.body.reservationId;

      const res = await post(`/reservations/${id}/cancel`, { version: 1 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id, status: 'cancelled', version: 2 });
      expect(await soldOf(dbl.scope)).toEqual([
        ['2026-12-01', 0],
        ['2026-12-02', 0],
      ]);
      const view = await get(`/reservations/${id}`);
      expect(view.body.status).toBe('cancelled');
      expect(view.body.stays[0].status).toBe('cancelled');

      expect((await book([stay(plan, { unitId: u1 }, '2026-12-01', '2026-12-03')])).status).toBe(201);
      const rows = await audit('reservation.cancel');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entity_id: id, before: { status: 'confirmed', version: 1 }, after: { status: 'cancelled', version: 2 } });

      // Cancelling twice gives nothing back twice.
      const again = await post(`/reservations/${id}/cancel`, { version: 2 });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('reservation_not_cancellable');
    });

    it('with a stale version: 409 version_conflict, nothing changes', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 2, plan);
      const booked = await book([stay(plan, { unitTypeId: dbl.typeId }, '2026-12-01', '2026-12-03')]);
      const id = booked.body.reservationId;
      const stayId = (await get(`/reservations/${id}`)).body.stays[0].id;
      expect((await post(`/stays/${stayId}/assign-unit`, { unitId: dbl.unitIds[0], version: 1 })).status).toBe(200);

      const res = await post(`/reservations/${id}/cancel`, { version: 1 });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'version_conflict', details: { version: 2 } });
      expect((await get(`/reservations/${id}`)).body).toMatchObject({ status: 'confirmed', version: 2 });
      expect(await soldOf(dbl.scope)).toEqual([
        ['2026-12-01', 1],
        ['2026-12-02', 1],
      ]);
    });

    it('an unknown reservation: 404; a missing version: 422', async () => {
      const res = await post('/reservations/00000000-0000-4000-8000-000000000000/cancel', { version: 1 });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('reservation_not_found');
      expect((await post('/reservations/00000000-0000-4000-8000-000000000000/cancel', {})).status).toBe(422);
    });
  });

  describe('assign unit', () => {
    it('assigns a unit of the stay type without touching inventory; checks type, block, overlap, version', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 3, plan);
      const sgl = await pricedType('SGL', 1, plan);
      const [u1, u2, u3] = dbl.unitIds;
      const a = await book([stay(plan, { unitTypeId: dbl.typeId }, '2026-12-01', '2026-12-03')]);
      await book([stay(plan, { unitId: u2 }, '2026-12-02', '2026-12-04')]);
      await post(`/units/${u3}/blocks`, { from: '2026-12-01', to: '2026-12-02', reason: 'maintenance' }, manager);
      const stayId = (await get(`/reservations/${a.body.reservationId}`)).body.stays[0].id;
      const before = await ledger(dbl.scope);

      const wrongType = await post(`/stays/${stayId}/assign-unit`, { unitId: sgl.unitIds[0], version: 1 });
      expect(wrongType.status).toBe(422);
      expect(wrongType.body.code).toBe('unit_type_mismatch');
      const taken = await post(`/stays/${stayId}/assign-unit`, { unitId: u2, version: 1 });
      expect(taken.status).toBe(409);
      expect(taken.body.code).toBe('unit_taken');
      const blocked = await post(`/stays/${stayId}/assign-unit`, { unitId: u3, version: 1 });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('unit_blocked');

      const ok = await post(`/stays/${stayId}/assign-unit`, { unitId: u1, version: 1 });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ stayId, unitId: u1, version: 2 });
      expect(await ledger(dbl.scope)).toEqual(before);
      expect((await get(`/reservations/${a.body.reservationId}`)).body.stays[0].unitId).toBe(u1);

      const stale = await post(`/stays/${stayId}/assign-unit`, { unitId: u1, version: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('version_conflict');
      expect(await audit('stay.assign_unit')).toEqual([
        expect.objectContaining({ entity_id: stayId, before: expect.objectContaining({ unitId: null }), after: expect.objectContaining({ unitId: u1 }) }),
      ]);
    });

    it('a stay on a unit without a type cannot move to another unit: 422 unit_type_mismatch', async () => {
      const plan = await createPlan();
      const a1 = await createUnit('Apartman 1', null);
      const a2 = await createUnit('Apartman 2', null);
      for (const u of [a1, a2]) await price(plan, { kind: 'unit', id: u }, '2026-12-01', '2026-12-10', 500_000);
      const a = await book([stay(plan, { unitId: a1 }, '2026-12-01', '2026-12-03')]);
      expect(a.status).toBe(201);
      const stayId = (await get(`/reservations/${a.body.reservationId}`)).body.stays[0].id;
      const res = await post(`/stays/${stayId}/assign-unit`, { unitId: a2, version: 1 });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('unit_type_mismatch');
    });

    it('a cancelled stay cannot get a unit: 409 stay_not_assignable', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 1, plan);
      const a = await book([stay(plan, { unitTypeId: dbl.typeId }, '2026-12-01', '2026-12-03')]);
      const stayId = (await get(`/reservations/${a.body.reservationId}`)).body.stays[0].id;
      await post(`/reservations/${a.body.reservationId}/cancel`, { version: 1 });
      const res = await post(`/stays/${stayId}/assign-unit`, { unitId: dbl.unitIds[0], version: 2 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('stay_not_assignable');
    });
  });

  describe('unit changes against stays (Ruling 15)', () => {
    it('a unit with an assigned stay that has not ended cannot change type: 409 unit_has_stays', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 2, plan);
      const sgl = await createType('SGL');
      const [u1] = dbl.unitIds;
      const a = await book([stay(plan, { unitId: u1 }, '2026-12-01', '2026-12-03')]);

      const res = await patch(`/units/${u1}`, { unitTypeId: sgl });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'unit_has_stays', details: { stayId: expect.any(String) } });
      // A rename is not a type change.
      expect((await patch(`/units/${u1}`, { name: 'DBL-1a' })).status).toBe(200);

      await post(`/reservations/${a.body.reservationId}/cancel`, { version: 1 });
      expect((await patch(`/units/${u1}`, { unitTypeId: sgl })).status).toBe(200);
    });

    it('deactivate a unit with an assigned stay: 409 unit_has_stays, nothing changed (Ruling 20)', async () => {
      const plan = await createPlan();
      // Spare capacity in the type, so inventory alone would let the unit go.
      const dbl = await pricedType('DBL', 3, plan);
      const [u1] = dbl.unitIds;
      const a = await book([stay(plan, { unitId: u1 }, '2026-12-01', '2026-12-03')]);
      const before = await ledger(dbl.scope);

      const res = await patch(`/units/${u1}`, { active: false });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'unit_has_stays', details: { stayId: expect.any(String) } });
      const units = await get('/units', manager);
      expect(units.body.find((u: { id: string }) => u.id === u1)).toMatchObject({ active: true });
      expect(await ledger(dbl.scope)).toEqual(before);
      expect(await audit('unit.update')).toEqual([]);

      // Without the stay the unit can go out of service.
      await post(`/reservations/${a.body.reservationId}/cancel`, { version: 1 });
      expect((await patch(`/units/${u1}`, { active: false })).status).toBe(200);
    });

    it('a stay that has ended does not hold the unit', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 2, plan);
      const sgl = await createType('SGL');
      const [u1] = dbl.unitIds;
      await book([stay(plan, { unitId: u1 }, '2026-11-03', '2026-11-05')]);
      now = new Date(NOW.getTime() + 3 * DAY_MS); // today is 2026-11-05: the stay is over
      manager = await sessionCookieFor(app, managerId); // the old session idled out
      expect((await patch(`/units/${u1}`, { unitTypeId: sgl })).status).toBe(200);
    });
  });

  describe('reading', () => {
    it('lists by stay dates, status and text, and reads one reservation', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 3, plan);
      const a = await book([stay(plan, { unitTypeId: dbl.typeId }, '2026-12-01', '2026-12-03')]);
      const b = await book([stay(plan, { unitTypeId: dbl.typeId }, '2026-12-10', '2026-12-12')], {
        holder: { firstName: 'Jelena', lastName: 'Jović' },
      });
      await post(`/reservations/${b.body.reservationId}/cancel`, { version: 1 });

      const all = await get('/reservations');
      expect(all.status).toBe(200);
      expect(all.body.map((r: { number: string }) => r.number)).toEqual(['R-2026-000001', 'R-2026-000002']);
      expect(all.body[0]).toMatchObject({
        id: a.body.reservationId,
        status: 'confirmed',
        holderName: 'Petar Petrović',
        arrival: '2026-12-01',
        departure: '2026-12-03',
        stayCount: 1,
        version: 1,
      });

      const dec2 = await get('/reservations?from=2026-12-02&to=2026-12-05');
      expect(dec2.body.map((r: { id: string }) => r.id)).toEqual([a.body.reservationId]);
      // The departure day is not a night of the stay.
      expect((await get('/reservations?from=2026-12-03&to=2026-12-05')).body).toEqual([]);
      const cancelled = await get('/reservations?status=cancelled');
      expect(cancelled.body.map((r: { id: string }) => r.id)).toEqual([b.body.reservationId]);
      const byName = await get(`/reservations?q=${encodeURIComponent('jović')}`);
      expect(byName.body.map((r: { id: string }) => r.id)).toEqual([b.body.reservationId]);
      const byNumber = await get('/reservations?q=R-2026-000001');
      expect(byNumber.body.map((r: { id: string }) => r.id)).toEqual([a.body.reservationId]);

      expect((await get('/reservations?status=lost')).status).toBe(422);
      expect((await get('/reservations?from=2026-12-05&to=2026-12-01')).status).toBe(422);
      expect((await get('/reservations/00000000-0000-4000-8000-000000000000')).status).toBe(404);
      expect((await get('/reservations/nije-uuid')).status).toBe(404);
    });
  });

  describe('roles and licence', () => {
    it('housekeeping can neither book nor read reservations: 403 forbidden_role', async () => {
      const hk = await sessionCookieFor(app, (await seedUser(ta.testDb, 'housekeeping')).id);
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 1, plan);
      const res = await book([stay(plan, { unitTypeId: dbl.typeId }, '2026-12-01', '2026-12-02')], {}, hk);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden_role');
      expect((await get('/reservations', hk)).status).toBe(403);
      expect(await count('reservation')).toBe(0);
    });

    it('anonymous: 401', async () => {
      expect((await request(server()).get('/reservations')).status).toBe(401);
    });

    it('in safe mode booking, cancelling and assigning are 403 safe_mode_blocked; reading still works', async () => {
      await ta.reset();
      await activate({ expiry_mode: 'safe_mode' });
      const m = await seedUser(ta.testDb, 'manager');
      manager = await sessionCookieFor(app, m.id);
      receptionist = await sessionCookieFor(app, (await seedUser(ta.testDb, 'receptionist')).id);
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 1, plan);
      const a = await book([stay(plan, { unitTypeId: dbl.typeId }, '2026-12-01', '2026-12-02')]);
      expect(a.status).toBe(201);
      const stayId = (await get(`/reservations/${a.body.reservationId}`)).body.stays[0].id;

      // Past valid_until and grace_until on both clocks.
      now = new Date(NOW.getTime() + 400 * DAY_MS);
      licenceShiftMs = 400 * DAY_MS;
      receptionist = await sessionCookieFor(app, (await seedUser(ta.testDb, 'receptionist')).id);
      for (const res of [
        await book([stay(plan, { unitTypeId: dbl.typeId }, '2028-01-01', '2028-01-02')]),
        await post(`/reservations/${a.body.reservationId}/cancel`, { version: 1 }),
        await post(`/stays/${stayId}/assign-unit`, { unitId: dbl.unitIds[0], version: 1 }),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('safe_mode_blocked');
      }
      expect((await get('/reservations')).status).toBe(200);
      expect((await get(`/reservations/${a.body.reservationId}`)).status).toBe(200);
    });
  });

  // ---- concurrency: interleavings forced with pg_locks, not timing ----

  describe('concurrency', () => {
    const scopeKey = (s: Scope) => `${s.kind}:${s.id}`;

    /** Holds the scope's advisory lock exclusive (as recomputeTotal would) on a side connection. */
    async function holdScope(scope: Scope): Promise<{ client: PoolClient; release: () => Promise<void> }> {
      const client = await side.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [INVENTORY_SCOPE_LOCK_NS, scopeKey(scope)]);
      let released = false;
      return {
        client,
        release: async () => {
          if (released) return;
          released = true;
          await client.query('COMMIT');
          client.release();
        },
      };
    }

    /** Backends that hold (granted) or wait for (not granted) the scope's advisory lock, other than `except`. */
    async function scopeLockers(scope: Scope, granted: boolean, except: number): Promise<number[]> {
      const { rows } = await side.query<{ pid: number }>(
        `SELECT DISTINCT pid FROM pg_locks
          WHERE locktype = 'advisory' AND classid = $1::int::oid
            AND objid::bigint = (hashtext($2)::bigint & 4294967295) AND objsubid = 2
            AND granted = $3 AND pid <> $4`,
        [INVENTORY_SCOPE_LOCK_NS, scopeKey(scope), granted, except],
      );
      return rows.map((r) => r.pid);
    }

    async function waitForWaiters(scope: Scope, n: number, except: number, what: string): Promise<number[]> {
      const deadline = Date.now() + WAIT_MS;
      let pids: number[] = [];
      while (Date.now() < deadline) {
        pids = await scopeLockers(scope, false, except);
        if (pids.length >= n) return pids;
        await delay(20);
      }
      throw new Error(`${what}: expected ${n} waiting on the scope lock within ${WAIT_MS} ms, saw ${pids.length}`);
    }

    const pidOf = async (c: PoolClient) => (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;

    function settle(p: Promise<unknown>): Promise<Outcome> {
      return p.then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      );
    }

    function input(ratePlanId: string, stays: Array<{ unitTypeId: string; arrival: string; departure: string }>): BookInput {
      return {
        source: 'front_desk',
        holder: { firstName: 'Paralelni', lastName: 'Gost' },
        stays: stays.map((s) => ({ ...s, adults: 1, ratePlanId })),
      };
    }

    it('10 parallel bookings of the last unit of a type: exactly 1 succeeds, 9 get no_availability', async () => {
      const plan = await createPlan();
      const dbl = await pricedType('DBL', 2, plan);
      expect((await book([stay(plan, { unitTypeId: dbl.typeId }, '2026-12-01', '2026-12-04')])).status).toBe(201);
      await app.get(PropertyContext).id(); // cached, so each booking uses exactly one connection
      const service = app.get(ReservationsService);

      // All ten queue on the scope behind the held lock, then contend at once.
      const gate = await holdScope(dbl.scope);
      let outcomes: Outcome[];
      try {
        const runs = Array.from({ length: 10 }, () =>
          settle(service.book(input(plan, [{ unitTypeId: dbl.typeId, arrival: '2026-12-02', departure: '2026-12-03' }]), { id: managerId })),
        );
        await waitForWaiters(dbl.scope, 10, await pidOf(gate.client), 'the 10 bookings');
        await gate.release();
        outcomes = await Promise.all(runs);
      } finally {
        await gate.release();
      }

      expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
      const failed = outcomes.flatMap((o) => (o.ok ? [] : [o.error]));
      expect(failed).toHaveLength(9);
      for (const e of failed) {
        expect(e).toBeInstanceOf(DomainError);
        expect(e).toMatchObject({ code: 'no_availability', status: 409, details: { day: '2026-12-02' } });
      }
      expect(await soldOf(dbl.scope)).toEqual([
        ['2026-12-01', 1],
        ['2026-12-02', 2],
        ['2026-12-03', 1],
      ]);
      expect(await count('reservation')).toBe(2);
      // Numbers stay gapless: the losers rolled their counter back.
      const { rows } = await ta.testDb.pool.query(`SELECT number FROM reservation ORDER BY number`);
      expect(rows.map((r) => r.number)).toEqual(['R-2026-000001', 'R-2026-000002']);
    }, 20_000);

    it('a booking over two scopes locks them in scopeOrder, whatever the order of its stays', async () => {
      const plan = await createPlan();
      const t1 = await pricedType('AAA', 1, plan);
      const t2 = await pricedType('BBB', 1, plan);
      const [first, second] = [t1.scope, t2.scope].sort(scopeOrder);
      const service = app.get(ReservationsService);

      // Hold the scope that sorts second. A booking that follows scopeOrder takes
      // the first scope, then queues on the second while holding the first. One
      // that followed the order of its stays (second listed first) would queue
      // on the second holding nothing.
      const gate = await holdScope(second);
      let outcome: Outcome;
      try {
        const run = settle(
          service.book(
            input(plan, [
              { unitTypeId: second.id, arrival: '2026-12-01', departure: '2026-12-03' },
              { unitTypeId: first.id, arrival: '2026-12-01', departure: '2026-12-03' },
            ]),
            { id: managerId },
          ),
        );
        const [waiter] = await waitForWaiters(second, 1, await pidOf(gate.client), 'the two-scope booking');
        const holdersOfFirst = await scopeLockers(first, true, -1);
        expect(holdersOfFirst).toContain(waiter);
        await gate.release();
        outcome = await run;
      } finally {
        await gate.release();
      }
      expect(outcome.ok).toBe(true);
      expect(await soldOf(first)).toEqual([
        ['2026-12-01', 1],
        ['2026-12-02', 1],
      ]);
      expect(await soldOf(second)).toEqual([
        ['2026-12-01', 1],
        ['2026-12-02', 1],
      ]);
    }, 20_000);
  });
});
