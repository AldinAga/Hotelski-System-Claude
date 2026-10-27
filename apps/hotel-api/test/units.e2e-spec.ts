import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InventoryService, type Scope } from '../src/inventory/inventory.service';
import { ActivationService } from '../src/licensing/activation.service';
import { CentralAdminClient } from '../src/licensing/central-admin.client';
import { LicenceService } from '../src/licensing/licence.service';
import { parseRootKeySet } from '../src/licensing/licensing.config';
import { SecretBox } from '../src/licensing/secret-box';
import { createTestApp, type TestApp } from './app';
import { ensureProperty, seedUser, sessionCookieFor } from './auth-helpers';
import { startFakeCentralAdmin, type FakeCentralAdmin } from './fake-central-admin';

// 09:00 in Belgrade on 2 Nov 2026: "today" for the inventory is 2026-11-02.
const NOW = new Date('2026-11-02T08:00:00Z');

describe('units, unit types and blocks (e2e)', () => {
  let fake: FakeCentralAdmin;
  let ta: TestApp;
  let app: INestApplication;
  let manager: string;
  let receptionist: string;
  let now = NOW;

  beforeAll(async () => {
    fake = await startFakeCentralAdmin();
    ta = await createTestApp({
      clock: () => now,
      licensing: {
        client: new CentralAdminClient({ baseUrl: fake.url, allowHttp: true }),
        rootKeySet: parseRootKeySet(JSON.stringify(fake.rootKeySet)),
        secretBox: new SecretBox(randomBytes(32)),
      },
    });
    app = ta.app;
  });
  beforeEach(async () => {
    now = NOW;
    await ta.reset();
    await activate(20);
    manager = await sessionCookieFor(app, (await seedUser(ta.testDb, 'manager')).id);
    receptionist = await sessionCookieFor(app, (await seedUser(ta.testDb, 'receptionist')).id);
  });
  afterAll(async () => {
    await app.close();
    await fake.close();
  });

  async function activate(rooms: number): Promise<void> {
    await app.get(ActivationService).activate(fake.issueCode({ licence: { limits: { rooms, users: 10 } } }));
    await app.get(LicenceService).reload();
  }

  const server = () => app.getHttpServer();
  const post = (path: string, body: object, cookie = manager) =>
    request(server()).post(path).set('Cookie', cookie).send(body);
  const patch = (path: string, body: object, cookie = manager) =>
    request(server()).patch(path).set('Cookie', cookie).send(body);
  const get = (path: string, cookie = manager) => request(server()).get(path).set('Cookie', cookie);
  const del = (path: string, cookie = manager) => request(server()).delete(path).set('Cookie', cookie);

  async function createType(code: string): Promise<string> {
    const res = await post('/unit-types', { code, name: { sr: `Tip ${code}`, en: `Type ${code}` }, capacity: 2 });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function createUnit(name: string, unitTypeId: string | null): Promise<string> {
    const res = await post('/units', { name, unitTypeId });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  /** Locks (creating if missing) and returns the ledger rows for [from, to). */
  async function days(scope: Scope, from: string, to: string) {
    const propertyId = await ensureProperty(ta.testDb);
    return ta.testDb.db.transaction((tx) => app.get(InventoryService).lockDays(tx, propertyId, scope, from, to));
  }

  async function sell(scope: Scope, from: string, to: string): Promise<void> {
    const propertyId = await ensureProperty(ta.testDb);
    await ta.testDb.db.transaction((tx) => app.get(InventoryService).take(tx, propertyId, scope, from, to, 'sold', 1));
  }

  async function audit(action: string): Promise<Array<{ entity_id: string; before: unknown; after: unknown }>> {
    const { rows } = await ta.testDb.pool.query(
      `SELECT entity_id, before, after, actor_user_id FROM audit_log WHERE action = $1 ORDER BY id`,
      [action],
    );
    return rows;
  }

  describe('inventory totals', () => {
    it('a type with 3 active units: total = 3 for a new day', async () => {
      const type = await createType('DBL');
      for (const n of ['101', '102', '103']) await createUnit(n, type);

      expect(await days({ kind: 'unit_type', id: type }, '2026-11-10', '2026-11-11')).toEqual([
        { day: '2026-11-10', total: 3, sold: 0, blocked: 0 },
      ]);
    });

    it('a unit without a type: total = 1', async () => {
      const u = await createUnit('Apartman 1', null);
      expect(await days({ kind: 'unit', id: u }, '2026-11-10', '2026-11-11')).toEqual([
        { day: '2026-11-10', total: 1, sold: 0, blocked: 0 },
      ]);
    });
  });

  describe('deactivation', () => {
    it('when sold = total on a future day: 409 inventory_conflict with that day, the unit stays active', async () => {
      const type = await createType('DBL');
      const a = await createUnit('101', type);
      await createUnit('102', type);
      const scope: Scope = { kind: 'unit_type', id: type };
      await sell(scope, '2026-11-10', '2026-11-11');
      await sell(scope, '2026-11-10', '2026-11-11');

      const res = await patch(`/units/${a}`, { active: false });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'inventory_conflict', details: { day: '2026-11-10' } });

      const list = await get('/units');
      expect(list.body.find((u: { id: string }) => u.id === a)).toMatchObject({ active: true });
      expect(await days(scope, '2026-11-10', '2026-11-11')).toEqual([
        { day: '2026-11-10', total: 2, sold: 2, blocked: 0 },
      ]);
      expect(await audit('unit.update')).toEqual([]);
    });

    it('with room left: the unit is deactivated, total drops and the change is audited', async () => {
      const type = await createType('DBL');
      const a = await createUnit('101', type);
      await createUnit('102', type);
      const scope: Scope = { kind: 'unit_type', id: type };
      await sell(scope, '2026-11-10', '2026-11-11');

      const res = await patch(`/units/${a}`, { active: false });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: a, active: false });
      expect(await days(scope, '2026-11-10', '2026-11-11')).toEqual([
        { day: '2026-11-10', total: 1, sold: 1, blocked: 0 },
      ]);
      expect(await audit('unit.update')).toEqual([
        expect.objectContaining({ entity_id: a, before: expect.objectContaining({ active: true }), after: expect.objectContaining({ active: false }) }),
      ]);
    });
  });

  describe('type change', () => {
    it('moves total from the old type to the new one', async () => {
      const a = await createType('DBL');
      const b = await createType('SGL');
      const u = await createUnit('101', a);
      await createUnit('102', a);
      await createUnit('201', b);
      await days({ kind: 'unit_type', id: a }, '2026-11-10', '2026-11-11');
      await days({ kind: 'unit_type', id: b }, '2026-11-10', '2026-11-11');

      const res = await patch(`/units/${u}`, { unitTypeId: b });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ unitTypeId: b });

      expect((await days({ kind: 'unit_type', id: a }, '2026-11-10', '2026-11-11'))[0].total).toBe(1);
      expect((await days({ kind: 'unit_type', id: b }, '2026-11-10', '2026-11-11'))[0].total).toBe(2);
    });

    it('an untyped unit given a type leaves its own scope (total 0) and joins the type', async () => {
      const type = await createType('DBL');
      const u = await createUnit('Apartman', null);
      await days({ kind: 'unit', id: u }, '2026-11-10', '2026-11-11');
      await days({ kind: 'unit_type', id: type }, '2026-11-10', '2026-11-11');

      expect((await patch(`/units/${u}`, { unitTypeId: type })).status).toBe(200);
      expect((await days({ kind: 'unit', id: u }, '2026-11-10', '2026-11-11'))[0].total).toBe(0);
      expect((await days({ kind: 'unit_type', id: type }, '2026-11-10', '2026-11-11'))[0].total).toBe(1);
    });

    it('when the old type has no room to give: 409 inventory_conflict and nothing moves', async () => {
      const a = await createType('DBL');
      const b = await createType('SGL');
      const u = await createUnit('101', a);
      await sell({ kind: 'unit_type', id: a }, '2026-11-12', '2026-11-13');

      const res = await patch(`/units/${u}`, { unitTypeId: b });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'inventory_conflict', details: { day: '2026-11-12' } });
      expect((await get('/units')).body[0]).toMatchObject({ unitTypeId: a });
    });
  });

  describe('blocks', () => {
    it('a block raises blocked; an overlapping block on the same unit: 409 block_overlap', async () => {
      const type = await createType('DBL');
      const u = await createUnit('101', type);
      await createUnit('102', type);
      const scope: Scope = { kind: 'unit_type', id: type };

      const first = await post(`/units/${u}/blocks`, { from: '2026-11-10', to: '2026-11-12', reason: 'maintenance' });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ unitId: u, from: '2026-11-10', to: '2026-11-12', reason: 'maintenance' });
      expect(await days(scope, '2026-11-09', '2026-11-13')).toEqual([
        { day: '2026-11-09', total: 2, sold: 0, blocked: 0 },
        { day: '2026-11-10', total: 2, sold: 0, blocked: 1 },
        { day: '2026-11-11', total: 2, sold: 0, blocked: 1 },
        { day: '2026-11-12', total: 2, sold: 0, blocked: 0 },
      ]);

      const overlap = await post(`/units/${u}/blocks`, { from: '2026-11-11', to: '2026-11-14', reason: 'other' });
      expect(overlap.status).toBe(409);
      expect(overlap.body.code).toBe('block_overlap');
      expect((await days(scope, '2026-11-11', '2026-11-14')).map((d) => d.blocked)).toEqual([1, 0, 0]);
      expect(await audit('unit_block.create')).toHaveLength(1);
    });

    it('overlap on an untyped unit is still block_overlap (not no_availability)', async () => {
      const u = await createUnit('Apartman', null);
      expect((await post(`/units/${u}/blocks`, { from: '2026-11-10', to: '2026-11-12', reason: 'owner_use' })).status).toBe(201);
      const overlap = await post(`/units/${u}/blocks`, { from: '2026-11-11', to: '2026-11-12', reason: 'other' });
      expect(overlap.status).toBe(409);
      expect(overlap.body.code).toBe('block_overlap');
    });

    it('a block on a sold-out night: 409 no_availability with that day, no block stored', async () => {
      const u = await createUnit('Apartman', null);
      await sell({ kind: 'unit', id: u }, '2026-11-11', '2026-11-12');
      const res = await post(`/units/${u}/blocks`, { from: '2026-11-10', to: '2026-11-12', reason: 'maintenance' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'no_availability', details: { day: '2026-11-11' } });
      expect((await ta.testDb.pool.query('SELECT 1 FROM unit_block')).rowCount).toBe(0);
    });

    it('deleting a running block gives back only the nights from today on', async () => {
      const u = await createUnit('Apartman', null);
      const block = await post(`/units/${u}/blocks`, { from: '2026-11-02', to: '2026-11-05', reason: 'maintenance' });
      expect(block.status).toBe(201);

      now = new Date('2026-11-04T08:00:00Z'); // 4 Nov in Belgrade: 2 and 3 Nov are history
      manager = await sessionCookieFor(app, (await seedUser(ta.testDb, 'manager')).id);
      expect((await del(`/units/${u}/blocks/${block.body.id}`)).status).toBe(204);

      expect((await days({ kind: 'unit', id: u }, '2026-11-02', '2026-11-05')).map((d) => [d.day, d.blocked])).toEqual([
        ['2026-11-02', 1],
        ['2026-11-03', 1],
        ['2026-11-04', 0],
      ]);
    });

    it('deleting a block gives the nights back and is audited', async () => {
      const u = await createUnit('Apartman', null);
      const block = await post(`/units/${u}/blocks`, { from: '2026-11-10', to: '2026-11-12', reason: 'maintenance', note: 'Krečenje' });
      const res = await del(`/units/${u}/blocks/${block.body.id}`);
      expect(res.status).toBe(204);
      expect((await days({ kind: 'unit', id: u }, '2026-11-10', '2026-11-12')).map((d) => d.blocked)).toEqual([0, 0]);
      expect(await audit('unit_block.delete')).toEqual([expect.objectContaining({ entity_id: block.body.id })]);
      expect((await del(`/units/${u}/blocks/${block.body.id}`)).status).toBe(404);
    });

    it('refuses a block that starts before today, or a reversed range: 422', async () => {
      const u = await createUnit('Apartman', null);
      const past = await post(`/units/${u}/blocks`, { from: '2026-11-01', to: '2026-11-03', reason: 'maintenance' });
      expect(past.status).toBe(422);
      expect(past.body.details).toEqual({ field: 'from' });
      const reversed = await post(`/units/${u}/blocks`, { from: '2026-11-05', to: '2026-11-05', reason: 'maintenance' });
      expect(reversed.status).toBe(422);
      expect(reversed.body.details).toEqual({ field: 'to' });
    });

    it('a unit with a block that is not over cannot change type or be deactivated: 409 unit_has_blocks', async () => {
      const type = await createType('DBL');
      const u = await createUnit('Apartman', null);
      await post(`/units/${u}/blocks`, { from: '2026-11-10', to: '2026-11-12', reason: 'maintenance' });
      expect((await patch(`/units/${u}`, { unitTypeId: type })).body.code).toBe('unit_has_blocks');
      expect((await patch(`/units/${u}`, { active: false })).body.code).toBe('unit_has_blocks');
      // A rename does not touch the inventory and is allowed.
      expect((await patch(`/units/${u}`, { name: 'Apartman A' })).status).toBe(200);
    });

    it('only owner and manager manage blocks', async () => {
      const u = await createUnit('Apartman', null);
      const res = await post(`/units/${u}/blocks`, { from: '2026-11-10', to: '2026-11-12', reason: 'maintenance' }, receptionist);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden_role');
    });
  });

  describe('licence limit rooms', () => {
    it('a fourth unit with rooms = 3: 403 limit_exceeded', async () => {
      await ta.reset();
      await activate(3);
      manager = await sessionCookieFor(app, (await seedUser(ta.testDb, 'manager')).id);
      for (const n of ['1', '2', '3']) await createUnit(n, null);

      const res = await post('/units', { name: '4' });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'limit_exceeded', details: { key: 'rooms', limit: 3, wanted: 4 } });
      expect((await get('/units')).body).toHaveLength(3);
    });

    it('reactivating a unit counts against the limit too', async () => {
      await ta.reset();
      await activate(3);
      manager = await sessionCookieFor(app, (await seedUser(ta.testDb, 'manager')).id);
      const first = await createUnit('1', null);
      expect((await patch(`/units/${first}`, { active: false })).status).toBe(200);
      for (const n of ['2', '3', '4']) await createUnit(n, null);

      const res = await patch(`/units/${first}`, { active: true });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'limit_exceeded', details: { key: 'rooms', limit: 3, wanted: 4 } });
    });
  });

  describe('unit types and units API', () => {
    it('creates, lists and updates a unit type; audits each change', async () => {
      const created = await post('/unit-types', {
        code: 'DBL',
        name: { sr: 'Dvokrevetna', en: 'Double' },
        capacity: 2,
        beds: '1 bračni',
        description: { sr: 'Pogled na more' },
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ code: 'DBL', name: { sr: 'Dvokrevetna', en: 'Double' }, capacity: 2, active: true });

      const updated = await patch(`/unit-types/${created.body.id}`, { capacity: 3 });
      expect(updated.status).toBe(200);
      expect(updated.body.capacity).toBe(3);
      expect((await get('/unit-types', receptionist)).body).toEqual([updated.body]);
      expect(await audit('unit_type.create')).toHaveLength(1);
      expect(await audit('unit_type.update')).toHaveLength(1);
    });

    it('a unit type name needs a non-empty sr: 422 validation_failed name', async () => {
      for (const name of [{ en: 'Double' }, { sr: '  ' }, 'Dvokrevetna', null]) {
        const res = await post('/unit-types', { code: 'DBL', name, capacity: 2 });
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ code: 'validation_failed', details: { field: 'name' } });
      }
    });

    it('duplicate codes and unit names: 409', async () => {
      await createType('DBL');
      expect((await post('/unit-types', { code: 'DBL', name: { sr: 'X' }, capacity: 1 })).body.code).toBe('unit_type_code_taken');
      await createUnit('101', null);
      expect((await post('/units', { name: '101' })).body.code).toBe('unit_name_taken');
    });

    it('a unit with an unknown type: 404 unit_type_not_found', async () => {
      const res = await post('/units', { name: '101', unitTypeId: '00000000-0000-4000-8000-000000000000' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('unit_type_not_found');
    });

    it('a type with active units cannot be deactivated: 409 unit_type_in_use', async () => {
      const type = await createType('DBL');
      await createUnit('101', type);
      const res = await patch(`/unit-types/${type}`, { active: false });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('unit_type_in_use');
    });

    it('receptionist can view but not manage units', async () => {
      await createUnit('101', null);
      expect((await get('/units', receptionist)).status).toBe(200);
      const res = await post('/units', { name: '102' }, receptionist);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden_role');
    });

    it('unit creation is audited with the actor', async () => {
      const id = await createUnit('101', null);
      const rows = await audit('unit.create');
      expect(rows).toEqual([expect.objectContaining({ entity_id: id, after: expect.objectContaining({ name: '101' }) })]);
    });
  });
});
